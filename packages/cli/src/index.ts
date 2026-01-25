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

import {
  FileBackedPoolStateStore,
  type PoolState,
  migrateLegacyPoolStateDirSync,
  POOL_STATE_STORE_KEY,
} from '@bch-stealth/pool-state';

import * as PoolHashFold from '@bch-stealth/pool-hash-fold';
import * as Electrum from '@bch-stealth/electrum';

import { bytesToHex } from '@bch-stealth/utils';

import { NETWORK, DUST } from './config.js';
import { getWallet, resolveDefaultWalletPath, type LoadedWallet } from './wallets.js';
import { generatePaycode } from './paycodes.js';

import { makeChainIO } from './pool/io.js';
import { loadStateOrEmpty, saveState } from './pool/state.js';

import type { PoolOpContext } from './pool/context.js';

import { runInit } from './pool/ops/init.js';
import { runImport } from './pool/ops/import.js';
import { runWithdraw } from './pool/ops/withdraw.js';

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

// -------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------
const program = new Command();

program
  .name('bchctl')
  .description('bch-stealth control plane (single-user)')
  .option('--pool-version <ver>', 'pool hash-fold version: v1 or v1_1', 'v1_1')
  .option(
    '--wallet <path>',
    'wallet.json path (default: ./wallet.json or BCH_STEALTH_WALLET)',
    resolveDefaultWalletPath()
  )
  .option('--state-file <path>', 'state file path (default: ./state.json)', defaultStateFileFromCwd());

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

