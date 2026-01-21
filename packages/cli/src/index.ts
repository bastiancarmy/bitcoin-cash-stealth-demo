#!/usr/bin/env node
// packages/cli/src/index.ts
/**
 * Sharded per-user pool demo (Phase 2.5 scaffolding)
 * -------------------------------------------------
 * Target: CHIPNET (BCH2026 features assumed)
 *
 * What this demonstrates *today*:
 *   1) Creating a per-user set of N "shards" (state anchors) as CashTokens
 *      mutable NFTs locked to the Pool Hash-Fold state-cell covenant.
 *   2) "Deposit" as a normal P2PKH output to a paycode-derived RPA stealth address.
 *   3) "Import" a deposit into a chosen shard (updates the shard's token commitment
 *      using pool_hash_fold_v1_1; moves BCH value into the shard UTXO).
 *   4) "Withdraw" from a shard to another paycode-derived RPA stealth address
 *      (updates shard commitment again; emits a normal payment output).
 *
 * Where the *privacy* placeholders live (to be replaced in later iterations):
 *   - NOTE HASH BINDING: we currently fold an outpoint-derived hash into state, but the
 *     covenant does NOT enforce that the hash corresponds to any particular deposit input.
 *     (Future: ZK proof binds note commitments + membership.)
 *   - AUTHORIZATION: pool_hash_fold_v1_1 as used here has no per-user authorization.
 *     (Future: RPA guard / signature check OR ZK proof of authorization.)
 *   - AMOUNT CONSERVATION / INFLATION: covenant does not enforce values.
 *     (Future: ZK proof enforces balance/commitments.)
 *   - NULLIFIERS: we fold a placeholder "nullifier hash" into state.
 *     (Future: ZK spend reveals nullifier w/o linking to note outpoint.)
 *
 * Recommended quickstart:
 *   bch-stealth pool run --shards 8 --deposit 120000 --withdraw 50000
 *
 * Run steps individually (same flow as `run`):
 *   bch-stealth pool init --shards 8
 *   bch-stealth pool deposit --amount 120000
 *   bch-stealth pool import
 *   bch-stealth pool withdraw --amount 50000
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Command } from 'commander';

import {
  FileBackedPoolStateStore,
  // types
  type PoolState,
  type ShardPointer,
  type DepositRecord,
  type WithdrawalRecord,
  type StealthUtxoRecord,
  type RpaContext,
  // helpers
  ensurePoolStateDefaults,
  upsertDeposit,
  getLatestUnimportedDeposit,
  upsertStealthUtxo,
  markStealthSpent,
  // io
  resolveDefaultPoolStatePaths,
  migrateLegacyPoolStateDirSync,
  POOL_STATE_STORE_KEY,
} from '@bch-stealth/pool-state';

import * as PoolHashFold from '@bch-stealth/pool-hash-fold';
import * as PoolShards from '@bch-stealth/pool-shards';

import * as Electrum from '@bch-stealth/electrum';
import * as TxBuilder from '@bch-stealth/tx-builder';

import {
  bytesToHex,
  hexToBytes,
  concat,
  sha256,
  hash160,
  ensureEvenYPriv,
  reverseBytes,
  uint32le,
} from '@bch-stealth/utils';

import { deriveRpaOneTimePrivReceiver } from '@bch-stealth/rpa';

import { NETWORK, DUST } from './config.js';
import { getWallets, findRepoRoot } from './wallets.js';
import { setupPaycodesAndDerivation, extractPubKeyFromPaycode, printFundingHelp } from './paycodes.js';

import { makeChainIO } from './pool/io.js';
import { emptyPoolState, loadStateOrEmpty, saveState, selectFundingUtxo } from './pool/state.js';
import { toPoolShardsState, patchShardFromNextPoolState, normalizeValueSats } from './pool/adapters.js';
import { deriveStealthOutputsForPaymentAndChange, makeStealthUtxoRecord, deriveStealthP2pkhLock } from './pool/stealth.js';

import type { PoolOpContext } from './pool/context.js';

import { runInit } from './pool/ops/init.js';
import { runDeposit } from './pool/ops/deposit.js';
import { runImport } from './pool/ops/import.js';
import { runWithdraw } from './pool/ops/withdraw.js';
import { runHappyPath } from './pool/ops/run.js';


// -------------------------------------------------------------------------------------
// pool-hash-fold namespace
// -------------------------------------------------------------------------------------
const { POOL_HASH_FOLD_VERSION } = PoolHashFold as any;

/**
 * Loader shim: different refactors may expose different helper names.
 * This keeps CLI compiling while we converge on a single exported API surface.
 */
