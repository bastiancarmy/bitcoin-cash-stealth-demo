#!/usr/bin/env node
// packages/cli/src/index.ts

import fs from 'node:fs';
import path from 'node:path';

import { Command } from 'commander';

import { FileBackedPoolStateStore, type PoolState } from '@bch-stealth/pool-state';
import * as PoolHashFold from '@bch-stealth/pool-hash-fold';
import * as Electrum from '@bch-stealth/electrum';

import { NETWORK, DUST } from './config.js';
import { ensureConfigDefaults, readConfig } from './config_store.js';

import { getWalletFromConfig, getWallet, type LoadedWallet } from './wallets.js';
import { generatePaycode } from './paycodes.js';

import { makeChainIO } from './pool/io.js';
import { loadStateOrEmpty, saveState } from './pool/state.js';
import type { PoolOpContext } from './pool/context.js';

import { resolveProfilePaths } from './paths.js';

import { registerProfileCommands } from './profile/commands.js';
import { registerWalletCommands } from './commands/wallet.js';
import { registerAddrCommand } from './commands/addr.js';
import { registerGetCommands } from './commands/get.js';
import { registerStatusCommand } from './commands/status.js';
import { registerSendCommand } from './commands/send.js';
import { registerScanCommand } from './commands/scan.js';
import { registerPoolCommands } from './commands/pool.js';

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
// Pool defaults (Phase 2 usability):
// - Shards must be large enough to support fee-from-shard withdrawals.
// - With DEFAULT_FEE=2000, SHARD_VALUE=100_000 allows practical demo withdrawals.
const SHARD_VALUE = 100_000n;
const DEFAULT_FEE = 2_000n;

// -------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------
const program = new Command();

program
  .name('bchctl')
  .description('bchctl control plane (single-user)')
  .option('--profile <name>', 'profile name (default: config.currentProfile, else "default")', '')
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

/**
 * Active paths resolution:
 * - If --profile is set, use it.
 * - Else use config.currentProfile (defaulting to "default").
 * - state/log paths follow the resolved profile unless overridden by flags.
 */
function getActivePaths(): {
  configFile: string;
  profile: string;
  stateFile: string;
  logFile: string;
  walletFile: string;
} {
  const opts = program?.opts?.() ?? {};

  // First resolve paths enough to discover configFile.
  const cliProfileRaw = String(opts.profile ?? '').trim();
  const seedProfile = cliProfileRaw || 'default';

  const seed = resolveProfilePaths({
    cwd: process.cwd(),
    profile: seedProfile,
    walletOverride: typeof opts.wallet === 'string' && opts.wallet.trim() ? String(opts.wallet).trim() : null,
    stateOverride: typeof opts.stateFile === 'string' && opts.stateFile.trim() ? String(opts.stateFile).trim() : null,
    logOverride: typeof opts.logFile === 'string' && opts.logFile.trim() ? String(opts.logFile).trim() : null,
    envWalletPath: process.env.BCH_STEALTH_WALLET ? String(process.env.BCH_STEALTH_WALLET) : null,
  });

  const cfg0 = ensureConfigDefaults(readConfig({ configFile: seed.configFile }) ?? null);
  const resolvedProfile = cliProfileRaw || String(cfg0.currentProfile ?? 'default');

  // Second pass: resolve final state/log/wallet paths from resolved profile.
  return resolveProfilePaths({
    cwd: process.cwd(),
    profile: resolvedProfile,
    walletOverride: typeof opts.wallet === 'string' && opts.wallet.trim() ? String(opts.wallet).trim() : null,
    stateOverride: typeof opts.stateFile === 'string' && opts.stateFile.trim() ? String(opts.stateFile).trim() : null,
    logOverride: typeof opts.logFile === 'string' && opts.logFile.trim() ? String(opts.logFile).trim() : null,
    envWalletPath: process.env.BCH_STEALTH_WALLET ? String(process.env.BCH_STEALTH_WALLET) : null,
  });
}

function makeStore(): FileBackedPoolStateStore {
  const { stateFile } = getActivePaths();
  const filename = path.resolve(stateFile);

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

  // 1) Prefer config.json (canonical store)
  const fromCfg = getWalletFromConfig({ configFile, profile });
  if (fromCfg) return fromCfg;

  // 2) Fallback to wallet file ONLY if explicitly overridden (flag or env)
  const walletOptRaw = String(program?.opts?.()?.wallet ?? '').trim();
  const envWallet = String(process.env.BCH_STEALTH_WALLET ?? '').trim();
  const hasWalletOverride = !!walletOptRaw || !!envWallet;

  if (hasWalletOverride) {
    try {
      return await getWallet({ walletFile });
    } catch (e) {
      throw new Error(
        `[wallets] wallet not found\n` +
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
      `Run: bchctl wallet init\n` +
      `Config: ${configFile}`
  );
}

// -------------------------------------------------------------------------------------
// Context builder (active-profile aware)
// -------------------------------------------------------------------------------------
async function makePoolCtx(): Promise<PoolOpContext> {
  const store = makeStore();

  const electrum: any = Electrum as any;
  const chainIO = makeChainIO({ network: NETWORK, electrum });

  const { profile } = getActivePaths();

  const me = await loadMeWallet();
  const mePaycode = generatePaycode(me.privBytes);

  console.log(`\n[funding] Network: ${NETWORK}`);
  console.log(`[funding] Fund this base P2PKH address if you see "No funding UTXO available":`);
  console.log(`  - ${profile} (base P2PKH): ${me.address}`);
  console.log(`\n[funding] Notes:`);
  console.log(`  - Change may go to stealth (paycode-derived) P2PKH outputs.`);
  console.log(`  - External wallets won’t track those outputs.`);
  console.log(`  - The CLI can spend them IF they are recorded in the state file (stealthUtxos).`);
  console.log(`  - Keep reusing the same state file between runs.`);

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
    profile,
    me: {
      wallet: me,
      paycode: mePaycode,
      paycodePub33: me.pubBytes,
    },
  } as any;
}

// -------------------------------------------------------------------------------------
// Command registration
// -------------------------------------------------------------------------------------
registerProfileCommands(program, { getActivePaths });

// UPDATED: pass network so wallet utxos can query Electrum
registerWalletCommands(program, { getActivePaths, network: NETWORK });

registerGetCommands(program, { getActivePaths });
registerStatusCommand(program, { getActivePaths });
registerAddrCommand(program, { getActivePaths, loadMeWallet });

registerSendCommand(program, {
  loadMeWallet,
  getActivePaths,
  getUtxos,
});

// Keep existing wrapper (fine). scan.ts now also checks commander globals.
registerScanCommand(program, {
  loadMeWallet,
  getActivePaths: () => {
    const p = getActivePaths();
    return { profile: p.profile, stateFile: p.stateFile };
  },
});

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