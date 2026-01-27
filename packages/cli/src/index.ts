#!/usr/bin/env node
// packages/cli/src/index.ts
//
// Single-user CLI ("me" mode):
// - Loads ONE wallet from ./wallet.json (or BCH_STEALTH_WALLET / --wallet)
// - Stores state at ./state.json by default (or --state-file)
// - No Alice/Bob actors, no pool run demo choreography.
//
// Pool namespace (wired to existing ops):
//   - bchctl pool init --shards N [--fresh]
//   - bchctl pool import <txid:vout> [...]
//   - bchctl pool withdraw <dest> <sats> [--shard i] [--require-shard] [--fresh]
//
// Wallet namespace (stubs, stable command tree):
//   - bchctl wallet init (TODO)
//   - bchctl addr

import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { registerProfileCommands } from './profile/commands.js';

import {
  FileBackedPoolStateStore,
  type PoolState,
  migrateLegacyPoolStateDirSync,
  POOL_STATE_STORE_KEY,
} from '@bch-stealth/pool-state';

import * as PoolHashFold from '@bch-stealth/pool-hash-fold';
import * as Electrum from '@bch-stealth/electrum';

import { bytesToHex, sha256, ensureEvenYPriv } from '@bch-stealth/utils';

import { NETWORK, DUST } from './config.js';
import { readConfig, writeConfig, ensureConfigDefaults, upsertProfile } from './config_store.js';
import {
  getWalletFromConfig,
  getWallet,
  generateMnemonicV1,
  walletJsonFromMnemonic,
  type LoadedWallet,
} from './wallets.js';
import { generatePaycode } from './paycodes.js';

import { makeChainIO } from './pool/io.js';
import { loadStateOrEmpty, saveState } from './pool/state.js';

import type { PoolOpContext } from './pool/context.js';

import { registerPoolCommands } from './commands/pool.js';
import { runInit } from './pool/ops/init.js';
import { runImport } from './pool/ops/import.js';
import { runWithdraw } from './pool/ops/withdraw.js';
import { resolveProfilePaths } from './paths.js';
import { registerWalletCommands } from './commands/wallet.js';
import { registerAddrCommand } from './commands/addr.js';

// -------------------------------------------------------------------------------------
// pool-hash-fold namespace
// -------------------------------------------------------------------------------------
const { POOL_HASH_FOLD_VERSION } = PoolHashFold as any;

// -------------------------------------------------------------------------------------
// Namespace imports (avoid TS2305 until package exports are stabilized)
// -------------------------------------------------------------------------------------
const { getUtxos } = Electrum as any;

// -------------------------------------------------------------------------------------
// Defaults
// -------------------------------------------------------------------------------------
const SHARD_VALUE = 2_000n;
const DEFAULT_FEE = 2_000n;

function defaultStateFileFromCwd(): string {
  // Keeping it adjacent to wallet.json is fine for chipnet/dev.
  return path.resolve(process.cwd(), 'state.json');
}

function resolveStateFileFlag(): string {
  const raw = String(program?.opts?.()?.stateFile ?? '').trim();
  return raw || defaultStateFileFromCwd();
}

// -------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------
const program = new Command();

program
  .name('bchctl')
  .description('bchctl control plane (single-user)')
  .option('--profile <name>', 'profile name (default: "default")', 'default')
  .option('--pool-version <ver>', 'pool hash-fold version: v1 or v1_1', 'v1_1')
  .option('--wallet <path>', 'wallet.json path (default: profile wallet.json or BCH_STEALTH_WALLET)')
  .option('--state-file <path>', 'state file path (default: profile state.json)')
  .option('--log-file <path>', 'events log path (default: profile events.ndjson)');

function resolvePoolVersionFlag(): any {
  return program.opts().poolVersion === 'v1' ? POOL_HASH_FOLD_VERSION.V1 : POOL_HASH_FOLD_VERSION.V1_1;
}

function assertChipnet(): void {
  if ((NETWORK ?? '').toLowerCase() !== 'chipnet') {
    throw new Error(`This demo targets CHIPNET only. Current NETWORK=${NETWORK}`);
  }
}

// -------------------------------------------------------------------------------------
// Store helpers
// -------------------------------------------------------------------------------------
function ensureParentDir(filename: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
}

function getActivePaths() {
  const opts = program?.opts?.() ?? {};

  return resolveProfilePaths({
    cwd: process.cwd(),
    profile: String(opts.profile ?? 'default'),
    walletOverride: typeof opts.wallet === 'string' && opts.wallet.trim() ? String(opts.wallet).trim() : null,
    stateOverride: typeof opts.stateFile === 'string' && opts.stateFile.trim() ? String(opts.stateFile).trim() : null,
    logOverride: typeof opts.logFile === 'string' && opts.logFile.trim() ? String(opts.logFile).trim() : null,
    envWalletPath: process.env.BCH_STEALTH_WALLET ? String(process.env.BCH_STEALTH_WALLET) : null,
  });
}