async function getPoolHashFoldBytecode(poolVersion: any): Promise<Uint8Array> {
  const m: any = PoolHashFold;

  // Preferred (what CLI originally expected)
  if (typeof m.getPoolHashFoldBytecode === 'function') return await m.getPoolHashFoldBytecode(poolVersion);

  // Common alternate names (depending on earlier refactors)
  if (typeof m.getPoolHashFoldScript === 'function') return await m.getPoolHashFoldScript(poolVersion);
  if (typeof m.getRedeemScript === 'function') return await m.getRedeemScript(poolVersion);
  if (typeof m.loadPoolHashFoldBytecode === 'function') return await m.loadPoolHashFoldBytecode(poolVersion);

  throw new Error(
    `pool-hash-fold: missing bytecode loader export.\n` +
      `Expected one of: getPoolHashFoldBytecode | getPoolHashFoldScript | getRedeemScript | loadPoolHashFoldBytecode.\n` +
      `Available exports: ${Object.keys(m).sort().join(', ')}`
  );
}

// -------------------------------------------------------------------------------------
// Namespace imports (avoid TS2305 until package exports are stabilized)
// -------------------------------------------------------------------------------------
const { getUtxos, getTxDetails, parseTx } = Electrum as any;

// -------------------------------------------------------------------------------------
// Local structural types (keep wallet/tooling unblocked without depending on upstream typings)
// -------------------------------------------------------------------------------------

type WalletLike = {
  address: string;
  privBytes: Uint8Array;
  pubBytes: Uint8Array;
  hash160: Uint8Array;
  scanPrivBytes?: Uint8Array;
  spendPrivBytes?: Uint8Array;
};

type ShardOutpoint = { txid: string; vout: number };

// -------------------------------------------------------------------------------------
// Stable actors
// -------------------------------------------------------------------------------------
const ACTOR_A = { id: 'actor_a', label: 'Actor A' };
const ACTOR_B = { id: 'actor_b', label: 'Actor B' };

// -------------------------------------------------------------------------------------
// Repo root & state file
// -------------------------------------------------------------------------------------

const SHARD_VALUE = 2_000n;
const DEFAULT_FEE = 2_000n;

const REPO_ROOT = findRepoRoot();
const { stateDir: STATE_DIR, storeFile: STORE_FILE } = resolveDefaultPoolStatePaths(REPO_ROOT);

function makeStore(): FileBackedPoolStateStore {
  const opted = (program?.opts?.()?.stateFile as string | undefined) ?? null;

  migrateLegacyPoolStateDirSync({
    repoRoot: REPO_ROOT,
    optedStateFile: opted,
  });

  const filename = opted ?? STORE_FILE;
  return new FileBackedPoolStateStore({ filename });
}

async function readState(store: FileBackedPoolStateStore): Promise<PoolState> {
  // Always returns a concrete PoolState and persists migrations/defaults immediately.
  return await loadStateOrEmpty({ store, networkDefault: NETWORK });
}

async function writeState(store: FileBackedPoolStateStore, state: PoolState): Promise<void> {
  await saveState({ store, state, networkDefault: NETWORK });
}

// -------------------------------------------------------------------------------------
// Small script helpers
// -------------------------------------------------------------------------------------
function parseP2pkhHash160(scriptPubKey: Uint8Array | string): Uint8Array | null {
  const spk = scriptPubKey instanceof Uint8Array ? scriptPubKey : hexToBytes(scriptPubKey);

  // OP_DUP OP_HASH160 PUSH20 <20B> OP_EQUALVERIFY OP_CHECKSIG
  if (
    spk.length === 25 &&
    spk[0] === 0x76 &&
    spk[1] === 0xa9 &&
    spk[2] === 0x14 &&
    spk[23] === 0x88 &&
    spk[24] === 0xac
  ) {
    return spk.slice(3, 23);
  }
  return null;
}