function makeStore(): FileBackedPoolStateStore {
  const opted = (program?.opts?.()?.stateFile as string | undefined) ?? null;
  const filename = path.resolve(opted ?? defaultStateFileFromCwd());

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
async function loadMeWallet(): Promise<LoadedWallet> {
  const walletPath = String(program?.opts?.()?.wallet ?? '').trim();
  return await getWallet({ walletFile: walletPath || undefined });
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

// -------------------------------------------------------------------------------------
// Wallet namespace (stubs where implementation is not yet migrated)
// -------------------------------------------------------------------------------------
const wallet = program.command('wallet').description('Wallet commands (single-user)');

wallet
  .command('init')
  .description('Create wallet.json (+ optional state.json). (TODO)')
  .action(async () => {
    throw new Error('wallet init not implemented yet in this refactor. (Next ticket: bchctl-wallet-init)');
  });

program
  .command('addr')
  .description('Print my base address and paycode.')
  .action(async () => {
    const me = await loadMeWallet();
    const paycode = generatePaycode(me.privBytes);
    console.log(`base (P2PKH): ${me.address}`);
    console.log(`paycode:      ${paycode}`);
    console.log(`pubkey33:     ${bytesToHex(me.pubBytes)}`);
  });

// -------------------------------------------------------------------------------------
// Pool namespace
// -------------------------------------------------------------------------------------
const pool = program.command('pool').description('Pool (optional vault/policy layer)');

// pool init
pool
  .command('init')
  .option('--shards <n>', 'number of shards', '8')
  .option('--fresh', 'force a new init (creates new shards)', false)
  .action(async (opts) => {
    assertChipnet();

    const shards = Number(opts.shards);
    if (!Number.isFinite(shards) || shards < 2) throw new Error('shards must be >= 2');

    const ctx = await makePoolCtx();
    const res = await runInit(ctx, { shards, fresh: !!opts.fresh });

    console.log(`✅ init txid: ${res.txid ?? res.state?.txid ?? '<unknown>'}`);
    console.log(`   shards: ${shards}`);
    console.log(`   fresh: ${!!opts.fresh}`);
    console.log(`   state saved: ${String(program.opts().stateFile ?? defaultStateFileFromCwd())} (${POOL_STATE_STORE_KEY})`);
  });

// pool import
pool
  .command('import')
  .description('Import a deposit UTXO into the pool.')
  .argument('<outpoint>', 'deposit outpoint as txid:vout')
  .option('--shard <i>', 'shard index (default: derived)', '')
  .option('--fresh', 'force a new import even if already marked imported', false)
  .option(
    '--allow-base',
    'ALLOW importing a non-RPA base P2PKH deposit (requires BCH_STEALTH_ALLOW_BASE_IMPORT=1).',
    false
  )
  .option('--deposit-wif <wif>', 'WIF for base P2PKH deposit key (optional).', '')
  .option('--deposit-privhex <hex>', 'Hex private key for base P2PKH deposit key (optional).', '')
  .action(async (outpoint, opts) => {
    assertChipnet();

    const [txidRaw, voutRaw] = String(outpoint).split(':');
    const depositTxid = String(txidRaw ?? '').trim();
    const depositVout = Number(String(voutRaw ?? '0').trim());

    if (!/^[0-9a-fA-F]{64}$/.test(depositTxid)) {
      throw new Error(`invalid outpoint txid (expected 64-hex): ${outpoint}`);
    }
    if (!Number.isFinite(depositVout) || depositVout < 0) {
      throw new Error(`invalid outpoint vout: ${outpoint}`);
    }

    const shardIndexOpt: number | null = opts.shard === '' ? null : Number(opts.shard);
    if (opts.shard !== '' && !Number.isFinite(shardIndexOpt)) throw new Error(`invalid --shard: ${String(opts.shard)}`);

    const ctx = await makePoolCtx();

    const res = await runImport(ctx, {
      shardIndex: shardIndexOpt,
      fresh: !!opts.fresh,
      allowBase: !!opts.allowBase,
      depositWif: typeof opts.depositWif === 'string' && opts.depositWif.trim() ? String(opts.depositWif).trim() : null,
      depositPrivHex:
        typeof opts.depositPrivhex === 'string' && opts.depositPrivhex.trim()
          ? String(opts.depositPrivhex).trim()
          : null,
      depositTxid,
      depositVout,
    });

    if (!res) {
      console.log('ℹ no import performed (no matching deposit found / already imported).');
      return;
    }

    console.log(`✅ import txid: ${res.txid}`);
    console.log(`   shard: ${res.shardIndex}`);
    console.log(`   state saved: ${String(program.opts().stateFile ?? defaultStateFileFromCwd())} (${POOL_STATE_STORE_KEY})`);
  });

// pool withdraw (FIXED: pass dest + sats to runWithdraw)
pool
  .command('withdraw')
  .description('Withdraw from pool to a destination (paycode or cashaddr).')
  .argument('<dest>', 'destination: paycode (PM...) or cashaddr')
  .argument('<sats>', 'amount in sats')
  .option('--shard <i>', 'shard index (default: auto)')
  .option('--require-shard', 'fail if --shard not provided (no auto selection)', false)
  .option('--fresh', 'force a new withdrawal even if already recorded', false)
  .action(async (dest, sats, opts) => {
    assertChipnet();

    const amountSats = Number(sats);
    if (!Number.isFinite(amountSats) || amountSats < Number(DUST)) {
      throw new Error(`amount must be >= dust (${DUST})`);
    }

    const shardIndex = opts.shard == null ? undefined : Number(opts.shard);
    if (shardIndex != null && (!Number.isFinite(shardIndex) || shardIndex < 0)) {
      throw new Error(`invalid --shard: ${String(opts.shard)}`);
    }

    const ctx = await makePoolCtx();
    const res = await runWithdraw(ctx, {
      dest: String(dest),
      shardIndex,
      amountSats,
      fresh: !!opts.fresh,
      requireShard: !!opts.requireShard,
    });

    console.log(`✅ withdraw txid: ${res.txid}`);
    console.log(`   state saved: ${String(program.opts().stateFile ?? defaultStateFileFromCwd())} (${POOL_STATE_STORE_KEY})`);
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