function makeStore(): FileBackedPoolStateStore {
  const { stateFile } = getActivePaths();
  const filename = path.resolve(stateFile);

  migrateLegacyPoolStateDirSync({
    repoRoot: process.cwd(),
    optedStateFile: filename,
  });

  ensureParentDir(filename);
  return new FileBackedPoolStateStore({ filename });
}

async function readState(store: FileBackedPoolStateStore): Promise<PoolState> {
  return await loadStateOrEmpty({ store, networkDefault: NETWORK });
}

async function writeState(store: FileBackedPoolStateStore, state: PoolState): Promise<void> {
  await saveState({ store, state, networkDefault: NETWORK });
}

// -------------------------------------------------------------------------------------
// Wallet helpers (single-user)
// -------------------------------------------------------------------------------------
function errToString(e: unknown): string {
  if (e instanceof Error) return e.stack || e.message;
  try {
    return String(e);
  } catch {
    return '[unknown error]';
  }
}

async function loadMeWallet(): Promise<LoadedWallet> {
  const { walletFile, configFile, profile } = getActivePaths();

  // 1) Prefer config.json (canonical kubeconfig-style store)
  const fromCfg = getWalletFromConfig({ configFile, profile });
  if (fromCfg) return fromCfg;

  // 2) Fallback to wallet file ONLY if explicitly overridden
  const walletOptRaw = String(program?.opts?.()?.wallet ?? '').trim();
  const envWallet = String(process.env.BCH_STEALTH_WALLET ?? '').trim();
  const hasWalletOverride = !!walletOptRaw || !!envWallet;

  if (hasWalletOverride) {
    try {
      return await getWallet({ walletFile });
    } catch (e) {
      throw new Error(
        `[wallets] wallet not found in ${process.cwd()}\n` +
          `Create one with: bchctl wallet init\n` +
          `Tried wallet path: ${walletFile}\n` +
          `Tried config: ${configFile} (profile=${profile})\n` +
          `Inner: ${errToString(e)}`
      );
    }
  }

  // 3) No config wallet and no file override -> clean instruction
  throw new Error(
    `[wallets] no wallet configured for profile "${profile}"\n` +
      `Run: bchctl --profile ${profile} wallet init\n` +
      `Config: ${configFile}`
  );
}

function printFundingHelpForMe(me: LoadedWallet) {
  console.log(`\n[funding] Network: ${NETWORK}`);
  console.log(`[funding] Fund this base P2PKH address if you see "No funding UTXO available":`);
  console.log(`  - me (base P2PKH): ${me.address}`);
  console.log(`\n[funding] Notes:`);
  console.log(`  - Change may go to stealth (paycode-derived) P2PKH outputs.`);
  console.log(`  - External wallets won’t track those outputs.`);
  console.log(`  - The CLI can spend them IF they are recorded in the state file (stealthUtxos).`);
  console.log(`  - Keep reusing the same state file between runs.`);
}

// -------------------------------------------------------------------------------------
// Context builder (single-user)
// -------------------------------------------------------------------------------------
async function makePoolCtx(): Promise<PoolOpContext> {
  const store = makeStore();

  const electrum: any = Electrum as any;
  const chainIO = makeChainIO({ network: NETWORK, electrum });

  const me = await loadMeWallet();
  const mePaycode = generatePaycode(me.privBytes);

  printFundingHelpForMe(me);

  return {
    network: NETWORK,
    store,
    chainIO,
    getUtxos,
    poolVersion: resolvePoolVersionFlag(),
    config: {
      DUST,
      DEFAULT_FEE,
      SHARD_VALUE,
    },
    me: {
      wallet: me,
      paycode: mePaycode,
      // In your current wiring, paycodePub33 is just the base pubkey33; ok for now.
      paycodePub33: me.pubBytes,
    },
  } as any;
}


registerProfileCommands(program, { getActivePaths });

registerWalletCommands(program, { getActivePaths });

registerAddrCommand(program, { getActivePaths, loadMeWallet });

// -------------------------------------------------------------------------------------
// Pool namespace
// -------------------------------------------------------------------------------------
registerPoolCommands(program, {
  assertChipnet,
  makePoolCtx,
  getActivePaths,
});

// -------------------------------------------------------------------------------------
// Entrypoint
// -------------------------------------------------------------------------------------
(async () => {
  await program.parseAsync(process.argv);
})().catch((err) => {
  console.error('❌', err?.stack || err?.message || err);
  process.exitCode = 1;
});