function reverseHex32(txidHex: string): string {
  return bytesToHex(reverseBytes(hexToBytes(txidHex)));
}

function pubkeyHashFromPriv(privBytes: Uint8Array): { pub: Uint8Array; h160: Uint8Array } {
  const pub = secp256k1.getPublicKey(privBytes, true);
  const h160 = hash160(pub);
  return { pub, h160 };
}

function flattenBinArray(chunks: Uint8Array[]): Uint8Array {
  return concat(...chunks);
}

/** Build standard P2PKH locking bytecode for a 20-byte hash160. */
function p2pkhLockingBytecode(hash160: Uint8Array): Uint8Array {
  if (!(hash160 instanceof Uint8Array) || hash160.length !== 20) {
    throw new Error('p2pkhLockingBytecode: hash160 must be 20 bytes');
  }
  return Uint8Array.from([
    0x76, // OP_DUP
    0xa9, // OP_HASH160
    0x14, // push 20
    ...hash160,
    0x88, // OP_EQUALVERIFY
    0xac, // OP_CHECKSIG
  ]);
}

/** Minimal push for <= 75 bytes. */
function pushData(data: Uint8Array): Uint8Array {
  if (!(data instanceof Uint8Array)) throw new Error('pushData: Uint8Array required');
  if (data.length > 75) throw new Error('pushData: only supports <= 75B pushes in this demo');
  return Uint8Array.from([data.length, ...data]);
}

/** Derive a stable 32-byte hash for an outpoint (demo placeholder). */
function outpointHash32(txidHex: string, vout: number): Uint8Array {
  const txid = hexToBytes(txidHex);
  const n = uint32le(vout >>> 0);
  return sha256(flattenBinArray([txid, n]));
}

function assertChipnet(): void {
  // This demo intentionally targets chipnet for BCH2026-introspection opcodes.
  if ((NETWORK ?? '').toLowerCase() !== 'chipnet') {
    throw new Error(`This demo targets CHIPNET only. Current NETWORK=${NETWORK}`);
  }
}

// -------------------------------------------------------------------------------------
// State helpers (PATCHED: always return a concrete PoolState, prevent never[] and {} fallbacks)
// -------------------------------------------------------------------------------------

function feeFromSize(sizeBytes: number, feeRateSatPerByte: number, { safety = 200n } = {}): bigint {
  return BigInt(sizeBytes) * BigInt(feeRateSatPerByte) + safety;
}

function toBigIntSats(x: any): bigint {
  return typeof x === 'bigint' ? x : BigInt(x);
}

function toLowerHex(x: unknown): string | null {
  if (typeof x === 'string') return x.toLowerCase();
  if (x instanceof Uint8Array) return bytesToHex(x).toLowerCase();
  return null;
}

// -------------------------------------------------------------------------------------
// Wallet integration helpers (repo-specific)
// -------------------------------------------------------------------------------------

/**
 * paycodes.js expects Wallet with { priv, pub }. Our repo wallets are WalletLike with { privBytes, pubBytes }.
 * This adapter preserves *all* existing fields while adding the required aliases.
 */

function asPaycodeWallet<T extends Record<string, any>>(
  w: T
): T & { priv: Uint8Array; pub: Uint8Array; privBytes: Uint8Array; pubBytes: Uint8Array } {
  if (!w) throw new Error('asPaycodeWallet: wallet is required');

  const toBytes = (x: unknown, label: string): Uint8Array => {
    if (x instanceof Uint8Array) return x;

    if (typeof x === 'string') {
      const s = x.trim();
      if (!s) throw new Error(`asPaycodeWallet: ${label} is empty`);
      if (s.length % 2 !== 0) throw new Error(`asPaycodeWallet: ${label} hex length must be even`);
      if (!/^[0-9a-f]+$/i.test(s)) throw new Error(`asPaycodeWallet: ${label} must be hex`);
      return hexToBytes(s);
    }

    throw new Error(`asPaycodeWallet: ${label} must be Uint8Array or hex string`);
  };

  // Accept a few common field names (to stay compatible with older wallet loaders)
  const privBytes = toBytes(w.privBytes ?? w.priv ?? w.privKey ?? w.privateKeyHex ?? w.privHex, 'priv');
  const pubBytes =
    w.pubBytes instanceof Uint8Array
      ? w.pubBytes
      : w.pub instanceof Uint8Array
        ? w.pub
        : typeof w.pub === 'string'
          ? toBytes(w.pub, 'pub')
          : secp256k1.getPublicKey(privBytes, true);

  // Ensure wallet still has the fields your CLI expects elsewhere
  const hash160Bytes: Uint8Array =
    w.hash160 instanceof Uint8Array ? w.hash160 : hash160(pubBytes);

  // Preserve everything, add aliases + normalize byte fields
  return Object.assign({}, w, {
    priv: privBytes,
    pub: pubBytes,
    privBytes,
    pubBytes,
    hash160: hash160Bytes,
  });
}

async function loadDemoActors() {
  const wallets = await getWallets();
  const actorABaseWallet = wallets.alice; // existing wallet naming
  const actorBBaseWallet = wallets.bob;

  if (!actorABaseWallet?.pubBytes || !actorBBaseWallet?.pubBytes) {
    throw new Error(`getWallets() returned unexpected shape. Keys: ${Object.keys(wallets ?? {}).join(', ')}`);
  }

  const aliceForPaycodes = asPaycodeWallet(actorABaseWallet);
  const bobForPaycodes = asPaycodeWallet(actorBBaseWallet);

  const { alicePaycode, bobPaycode } = setupPaycodesAndDerivation(aliceForPaycodes, bobForPaycodes);

  const actorAPaycodePub33 = extractPubKeyFromPaycode(alicePaycode);
  const actorBPaycodePub33 = extractPubKeyFromPaycode(bobPaycode);

  // NEW: always print funding help after we know base addresses
  printFundingHelp({
    network: NETWORK,
    actorA: { id: ACTOR_A.id, label: ACTOR_A.label, baseAddress: actorABaseWallet.address },
    actorB: { id: ACTOR_B.id, label: ACTOR_B.label, baseAddress: actorBBaseWallet.address },
  });

  return {
    actorABaseWallet,
    actorBBaseWallet,
    actorAPaycode: alicePaycode,
    actorBPaycode: bobPaycode,
    actorAPaycodePub33,
    actorBPaycodePub33,
  };
}

// -------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------

const program = new Command();

program
  .name('bch-stealth')
  .description('bch-stealth CLI')
  .option('--pool-version <ver>', 'pool hash-fold version: v1 or v1_1', 'v1_1')
  .option('--state-file <path>', 'pool state file', STORE_FILE);

const pool = program
  .command('pool')
  .description('Sharded per-user pool demo (Phase 2.5 scaffolding)');

// ---- pool ops wiring --------------------------------------------------------
//
// NOTE: ops do their own load/save via pool/state.ts.
// index.ts should only build ctx + parse opts + print logs.

function resolvePoolVersionFlag(): any {
  return program.opts().poolVersion === 'v1' ? POOL_HASH_FOLD_VERSION.V1 : POOL_HASH_FOLD_VERSION.V1_1;
}

async function makePoolCtx(): Promise<PoolOpContext> {
  const store = makeStore();

  const electrum: any = Electrum as any;
  const chainIO = makeChainIO({ network: NETWORK, electrum });

  const actors = await loadDemoActors();

  return {
    network: NETWORK,
    store,
    chainIO,
    getUtxos,
    actors: {
      actorABaseWallet: actors.actorABaseWallet,
      actorBBaseWallet: actors.actorBBaseWallet,
      actorAPaycodePub33: actors.actorAPaycodePub33,
      actorBPaycodePub33: actors.actorBPaycodePub33,
    },
    poolVersion: resolvePoolVersionFlag(),
    config: {
      DUST,
      DEFAULT_FEE,
      SHARD_VALUE,
    },
  };
}

async function sweepDepositDebug(args: {
  depositOutpoint: DepositRecord;
  receiverWallet: WalletLike;
  chainIO: {
    broadcastRawTx: (hex: string) => Promise<string>;
    getPrevOutput: (txid: string, vout: number) => Promise<any>;
  };
}): Promise<string | null> {
  const { depositOutpoint, receiverWallet, chainIO } = args;

  // Minimal placeholder so the CLI compiles/runs even if you haven't re-homed the full
  // sweep implementation yet. Replace this body with your real sweep logic.
  //
  // Expected behavior:
  // - build a tx spending depositOutpoint to receiverWallet.address (or another target)
  // - sign and broadcast via chainIO.broadcastRawTx(rawHex)
  //
  // For now: throw with a clear message so the flag is not silently ignored.
  throw new Error(
    `[sweep-debug] sweepDepositDebug is stubbed. Re-home the previous sweep implementation here.\n` +
      `Requested outpoint: ${depositOutpoint.txid}:${depositOutpoint.vout}`
  );

  // return txid;
}

// --- pool init --------------------------------------------------------------

pool
  .command('init')
  .option('--shards <n>', 'number of shards', '8')
  .action(async (opts) => {
    assertChipnet();

    const shards = Number(opts.shards);
    if (!Number.isFinite(shards) || shards < 2) throw new Error('shards must be >= 2');

    const ctx = await makePoolCtx();
    const res = await runInit(ctx, { shards });

    console.log(`✅ init txid: ${res.txid ?? res.state?.txid ?? '<unknown>'}`);
    console.log(`   shards: ${shards}`);
    console.log(`   state saved: ${(program.opts().stateFile as string) ?? STORE_FILE}`);
  });

// --- pool deposit -----------------------------------------------------------

pool
  .command('deposit')
  .option('--amount <sats>', 'deposit amount in sats', '120000')
  .option('--fresh', 'force a new deposit even if one exists', false)
  .option('--change-mode <mode>', 'change mode: auto|transparent|stealth', 'auto')
  .option('--deposit-mode <mode>', 'deposit mode: rpa|base', 'rpa') // NEW
  .action(async (opts) => {
    assertChipnet();

    const amountSats = Number(opts.amount);
    if (!Number.isFinite(amountSats) || amountSats < Number(DUST)) {
      throw new Error(`amount must be >= dust (${DUST})`);
    }

    const changeMode = String(opts.changeMode ?? 'auto').toLowerCase();
    if (!['auto', 'transparent', 'stealth'].includes(changeMode)) {
      throw new Error(`invalid --change-mode: ${String(opts.changeMode)}`);
    }

    const depositMode = String(opts.depositMode ?? 'rpa').toLowerCase();
    if (!['rpa', 'base'].includes(depositMode)) {
      throw new Error(`invalid --deposit-mode: ${String(opts.depositMode)}`);
    }

    const ctx = await makePoolCtx();

    void opts.fresh;

    const res = await runDeposit(ctx, {
      amountSats,
      changeMode: changeMode as any,
      depositMode: depositMode as any,
    });

    console.log(`✅ deposit txid: ${res.txid}`);
    console.log(`   mode: ${depositMode}`);
    console.log(`   state saved: ${(program.opts().stateFile as string) ?? STORE_FILE}`);
  });

// --- pool withdraw ----------------------------------------------------------

pool
  .command('withdraw')
  .option('--shard <i>', 'shard index', '0')
  .option('--amount <sats>', 'withdraw amount in sats', '50000')
  .option('--fresh', 'force a new withdrawal even if already recorded', false)
  .action(async (opts) => {
    assertChipnet();

    const shardIndex = Number(opts.shard);
    const amountSats = Number(opts.amount);

    if (!Number.isFinite(shardIndex) || shardIndex < 0) throw new Error(`invalid --shard: ${String(opts.shard)}`);
    if (!Number.isFinite(amountSats) || amountSats < Number(DUST)) {
      throw new Error(`amount must be >= dust (${DUST})`);
    }

    const ctx = await makePoolCtx();
    const res = await runWithdraw(ctx, { shardIndex, amountSats, fresh: !!opts.fresh });

    console.log(`✅ withdraw txid: ${res.txid}`);
    console.log(`   state saved: ${(program.opts().stateFile as string) ?? STORE_FILE}`);
  });

pool
  .command('import')
  .option('--shard <i>', 'shard index (default: derived from deposit outpoint)', '')
  .option('--fresh', 'force a new import even if already marked imported', false)
  .option('--sweep', 'debug: sweep the deposit UTXO alone (and stop)', false)

  // base-import guards + key material
  .option(
    '--allow-base',
    'ALLOW importing a non-RPA base P2PKH deposit (requires BCH_STEALTH_ALLOW_BASE_IMPORT=1). ' +
      'This is not stealth and is intended for advanced users (e.g. after CashFusion).',
    false
  )
  .option(
    '--deposit-wif <wif>',
    'WIF for the base P2PKH deposit key (required when importing a non-RPA deposit).',
    ''
  )
  .option(
    '--deposit-privhex <hex>',
    'Hex private key for the base P2PKH deposit (advanced; alternative to --deposit-wif).',
    ''
  )

  .action(async (opts) => {
    assertChipnet();

    const ctx = await makePoolCtx();

    // --- keep sweep debug inline for now ---
    if (opts.sweep) {
      // ... your existing sweep-debug block unchanged ...
      // (no changes needed here)
      throw new Error('sweep path unchanged in this patch; keep your existing sweep-debug body.');
    }

    // --- normal import path via ops ---
    const shardIndexOpt: number | null = opts.shard === '' ? null : Number(opts.shard);
    if (opts.shard !== '' && !Number.isFinite(shardIndexOpt)) throw new Error(`invalid --shard: ${String(opts.shard)}`);

    const res = await runImport(ctx, {
      shardIndex: shardIndexOpt,
      fresh: !!opts.fresh,

      // NEW pass-through
      allowBase: !!opts.allowBase,
      depositWif: typeof opts.depositWif === 'string' && opts.depositWif.trim() ? String(opts.depositWif).trim() : null,
      depositPrivHex:
        typeof opts.depositPrivhex === 'string' && opts.depositPrivhex.trim() ? String(opts.depositPrivhex).trim() : null,
    });

    if (!res) {
      console.log('ℹ no unimported deposit found; skipping.');
      return;
    }

    console.log(`✅ import txid: ${res.txid}`);
    console.log(`   shard: ${res.shardIndex}`);
    console.log(`   state saved: ${(program.opts().stateFile as string) ?? STORE_FILE}`);
  });

pool
  .command('run')
  .option('--shards <n>', 'number of shards', '8')
  .option('--deposit <sats>', 'deposit amount', '120000')
  .option('--withdraw <sats>', 'withdraw amount', '50000')
  .option('--fresh', 'force a new init (creates new shards)', false)
  .action(async (opts) => {
    assertChipnet();

    const shards = Number(opts.shards);
    const depositSats = Number(opts.deposit);
    const withdrawSats = Number(opts.withdraw);

    if (!Number.isFinite(shards) || shards < 2) throw new Error('shards must be >= 2');
    if (!Number.isFinite(depositSats) || depositSats < Number(DUST)) {
      throw new Error(`deposit must be >= dust (${DUST})`);
    }
    if (!Number.isFinite(withdrawSats) || withdrawSats < Number(DUST)) {
      throw new Error(`withdraw must be >= dust (${DUST})`);
    }

    const ctx = await makePoolCtx();

    // NOTE: runHappyPath opts currently does not include `fresh`.
    // Keep the flag parsed for CLI UX, but ignore it here unless/until runHappyPath supports it.
    void opts.fresh;

    await runHappyPath(ctx, {
      shards,
      depositSats,
      withdrawSats,
    });

    console.log('\n✅ done');
    console.log(`state saved: ${(program.opts().stateFile as string) ?? STORE_FILE} (${POOL_STATE_STORE_KEY})`);
  });

// --- MUST await parseAsync or Node may exit before Commander prints/help runs ---
(async () => {
  await program.parseAsync(process.argv);
})().catch((err) => {
  console.error('❌', err?.stack || err?.message || err);
  process.exitCode = 1;
});