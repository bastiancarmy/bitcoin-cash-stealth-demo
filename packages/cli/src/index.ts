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
import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';

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
  POOL_STATE_STORE_KEY,
  resolveDefaultPoolStatePaths,
  migrateLegacyPoolStateDirSync,
  readPoolState,
  writePoolState,
} from '@bch-stealth/pool-state';

import * as PoolHashFold from '@bch-stealth/pool-hash-fold';

import * as PoolShards from '@bch-stealth/pool-shards';

import { bytesToHex, hexToBytes, concat } from '@bch-stealth/utils';

import {
  sha256,
  hash160,
  ensureEvenYPriv,
  reverseBytes,
  uint32le,
} from '@bch-stealth/utils';

import {
  RPA_MODE_STEALTH_P2PKH,
  deriveRpaLockIntent,
  deriveRpaOneTimePrivReceiver,
} from '@bch-stealth/rpa';

import * as Electrum from '@bch-stealth/electrum';
import * as TxBuilder from '@bch-stealth/tx-builder';

import { NETWORK, DUST } from './config.js';
import { getWallets, findRepoRoot } from './wallets.js';
import { setupPaycodesAndDerivation, extractPubKeyFromPaycode } from './paycodes.js';

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
const {
  broadcastTx,
  getUtxos,
  getTxDetails,
  getUtxosFromScripthash,
  getFeeRate,
  parseTx,
} = Electrum as any;

const { buildRawTx, signInput, addTokenToScript } = TxBuilder as any;

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

async function readState(store: FileBackedPoolStateStore): Promise<PoolState | null> {
  const state = await readPoolState({ store, networkDefault: NETWORK });

  // If pool-state performed any migration on read, persist the migrated form.
  if (state) {
    await writePoolState({ store, state, networkDefault: NETWORK });
  }

  return state;
}

async function writeState(store: FileBackedPoolStateStore, state: PoolState): Promise<void> {
  await writePoolState({ store, state, networkDefault: NETWORK });
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

function emptyPoolState(): PoolState {
  return {
    network: NETWORK,
    shards: [],
    stealthUtxos: [],
    deposits: [],
    withdrawals: [],
  };
}

// function ensurePoolStateDefaults(state?: PoolState | null): PoolState {
//   const st = (state ?? {}) as PoolState;

//   st.network = st.network ?? NETWORK;
//   st.shards = Array.isArray(st.shards) ? st.shards : [];
//   st.stealthUtxos = Array.isArray(st.stealthUtxos) ? st.stealthUtxos : [];
//   st.deposits = Array.isArray(st.deposits) ? st.deposits : [];
//   st.withdrawals = Array.isArray(st.withdrawals) ? st.withdrawals : [];

//   return st;
// }

// function upsertStealthUtxo(state: PoolState, rec: StealthUtxoRecord): void {
//   const st = ensurePoolStateDefaults(state);
//   const key = `${rec.txid}:${rec.vout}`;
//   const idx = st.stealthUtxos.findIndex((r) => r && `${r.txid}:${r.vout}` === key);
//   if (idx >= 0) st.stealthUtxos[idx] = { ...st.stealthUtxos[idx], ...rec };
//   else st.stealthUtxos.push(rec);
// }

// function markStealthSpent(state: PoolState, txid: string, vout: number, spentInTxid: string): void {
//   const st = ensurePoolStateDefaults(state);
//   const key = `${txid}:${vout}`;
//   const idx = st.stealthUtxos.findIndex((r) => r && `${r.txid}:${r.vout}` === key);
//   if (idx >= 0) {
//     st.stealthUtxos[idx] = {
//       ...st.stealthUtxos[idx],
//       spentInTxid,
//       spentAt: new Date().toISOString(),
//     };
//   }
// }

// function getLatestUnimportedDeposit(state: PoolState, amountSats: number | null): DepositRecord | null {
//   const st = ensurePoolStateDefaults(state);
//   const deps = Array.isArray(st?.deposits) ? st.deposits : [];
//   for (let i = deps.length - 1; i >= 0; i--) {
//     const d = deps[i];
//     if (!d) continue;
//     if (d.importTxid) continue;
//     if (amountSats != null && Number(d.value) !== Number(amountSats)) continue;
//     return d;
//   }
//   return null;
// }

// function upsertDeposit(state: PoolState, dep: DepositRecord): void {
//   const st = ensurePoolStateDefaults(state);
//   const i = st.deposits.findIndex((d) => d.txid === dep.txid && d.vout === dep.vout);
//   if (i >= 0) st.deposits[i] = { ...st.deposits[i], ...dep };
//   else st.deposits.push(dep);
// }

async function getPrevOutput(txid: string, vout: number): Promise<any> {
  const details = await getTxDetails(txid, NETWORK);
  const out = details.outputs?.[vout];
  if (!out) throw new Error(`Unable to read prevout ${txid}:${vout}`);
  return out;
}

async function pickFeeRateOrFallback(): Promise<number> {
  try {
    const fr = await getFeeRate();
    if (typeof fr === 'number' && Number.isFinite(fr) && fr >= 1) return Math.ceil(fr);
  } catch {}
  return 2;
}

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

function p2pkhScripthashFromHash160(hash16020: Uint8Array): string {
  const script = p2pkhLockingBytecode(hash16020);
  const h = sha256(script);
  const scripthash = reverseBytes(h);
  return bytesToHex(scripthash);
}

async function isP2pkhOutpointUnspent({
  txid,
  vout,
  hash160Hex,
}: {
  txid: string;
  vout: number;
  hash160Hex: string;
}): Promise<boolean> {
  const hash160 = hexToBytes(hash160Hex);
  const sh = p2pkhScripthashFromHash160(hash160).toLowerCase();
  const utxos = await getUtxosFromScripthash(sh, NETWORK, true);
  return Array.isArray(utxos) && utxos.some((u) => u.txid === txid && u.vout === vout);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForP2pkhOutpointUnspent(
  { txid, vout, hash160Hex }: { txid: string; vout: number; hash160Hex: string },
  { attempts = 10, delayMs = 800 }: { attempts?: number; delayMs?: number } = {}
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const ok = await isP2pkhOutpointUnspent({ txid, vout, hash160Hex });
    if (ok) return true;
    await sleep(delayMs);
  }
  return false;
}

/**
 * Convenience: derive a stealth P2PKH locking intent AND the minimum context the receiver needs
 * to derive the one-time private key later.
 */
function deriveStealthP2pkhLock({
  senderWallet,
  receiverPaycodePub33,
  prevoutTxidHex,
  prevoutN,
  index,
}: {
  senderWallet: WalletLike;
  receiverPaycodePub33: Uint8Array;
  prevoutTxidHex: string;
  prevoutN: number;
  index: number;
}): { intent: any; rpaContext: RpaContext } {
  const intent = deriveRpaLockIntent({
    mode: RPA_MODE_STEALTH_P2PKH,
    senderPrivBytes: senderWallet.privBytes,
    receiverPub33: receiverPaycodePub33,
    prevoutTxidHex,
    prevoutN,
    index,
  });

  const rpaContext: RpaContext = {
    senderPub33Hex: bytesToHex(senderWallet.pubBytes),
    // IMPORTANT (LOCKED-IN): prevout txid is used "as-is" (no endian reversal)
    prevoutHashHex: prevoutTxidHex,
    prevoutN,
    index,
  };

  return { intent, rpaContext };
}

/**
 * Select a single spendable funding UTXO for `ownerTag`, preferring any previously-recorded
 * stealth outputs in the state file. Returns both the prevOut data and the private key bytes to sign.
 */
async function selectFundingUtxo({
  state,
  wallet,
  ownerTag,
  minSats = BigInt(DUST),
}: {
  state?: PoolState | null;
  wallet: WalletLike;
  ownerTag: string;
  minSats?: bigint;
}): Promise<{
  txid: string;
  vout: number;
  prevOut: any;
  signPrivBytes: Uint8Array;
  source: 'stealth' | 'base';
  record?: StealthUtxoRecord;
}> {
  const st = ensurePoolStateDefaults(state);

  // 1) Prefer stealth UTXOs created by this demo (we can derive spending keys deterministically).
  const stealthRecs = (st?.stealthUtxos ?? [])
    .filter((r) => r && r.owner === ownerTag && !r.spentInTxid)
    .sort((a, b) => (toBigIntSats(b.value ?? 0) > toBigIntSats(a.value ?? 0) ? 1 : -1));

  for (const r of stealthRecs) {
    const unspent = await isP2pkhOutpointUnspent({ txid: r.txid, vout: r.vout, hash160Hex: r.hash160Hex });
    if (!unspent) {
      markStealthSpent(st, r.txid, r.vout, '<spent>');
      continue;
    }

    const prev = await getPrevOutput(r.txid, r.vout);
    const value = toBigIntSats(prev.value);
    if (value < minSats) continue;

    const expectedH160 = parseP2pkhHash160(prev.scriptPubKey);
    if (!expectedH160 || bytesToHex(expectedH160) !== r.hash160Hex) {
      throw new Error(`stealth utxo prevout mismatch at ${r.txid}:${r.vout}`);
    }

    const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
      wallet.scanPrivBytes ?? wallet.privBytes,
      wallet.spendPrivBytes ?? wallet.privBytes,
      hexToBytes(r.rpaContext.senderPub33Hex),
      r.rpaContext.prevoutHashHex,
      r.rpaContext.prevoutN,
      r.rpaContext.index
    );

    const { h160 } = pubkeyHashFromPriv(oneTimePriv);
    if (bytesToHex(h160) !== r.hash160Hex) {
      throw new Error(`stealth utxo derivation mismatch at ${r.txid}:${r.vout}`);
    }

    return { txid: r.txid, vout: r.vout, prevOut: prev, signPrivBytes: oneTimePriv, source: 'stealth', record: r };
  }

  // 2) Fall back to base P2PKH UTXOs from the wallet address.
  const utxos = await getUtxos(wallet.address, NETWORK, true);
  const base = (utxos ?? [])
    .filter((u) => u && !u.token_data)
    .sort((a, b) => (toBigIntSats(b.value ?? 0) > toBigIntSats(a.value ?? 0) ? 1 : -1));

  for (const u of base) {
    const prev = await getPrevOutput(u.txid, u.vout);
    const value = toBigIntSats(prev.value);
    if (value < minSats) continue;

    if (!parseP2pkhHash160(prev.scriptPubKey)) continue;
    return { txid: u.txid, vout: u.vout, prevOut: prev, signPrivBytes: wallet.privBytes, source: 'base' };
  }

  throw new Error(`No funding UTXO available for ${ownerTag}. Fund ${wallet.address} on chipnet.`);
}

async function finalizeAndSignInitTx({
  tx,
  inputPrivBytes,
  prevOut,
}: {
  tx: any;
  inputPrivBytes: Uint8Array;
  prevOut: any;
}): Promise<{ rawHex: string; sizeBytes: number }> {
  signInput(tx, 0, inputPrivBytes, prevOut.scriptPubKey, toBigIntSats(prevOut.value));
  const rawBytes = buildRawTx(tx, { format: 'bytes' });
  const sizeBytes = rawBytes.length;
  const rawHex = bytesToHex(rawBytes);
  return { rawHex, sizeBytes };
}

// -------------------------------------------------------------------------------------
// State init / reuse
// -------------------------------------------------------------------------------------

// Refactored to use pool-state store (FileBackedPoolStateStore) + POOL_STATE_STORE_KEY,
// and to avoid any legacy STATE_FILE read/write paths.

async function ensurePoolState({
  store,
  ownerWallet,
  ownerPaycodePub33,
  shardCount,
  poolVersion,
  fresh = false,
}: {
  store: FileBackedPoolStateStore;
  ownerWallet: WalletLike;
  ownerPaycodePub33: Uint8Array;
  shardCount: number;
  poolVersion: any;
  fresh?: boolean;
}): Promise<PoolState> {
  // Load existing state from the store (or start empty)
  let state = ensurePoolStateDefaults((await readState(store)) ?? emptyPoolState());

  const stateLooksValid =
    state?.network === NETWORK &&
    Array.isArray(state?.shards) &&
    state.shards.length > 0 &&
    typeof state.categoryHex === 'string' &&
    typeof state.redeemScriptHex === 'string';

  if (!fresh && stateLooksValid) {
    // quick validation: do the shard outpoints still exist?
    const missing: string[] = [];
    for (const s of state.shards) {
      try {
        await getPrevOutput(s.txid, s.vout);
      } catch {
        missing.push(`${s.txid}:${s.vout}`);
      }
    }

    if (missing.length === 0) {
      console.log(`\n[0/4] using existing shard state: ${(program.opts().stateFile as string) ?? STORE_FILE}`);
      console.log(`      key: ${POOL_STATE_STORE_KEY}`);
      console.log(`      shards: ${state.shards.length}`);
      return ensurePoolStateDefaults(state);
    }

    console.warn(`\n[0/4] state exists but ${missing.length} shard outpoints missing/spent.`);
    console.warn(`      attempting repair by scanning wallet UTXOs...`);

    const repaired = await tryRepairShardsFromWallet({ state, ownerWallet });
    if (repaired) {
      state = ensurePoolStateDefaults(repaired);
      await writeState(store, state);
      console.log(`      ✅ repaired shard pointers and updated state in store.`);
      return ensurePoolStateDefaults(state);
    }

    console.warn(`      ⚠️ repair failed; falling back to fresh init.`);
  }

  console.log(`\n[1/4] init ${shardCount} shards...`);
  const init = await initShardsTx({
    state: null,
    ownerWallet,
    ownerPaycodePub33,
    shardCount,
    poolVersion,
  });

  state = ensurePoolStateDefaults({
    network: NETWORK,
    ...init,
    stealthUtxos: init.stealthUtxos ?? [],
    deposits: [],
    withdrawals: [],
    createdAt: new Date().toISOString(),
  });

  await writeState(store, state);
  return state;
}

async function tryRepairShardsFromWallet({
  state,
  ownerWallet,
}: {
  state: PoolState;
  ownerWallet: WalletLike;
}): Promise<PoolState | null> {
  const redeemScriptHex = (state.redeemScriptHex ?? '').toLowerCase();
  const categoryHex = (state.categoryHex ?? '').toLowerCase();

  const utxos = await getUtxos(ownerWallet.address, NETWORK, true);

  const tokenUtxos = utxos.filter((u) => {
    const catHex = toLowerHex(u?.token_data?.category);
    return catHex && catHex === categoryHex;
  });

  if (tokenUtxos.length === 0) return null;

  const matches: ShardPointer[] = [];
  for (const u of tokenUtxos) {
    try {
      const tx = await getTxDetails(u.txid, NETWORK);
      const out = tx.outputs?.[u.vout];
      if (!out) continue;

      const spkHex = bytesToHex(out.scriptPubKey).toLowerCase();
      if (!spkHex.endsWith(redeemScriptHex)) continue;

      const outCatHex = toLowerHex(out?.token_data?.category);
      if (outCatHex !== categoryHex) continue;

      const commitment = out?.token_data?.nft?.commitment;
      const commitmentHex = commitment instanceof Uint8Array ? bytesToHex(commitment) : 'UNKNOWN';

      matches.push({
        txid: u.txid,
        vout: u.vout,
        value: BigInt(out.value).toString(),
        commitmentHex,
      });
    } catch {}
  }

  if (matches.length === 0) return null;

  // NOTE: cannot recover original shard indices once commitments have been mutated.
  const repairedShards: ShardPointer[] = matches.map((m, i) => ({ index: i, ...m }));

  const unknown = repairedShards.filter((s) => s.commitmentHex === 'UNKNOWN').length;
  if (unknown) console.warn(`repair: ${unknown} shard commitments missing; outpoints recovered only.`);

  return ensurePoolStateDefaults({
    ...state,
    shards: repairedShards,
    repairedAt: new Date().toISOString(),
  });
}

// -------------------------------------------------------------------------------------
// Core demo steps
// -------------------------------------------------------------------------------------

async function initShardsTx({
  state = null,
  ownerWallet,
  ownerPaycodePub33 = null,
  shardCount,
  poolVersion,
}: {
  state?: PoolState | null;
  ownerWallet: WalletLike;
  ownerPaycodePub33?: Uint8Array | null;
  shardCount: number;
  poolVersion: any;
}): Promise<{
  txid: string;
  categoryHex: string;
  poolVersion: any;
  redeemScriptHex: string;
  shards: ShardPointer[];
  stealthUtxos: StealthUtxoRecord[];
}> {
  const redeemScript = await getPoolHashFoldBytecode(poolVersion);

  const shardsTotal = SHARD_VALUE * BigInt(shardCount);

  // Prefer any previously-created stealth UTXOs for owner (Actor B) so base address stays quiet.
  const funding = await selectFundingUtxo({
    state,
    wallet: ownerWallet,
    ownerTag: ACTOR_B.id,
    minSats: shardsTotal + BigInt(DUST) + 20_000n,
  });

  const prev = funding.prevOut;

  // Token category convention: reverse(prevout.txid).
  const category32 = reverseBytes(hexToBytes(funding.txid));

  const inputValue = toBigIntSats(prev.value);

  // Build N shard outputs with simple deterministic commitments.
  const shardCommitments = Array.from({ length: shardCount }, (_, i) => {
    const c = new Uint8Array(32);
    c[28] = (i >>> 24) & 0xff;
    c[29] = (i >>> 16) & 0xff;
    c[30] = (i >>> 8) & 0xff;
    c[31] = i & 0xff;
    return c;
  });

  const shardOutputs = shardCommitments.map((commitment32) => {
    const token = {
      category: category32,
      nft: { capability: 'mutable', commitment: commitment32 },
    };
    const spk = addTokenToScript(token, redeemScript);
    return { value: SHARD_VALUE, scriptPubKey: spk };
  });

  // Change output: prefer stealth P2PKH (RPA) back to the owner's paycode if available.
  let changeSpk = p2pkhLockingBytecode(ownerWallet.hash160);
  let changeStealthTemplate: StealthUtxoRecord | null = null;

  if (ownerPaycodePub33) {
    const { intent, rpaContext } = deriveStealthP2pkhLock({
      senderWallet: ownerWallet,
      receiverPaycodePub33: ownerPaycodePub33,
      prevoutTxidHex: funding.txid,
      prevoutN: funding.vout,
      index: 0,
    });

    changeSpk = p2pkhLockingBytecode(intent.childHash160);
    changeStealthTemplate = {
      owner: ACTOR_B.id,
      purpose: 'init_change',
      txid: '<pending>',
      vout: shardCount,
      value: '<pending>',
      hash160Hex: bytesToHex(intent.childHash160),
      rpaContext,
      createdAt: new Date().toISOString(),
    };
  }

  const feeRate = await pickFeeRateOrFallback();

  let feeGuess = 8_000n;
  let changeValue = inputValue - shardsTotal - feeGuess;
  if (changeValue < BigInt(DUST)) {
    throw new Error(
      `Not enough funds. Need at least ~${(shardsTotal + feeGuess + BigInt(DUST)).toString()} sats in the funding UTXO.`
    );
  }

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        txid: funding.txid,
        vout: funding.vout,
        scriptSig: new Uint8Array(),
        sequence: 0xffffffff,
      },
    ],
    outputs: [...shardOutputs, { value: changeValue, scriptPubKey: changeSpk }],
  };

  let { rawHex, sizeBytes } = await finalizeAndSignInitTx({
    tx,
    inputPrivBytes: funding.signPrivBytes,
    prevOut: prev,
  });

  const feeNeeded = feeFromSize(sizeBytes, feeRate, { safety: 200n });

  if (feeNeeded > feeGuess) {
    const change2 = inputValue - shardsTotal - feeNeeded;
    if (change2 < BigInt(DUST)) {
      throw new Error(
        `Not enough funds to pay relay fee.\ninput=${inputValue} shardsTotal=${shardsTotal} feeNeeded≈${feeNeeded} dust=${BigInt(DUST)}`
      );
    }

    tx.outputs[tx.outputs.length - 1] = { value: change2, scriptPubKey: changeSpk };
    ({ rawHex, sizeBytes } = await finalizeAndSignInitTx({
      tx,
      inputPrivBytes: funding.signPrivBytes,
      prevOut: prev,
    }));
    changeValue = change2;
    feeGuess = feeNeeded;
  }

  const impliedFee = inputValue - shardsTotal - changeValue;

  console.log(`Init tx size: ${sizeBytes} bytes`);
  console.log(`Fee rate: ${feeRate} sat/B`);
  console.log(`Fee paid: ${impliedFee} sats`);

  const txid = await broadcastTx(rawHex);

  if (changeStealthTemplate) {
    console.log(
      `[init] change (stealth) -> outpoint ${txid}:${shardCount} value=${changeValue.toString()} sats hash160=${changeStealthTemplate.hash160Hex}`
    );
  } else {
    console.log(`[init] change (base P2PKH fallback) -> outpoint ${txid}:${shardCount} value=${changeValue.toString()} sats`);
  }

  const shards: ShardPointer[] = shardCommitments.map((c, i) => ({
    txid,
    vout: i,
    value: SHARD_VALUE.toString(),
    commitmentHex: bytesToHex(c),
  }));

  const stealthUtxos: StealthUtxoRecord[] = [];
  if (changeStealthTemplate) {
    stealthUtxos.push({
      ...changeStealthTemplate,
      txid,
      value: changeValue.toString(),
    });
  }

  return {
    txid,
    categoryHex: bytesToHex(category32),
    poolVersion,
    redeemScriptHex: bytesToHex(redeemScript),
    shards,
    stealthUtxos,
  };
}

async function createDeposit({
  state,
  senderWallet,
  senderPaycodePub33,
  senderTag,
  receiverPaycodePub33,
  amountSats,
}: {
  state: PoolState;
  senderWallet: WalletLike;
  senderPaycodePub33: Uint8Array;
  senderTag: string;
  receiverPaycodePub33: Uint8Array;
  amountSats: number;
}): Promise<{ deposit: DepositRecord; change: StealthUtxoRecord | null }> {
  const st = ensurePoolStateDefaults(state);

  const amount = BigInt(amountSats);
  if (amount < BigInt(DUST)) throw new Error('deposit amount below dust');

  const senderUtxo = await selectFundingUtxo({
    state: st,
    wallet: senderWallet,
    ownerTag: senderTag,
    minSats: amount + BigInt(DUST) + 2_000n,
  });

  const prev = senderUtxo.prevOut;
  const inputValue = BigInt(prev.value);

  // Receiver stealth output (index 0) from the actual spent prevout.
  const { intent: payIntent, rpaContext: payContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33,
    prevoutTxidHex: senderUtxo.txid,
    prevoutN: senderUtxo.vout,
    index: 0,
  });

  const outSpk = p2pkhLockingBytecode(payIntent.childHash160);

  // Stealth change back to sender paycode (index 1).
  const { intent: changeIntent, rpaContext: changeContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33: senderPaycodePub33,
    prevoutTxidHex: senderUtxo.txid,
    prevoutN: senderUtxo.vout,
    index: 1,
  });

  const changeSpkStealth = p2pkhLockingBytecode(changeIntent.childHash160);

  const feeRate = await pickFeeRateOrFallback();
  const estSize = 225; // 1-in, 2-out P2PKH (good enough for demo)
  const feeFloor = BigInt(feeRate) * BigInt(estSize);

  let changeValue = inputValue - amount - feeFloor;

  const outputs: any[] = [{ value: amount, scriptPubKey: outSpk }];

  let changeRec: StealthUtxoRecord | null = null;
  if (changeValue >= BigInt(DUST)) {
    outputs.push({ value: changeValue, scriptPubKey: changeSpkStealth });

    changeRec = {
      owner: senderTag,
      purpose: 'deposit_change',
      txid: '<pending>',
      vout: 1,
      value: changeValue.toString(),
      hash160Hex: bytesToHex(changeIntent.childHash160),
      rpaContext: changeContext,
      createdAt: new Date().toISOString(),
    };
  } else {
    changeValue = 0n; // remainder becomes fee; avoids dust change
  }

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        txid: senderUtxo.txid,
        vout: senderUtxo.vout,
        scriptSig: new Uint8Array(),
        sequence: 0xffffffff,
      },
    ],
    outputs,
  };

  signInput(tx, 0, senderUtxo.signPrivBytes, prev.scriptPubKey, BigInt(prev.value));

  const rawTx = buildRawTx(tx);
  const txid = await broadcastTx(rawTx);

  console.log(
    `[deposit] payment (stealth) -> outpoint ${txid}:0 value=${amount.toString()} sats hash160=${bytesToHex(payIntent.childHash160)}`
  );

  if (changeRec && changeValue > 0n) {
    console.log(
      `[deposit] change (stealth)  -> outpoint ${txid}:${changeRec.vout} value=${changeValue.toString()} sats hash160=${changeRec.hash160Hex}`
    );
  } else {
    console.log(`[deposit] change: none (remainder absorbed into fee to avoid dust)`);
  }

  if (senderUtxo.source === 'stealth') {
    markStealthSpent(st, senderUtxo.txid, senderUtxo.vout, txid);
  }

  if (changeRec) changeRec.txid = txid;

  return {
    deposit: {
      txid,
      vout: 0,
      value: amount.toString(),
      receiverRpaHash160Hex: bytesToHex(payIntent.childHash160),
      createdAt: new Date().toISOString(),
      rpaContext: payContext,
    },
    change: changeRec,
  };
}

async function ensureDeposit({
  state,
  senderWallet,
  senderPaycodePub33,
  senderTag = ACTOR_A.id,
  receiverPaycodePub33,
  amountSats,
  fresh = false,
}: {
  state: PoolState;
  senderWallet: WalletLike;
  senderPaycodePub33: Uint8Array;
  senderTag?: string;
  receiverPaycodePub33: Uint8Array;
  amountSats: number;
  fresh?: boolean;
}): Promise<DepositRecord> {
  const st = ensurePoolStateDefaults(state);

  if (!fresh) {
    const existing = getLatestUnimportedDeposit(st, amountSats);
    if (existing?.txid && existing?.receiverRpaHash160Hex) {
      const unspent = await isP2pkhOutpointUnspent({
        txid: existing.txid,
        vout: existing.vout,
        hash160Hex: existing.receiverRpaHash160Hex,
      });
      if (unspent) {
        st.lastDeposit = existing;
        console.log(`[deposit] reusing existing deposit: ${existing.txid}:${existing.vout}`);
        return existing;
      }
    }
  }

  const { deposit: dep, change } = await createDeposit({
    state: st,
    senderWallet,
    senderPaycodePub33,
    senderTag,
    receiverPaycodePub33,
    amountSats,
  });

  if (change) upsertStealthUtxo(st, change);

  st.lastDeposit = dep;
  upsertDeposit(st, dep);

  console.log(`[deposit] created new deposit: ${dep.txid}:${dep.vout}`);
  return dep;
}

async function sweepDepositDebug({
  depositOutpoint,
  receiverWallet,
}: {
  depositOutpoint: DepositRecord;
  receiverWallet: WalletLike;
}): Promise<string> {
  const depositPrev = await getPrevOutput(depositOutpoint.txid, depositOutpoint.vout);
  const depositValue = BigInt(depositPrev.value);

  const expectedH160 = parseP2pkhHash160(depositPrev.scriptPubKey);
  if (!expectedH160) throw new Error('deposit prevout is not P2PKH');

  const ctx = depositOutpoint.rpaContext;
  if (!ctx?.senderPub33Hex || !ctx?.prevoutHashHex) throw new Error('depositOutpoint missing rpaContext');

  const senderPub33 = hexToBytes(ctx.senderPub33Hex);

  // ✅ chosen (known-good): txid "as-is" + no evenY normalization
  const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
    receiverWallet.scanPrivBytes ?? receiverWallet.privBytes,
    receiverWallet.spendPrivBytes ?? receiverWallet.privBytes,
    senderPub33,
    ctx.prevoutHashHex,
    ctx.prevoutN,
    ctx.index
  );

  const { h160 } = pubkeyHashFromPriv(oneTimePriv);
  if (bytesToHex(h160) !== bytesToHex(expectedH160)) {
    throw new Error(`sweep derivation mismatch. expected=${bytesToHex(expectedH160)} derived=${bytesToHex(h160)}`);
  }

  const feeRate = await pickFeeRateOrFallback();
  const estSize = 191; // 1-in 1-out P2PKH
  const fee = BigInt(feeRate) * BigInt(estSize);

  const outValue = depositValue - fee;
  if (outValue < BigInt(DUST)) throw new Error('sweep would create dust');

  const outSpk = p2pkhLockingBytecode(receiverWallet.hash160);

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: depositOutpoint.txid, vout: depositOutpoint.vout, scriptSig: new Uint8Array(), sequence: 0xffffffff },
    ],
    outputs: [{ value: outValue, scriptPubKey: outSpk }],
  };

  signInput(tx, 0, oneTimePriv, depositPrev.scriptPubKey, depositValue);

  const rawTx = buildRawTx(tx);

  const ssHex = bytesToHex(tx.inputs[0].scriptSig);
  console.log('[sweep-debug] scriptsig hex:', ssHex);
  console.log('[sweep-debug] raw contains scriptsig?', rawTx.includes(ssHex));

  const txid = await broadcastTx(rawTx);
  console.log('[sweep-debug] broadcast txid:', txid);
  return txid;
}

async function importDepositToShard({
  poolState,
  shardIndex,
  depositOutpoint,
  receiverWallet,
}: {
  poolState: PoolState;
  shardIndex: number;
  depositOutpoint: DepositRecord;
  receiverWallet: WalletLike;
}): Promise<{ txid: string }> {
  // ----- gather inputs from chain (CLI IO boundary) -----
  const shard = poolState.shards[shardIndex];
  if (!shard) throw new Error(`invalid shardIndex ${shardIndex}`);

  const shardPrev = await getPrevOutput(shard.txid, shard.vout);
  const depositPrev = await getPrevOutput(depositOutpoint.txid, depositOutpoint.vout);

  const expectedH160 = parseP2pkhHash160(depositPrev.scriptPubKey);
  if (!expectedH160) throw new Error('deposit prevout is not P2PKH');

  // ----- derive the one-time privkey for the deposit spend (demo policy) -----
  const ctx = depositOutpoint.rpaContext;
  if (!ctx?.senderPub33Hex || !ctx?.prevoutHashHex) throw new Error('depositOutpoint missing rpaContext');

  const senderPub33 = hexToBytes(ctx.senderPub33Hex);

  const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
    receiverWallet.scanPrivBytes ?? receiverWallet.privBytes,
    receiverWallet.spendPrivBytes ?? receiverWallet.privBytes,
    senderPub33,
    ctx.prevoutHashHex,
    ctx.prevoutN,
    ctx.index
  );

  const { h160 } = pubkeyHashFromPriv(oneTimePriv);
  if (bytesToHex(h160) !== bytesToHex(expectedH160)) {
    throw new Error(
      `deposit spend derivation mismatch. expected=${bytesToHex(expectedH160)} derived=${bytesToHex(h160)}`
    );
  }

  if (!poolState.categoryHex || !poolState.redeemScriptHex) {
    throw new Error('State missing categoryHex/redeemScriptHex. Run init first or repair state.');
  } 

  // ----- call canonical builder (pool-shards) -----
  const pool: PoolShards.PoolState = {
    poolIdHex: (poolState as any).poolIdHex ?? bytesToHex(hash160(hexToBytes(poolState.categoryHex))), // fallback
    poolVersion: String((poolState as any).poolVersion ?? 'v1_1'),
    shardCount: poolState.shards.length,
    network: NETWORK,
    categoryHex: poolState.categoryHex,
    redeemScriptHex: poolState.redeemScriptHex,
    shards: poolState.shards.map((s, i) => ({
      index: (s as any).index ?? i,
      txid: s.txid,
      vout: s.vout,
      valueSats: String((s as any).valueSats ?? (s as any).value),
      commitmentHex: s.commitmentHex,
    })),
  };

  const shardPrevout: PoolShards.PrevoutLike = {
    txid: shard.txid,
    vout: shard.vout,
    valueSats: BigInt(shardPrev.value),
    scriptPubKey: shardPrev.scriptPubKey,
  };

  const depositPrevout: PoolShards.PrevoutLike = {
    txid: depositOutpoint.txid,
    vout: depositOutpoint.vout,
    valueSats: BigInt(depositPrev.value),
    scriptPubKey: depositPrev.scriptPubKey,
  };

  const covenantWallet: PoolShards.WalletLike = {
    // covenant signer: Actor B base wallet in this demo
    signPrivBytes: receiverWallet.privBytes,
    pubkeyHash160Hex: bytesToHex(receiverWallet.hash160),
  };

  const depositWallet: PoolShards.WalletLike = {
    // deposit signer: derived one-time key
    signPrivBytes: oneTimePriv,
    pubkeyHash160Hex: bytesToHex(h160),
  };

  const built = PoolShards.importDepositToShard({
    pool,
    shardIndex,
    shardPrevout,
    depositPrevout,
    covenantWallet,
    depositWallet,
    feeSats: DEFAULT_FEE, // preserve current CLI behavior
  } as any);

  const rawHex = bytesToHex(built.rawTx);
  const txid = await broadcastTx(rawHex);

  // ----- patch CLI pool-state shard pointer -----
  const newShard = built.nextPoolState.shards[shardIndex];
  poolState.shards[shardIndex] = {
    ...(poolState.shards[shardIndex] as any),
    txid,
    vout: 0,
    value: String(newShard.valueSats),
    commitmentHex: newShard.commitmentHex,
  } as any;

  return { txid };
}

async function ensureImport({
  state,
  receiverWallet,
  shardIndexOpt = null,
  fresh = false,
}: {
  state: PoolState;
  receiverWallet: WalletLike;
  shardIndexOpt?: number | null;
  fresh?: boolean;
}): Promise<{ txid: string; shardIndex: number } | null> {
  const st = ensurePoolStateDefaults(state);

  const dep =
    (st.lastDeposit && !st.lastDeposit.importTxid ? st.lastDeposit : null) ??
    getLatestUnimportedDeposit(st, null);

  if (!dep) {
    console.log('[import] no unimported deposit found; skipping.');
    return null;
  }

  if (!fresh && dep.importTxid) {
    console.log(`[import] already imported (state): ${dep.txid}:${dep.vout} -> tx ${dep.importTxid}`);
    return { txid: dep.importTxid, shardIndex: dep.importedIntoShard! };
  }

  let stillUnspent = await isP2pkhOutpointUnspent({
    txid: dep.txid,
    vout: dep.vout,
    hash160Hex: dep.receiverRpaHash160Hex,
  });

  if (!stillUnspent) {
    stillUnspent = await waitForP2pkhOutpointUnspent(
      { txid: dep.txid, vout: dep.vout, hash160Hex: dep.receiverRpaHash160Hex },
      { attempts: 12, delayMs: 750 }
    );
  }

  if (!stillUnspent) {
    const ageMs = dep.createdAt ? Date.now() - Date.parse(dep.createdAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(ageMs) && ageMs < 5 * 60 * 1000) {
      console.warn(
        `[import] deposit outpoint not visible via scripthash yet (likely 0-conf indexing lag). Proceeding anyway.\nOutpoint: ${dep.txid}:${dep.vout}`
      );
    } else {
      throw new Error(
        `[import] deposit outpoint is not visible as unspent and is not recent.\nEither restore state or create a fresh deposit.\nOutpoint: ${dep.txid}:${dep.vout}`
      );
    }
  }

  const shardCount = st.shards.length;
  const noteHash = outpointHash32(dep.txid, dep.vout);
  const derivedIndex = noteHash[0] % shardCount;
  const shardIndex =
    shardIndexOpt == null ? derivedIndex : Math.max(0, Math.min(shardCount - 1, Number(shardIndexOpt)));

  const shardBefore = { ...(st.shards[shardIndex]!) };

  const res = await importDepositToShard({
    poolState: st,
    shardIndex,
    depositOutpoint: dep,
    receiverWallet,
  });

  upsertDeposit(st, {
    ...dep,
    importedIntoShard: shardIndex,
    importTxid: res.txid,
  });

  st.lastImport = {
    txid: res.txid,
    shardIndex,
    deposit: { txid: dep.txid, vout: dep.vout },
    shardBefore,
    shardAfter: { ...st.shards[shardIndex]! },
    createdAt: new Date().toISOString(),
  };

  console.log(`[import] imported deposit ${dep.txid}:${dep.vout} into shard ${shardIndex} (tx ${res.txid})`);
  return { txid: res.txid, shardIndex };
}

async function withdrawFromShard({
  poolState,
  shardIndex,
  amountSats,
  senderWallet,
  senderPaycodePub33,
  senderTag = ACTOR_B.id,
  receiverPaycodePub33,
}: {
  poolState: PoolState;
  shardIndex: number;
  amountSats: number;
  senderWallet: WalletLike;
  senderPaycodePub33: Uint8Array;
  senderTag?: string;
  receiverPaycodePub33: Uint8Array;
}): Promise<{ txid: string }> {
  const st = ensurePoolStateDefaults(poolState);

  if (!st.categoryHex || !st.redeemScriptHex) {
    throw new Error('State missing redeemScriptHex/categoryHex. Run init first or repair state.');
  }

  const shard = st.shards[shardIndex];
  if (!shard) throw new Error(`Unknown shard index ${shardIndex}`);

  const shardPrev = await getPrevOutput(shard.txid, shard.vout);

  const payment = BigInt(amountSats);
  if (payment < BigInt(DUST)) throw new Error('withdraw amount below dust');

  // Fee UTXO can be base OR stealth; selectFundingUtxo returns correct signPrivBytes
  const feeUtxo = await selectFundingUtxo({
    state: st,
    wallet: senderWallet,
    ownerTag: senderTag,
    minSats: BigInt(DUST) + 2_000n,
  });
  const feePrev = feeUtxo.prevOut;

  // Receiver stealth output (index 0) from the actual spent fee prevout
  const { intent: payIntent, rpaContext: payContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33,
    prevoutTxidHex: feeUtxo.txid,
    prevoutN: feeUtxo.vout,
    index: 0,
  });

  // Stealth change back to sender paycode (index 1)
  const { intent: changeIntent, rpaContext: changeContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33: senderPaycodePub33,
    prevoutTxidHex: feeUtxo.txid,
    prevoutN: feeUtxo.vout,
    index: 1,
  });

  // Build canonical pool-shards PoolState view
  const pool: PoolShards.PoolState = {
    poolIdHex: (st as any).poolIdHex ?? bytesToHex(hash160(hexToBytes(st.categoryHex))),
    poolVersion: String((st as any).poolVersion ?? 'v1_1'),
    shardCount: st.shards.length,
    network: NETWORK,
    categoryHex: st.categoryHex,
    redeemScriptHex: st.redeemScriptHex,
    shards: st.shards.map((s, i) => ({
      index: (s as any).index ?? i,
      txid: s.txid,
      vout: s.vout,
      valueSats: String((s as any).valueSats ?? (s as any).value),
      commitmentHex: s.commitmentHex,
    })),
  };

  const shardPrevout: PoolShards.PrevoutLike = {
    txid: shard.txid,
    vout: shard.vout,
    valueSats: BigInt(shardPrev.value),
    scriptPubKey: shardPrev.scriptPubKey,
  };

  const feePrevout: PoolShards.PrevoutLike = {
    txid: feeUtxo.txid,
    vout: feeUtxo.vout,
    valueSats: BigInt(feePrev.value),
    scriptPubKey: feePrev.scriptPubKey,
  };

  const covenantWallet: PoolShards.WalletLike = {
    // covenant signer: Actor B base wallet (demo)
    signPrivBytes: senderWallet.privBytes,
    pubkeyHash160Hex: bytesToHex(senderWallet.hash160),
  };

  const feeWallet: PoolShards.WalletLike = {
    // fee signer: base OR stealth-derived, depending on selected funding utxo
    signPrivBytes: feeUtxo.signPrivBytes,
    pubkeyHash160Hex: bytesToHex(senderWallet.hash160),
  };

  const built = PoolShards.withdrawFromShard({
    pool,
    shardIndex,
    shardPrevout,
    feePrevout,
    covenantWallet,
    feeWallet,
    receiverP2pkhHash160Hex: bytesToHex(payIntent.childHash160),
    amountSats: payment,
    feeSats: DEFAULT_FEE,
    changeP2pkhHash160Hex: bytesToHex(changeIntent.childHash160),
  } as any);

  const rawHex = bytesToHex(built.rawTx);
  const txid = await broadcastTx(rawHex);

  console.log(
    `[withdraw] payment (stealth) -> outpoint ${txid}:1 value=${payment.toString()} sats hash160=${bytesToHex(
      payIntent.childHash160
    )}`
  );

  // record change as stealth UTXO (if it should exist)
  // (PoolShards builder always emits change output[2] here; your fee policy prevents dust)
  const changeRec: StealthUtxoRecord = {
    owner: senderTag,
    purpose: 'withdraw_change',
    txid,
    vout: 2,
    value: String(BigInt(feePrev.value) - BigInt(DEFAULT_FEE)),
    hash160Hex: bytesToHex(changeIntent.childHash160),
    rpaContext: changeContext,
    createdAt: new Date().toISOString(),
  };
  upsertStealthUtxo(st, changeRec);

  if (feeUtxo.source === 'stealth') markStealthSpent(st, feeUtxo.txid, feeUtxo.vout, txid);

  // patch shard pointer from builder output
  const newShard = built.nextPoolState.shards[shardIndex];
  st.shards[shardIndex] = {
    ...(st.shards[shardIndex] as any),
    txid,
    vout: 0,
    value: String(newShard.valueSats),
    commitmentHex: newShard.commitmentHex,
  } as any;

  // record withdrawal
  st.withdrawals.push({
    txid,
    shardIndex,
    amountSats,
    receiverRpaHash160Hex: bytesToHex(payIntent.childHash160),
    createdAt: new Date().toISOString(),
    rpaContext: payContext,
    receiverPaycodePub33Hex: bytesToHex(receiverPaycodePub33),
  } as any);

  return { txid };
}

async function ensureWithdraw({
  state,
  shardIndex,
  amountSats,
  senderWallet,
  senderPaycodePub33,
  senderTag = ACTOR_B.id,
  receiverPaycodePub33,
  fresh = false,
}: {
  state: PoolState;
  shardIndex: number;
  amountSats: number;
  senderWallet: WalletLike;
  senderPaycodePub33: Uint8Array;
  senderTag?: string;
  receiverPaycodePub33: Uint8Array;
  fresh?: boolean;
}): Promise<{ txid: string }> {
  const st = ensurePoolStateDefaults(state);

  const receiverPaycodePub33Hex = bytesToHex(receiverPaycodePub33);

  if (!fresh && Array.isArray(st.withdrawals)) {
    for (let i = st.withdrawals.length - 1; i >= 0; i--) {
      const w = st.withdrawals[i];
      if (!w) continue;
      if (w.shardIndex !== shardIndex) continue;
      if (Number(w.amountSats) !== Number(amountSats)) continue;
      if (w.receiverPaycodePub33Hex !== receiverPaycodePub33Hex) continue;

      const cur = st.shards[shardIndex];
      if (cur?.txid === w.shardAfter?.txid && cur?.vout === w.shardAfter?.vout) {
        console.log(`[withdraw] already done (state): tx ${w.txid}`);
        return { txid: w.txid };
      }
      break;
    }
  }

  const shardBefore = { ...(st.shards[shardIndex]!) };

  const res = await withdrawFromShard({
    poolState: st,
    shardIndex,
    amountSats,
    senderWallet,
    senderPaycodePub33,
    senderTag,
    receiverPaycodePub33,
  });

  const shardAfter = { ...st.shards[shardIndex]! };

  // Patch the most recent withdrawal entry with idempotence fields
  const last = st.withdrawals[st.withdrawals.length - 1]!;
  st.withdrawals[st.withdrawals.length - 1] = {
    ...last,
    receiverPaycodePub33Hex,
    shardBefore,
    shardAfter,
  };

  st.lastWithdraw = {
    txid: res.txid,
    shardIndex,
    amountSats,
    receiverPaycodePub33Hex,
    shardBefore,
    shardAfter,
    createdAt: new Date().toISOString(),
  };
  
  console.log(`[withdraw] withdrew ${amountSats} from shard ${shardIndex} (tx ${res.txid})`);
  return res;
}

// -------------------------------------------------------------------------------------
// Wallet integration helpers (repo-specific)
// -------------------------------------------------------------------------------------

/**
 * paycodes.js expects Wallet with { priv, pub }. Our repo wallets are WalletLike with { privBytes, pubBytes }.
 * This adapter preserves *all* existing fields while adding the required aliases.
 */

function asPaycodeWallet<T extends WalletLike>(w: T): T & { priv: Uint8Array; pub: Uint8Array } {
  if (!w) throw new Error('asPaycodeWallet: wallet is required');

  const priv = (w as any).priv ?? w.privBytes;
  const pub = (w as any).pub ?? w.pubBytes;

  if (!(priv instanceof Uint8Array)) {
    throw new Error('asPaycodeWallet: wallet missing privBytes (cannot alias to priv)');
  }
  if (!(pub instanceof Uint8Array)) {
    throw new Error('asPaycodeWallet: wallet missing pubBytes (cannot alias to pub)');
  }

  // Preserve everything, just add the aliases expected by setupPaycodesAndDerivation.
  return Object.assign({}, w, { priv, pub });
}


async function loadDemoActors() {
  const wallets = await getWallets();
  const actorABaseWallet = wallets.alice; // existing wallet naming
  const actorBBaseWallet = wallets.bob;

  if (!actorABaseWallet?.pubBytes || !actorBBaseWallet?.pubBytes) {
    throw new Error(`getWallets() returned unexpected shape. Keys: ${Object.keys(wallets ?? {}).join(', ')}`);
  }

  // Adapt WalletLike -> Wallet shape expected by paycodes.js (adds { priv, pub } aliases)
  const aliceForPaycodes = asPaycodeWallet(actorABaseWallet);
  const bobForPaycodes = asPaycodeWallet(actorBBaseWallet);

  // paycodes.js expects (alice, bob) wallet args
  const { alicePaycode, bobPaycode } = setupPaycodesAndDerivation(aliceForPaycodes, bobForPaycodes);

  const actorAPaycodePub33 = extractPubKeyFromPaycode(alicePaycode);
  const actorBPaycodePub33 = extractPubKeyFromPaycode(bobPaycode);

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

// --- pool init --------------------------------------------------------------

pool
  .command('init')
  .option('--shards <n>', 'number of shards', '8')
  .action(async (opts) => {
    assertChipnet();
    const store = makeStore();

    const shardCount = Number(opts.shards);
    if (!Number.isFinite(shardCount) || shardCount < 2) throw new Error('shards must be >= 2');

    const { actorBBaseWallet, actorBPaycodePub33 } = await loadDemoActors();

    const poolVersion =
      program.opts().poolVersion === 'v1' ? POOL_HASH_FOLD_VERSION.V1 : POOL_HASH_FOLD_VERSION.V1_1;

    const init = await initShardsTx({
      state: null,
      ownerWallet: actorBBaseWallet,
      ownerPaycodePub33: actorBPaycodePub33,
      shardCount,
      poolVersion,
    });

    const state = ensurePoolStateDefaults({
      network: NETWORK,
      ...init,
      deposits: [],
      withdrawals: [],
      createdAt: new Date().toISOString(),
    });

    await writeState(store, state);

    console.log(`✅ init txid: ${init.txid}`);
    console.log(`   shards: ${shardCount}`);
    console.log(`   state saved: ${(program.opts().stateFile as string) ?? STORE_FILE} (${POOL_STATE_STORE_KEY})`);
  });

// --- pool deposit -----------------------------------------------------------

pool
  .command('deposit')
  .option('--amount <sats>', 'deposit amount in sats', '120000')
  .option('--fresh', 'force a new deposit even if one exists', false)
  .action(async (opts) => {
    assertChipnet();
    const store = makeStore();

    const amountSats = Number(opts.amount);
    if (!Number.isFinite(amountSats) || amountSats < Number(DUST)) {
      throw new Error(`amount must be >= dust (${DUST})`);
    }

    const state = (await readPoolState({ store, networkDefault: NETWORK })) ?? emptyPoolState();
    await writePoolState({ store, state, networkDefault: NETWORK });

    const { actorABaseWallet, actorAPaycodePub33, actorBPaycodePub33 } = await loadDemoActors();

    await ensureDeposit({
      state,
      senderWallet: actorABaseWallet,
      senderPaycodePub33: actorAPaycodePub33,
      senderTag: ACTOR_A.id,
      receiverPaycodePub33: actorBPaycodePub33,
      amountSats,
      fresh: !!opts.fresh,
    });

    await writeState(store, state);

    console.log(`✅ deposit step done (state saved: ${(program.opts().stateFile as string) ?? STORE_FILE})`);
  });

// --- pool import ------------------------------------------------------------

pool
  .command('import')
  .option('--shard <i>', 'shard index (default: derived from deposit outpoint)', '')
  .option('--fresh', 'force a new import even if already marked imported', false)
  .option('--sweep', 'debug: sweep the deposit UTXO alone (and stop)', false)
  .action(async (opts) => {
    assertChipnet();
    const store = makeStore();

    const state = (await readPoolState({ store, networkDefault: NETWORK })) ?? emptyPoolState();
    await writePoolState({ store, state, networkDefault: NETWORK });
    if (!state?.shards?.length) throw new Error(`Run init first (state missing shards).`);

    const { actorBBaseWallet } = await loadDemoActors();
    const shardIndexOpt: number | null = opts.shard === '' ? null : Number(opts.shard);

    if (opts.sweep) {
      const dep =
        (state.lastDeposit && !state.lastDeposit.importTxid ? state.lastDeposit : null) ??
        getLatestUnimportedDeposit(state, null);

      if (!dep) {
        console.log('[sweep-debug] no unimported deposit found; skipping sweep.');
        return;
      }

      console.log(`\n[sweep-debug] sweeping deposit outpoint: ${dep.txid}:${dep.vout}`);
      const sweepTxid = await sweepDepositDebug({ depositOutpoint: dep, receiverWallet: actorBBaseWallet });

      upsertDeposit(state, { ...dep, spentTxid: sweepTxid ?? 'unknown', spentAt: new Date().toISOString() });

      await writeState(store, state);

      console.log('[sweep-debug] sweep done. (import skipped)');
      return;
    }

    await ensureImport({
      state,
      receiverWallet: actorBBaseWallet,
      shardIndexOpt,
      fresh: !!opts.fresh,
    });

    await writeState(store, state);

    console.log(`✅ import step done (state saved: ${(program.opts().stateFile as string) ?? STORE_FILE})`);
  });

// --- pool withdraw ----------------------------------------------------------

pool
  .command('withdraw')
  .option('--shard <i>', 'shard index', '0')
  .option('--amount <sats>', 'withdraw amount in sats', '50000')
  .option('--fresh', 'force a new withdrawal even if already recorded', false)
  .action(async (opts) => {
    assertChipnet();
    const store = makeStore();

    const state = (await readPoolState({ store, networkDefault: NETWORK })) ?? emptyPoolState();
    await writePoolState({ store, state, networkDefault: NETWORK });
    if (!state?.shards?.length) throw new Error(`Run init first (state missing shards).`);

    const shardIndex = Number(opts.shard);
    const amountSats = Number(opts.amount);

    const { actorBBaseWallet, actorBPaycodePub33, actorAPaycodePub33 } = await loadDemoActors();

    await ensureWithdraw({
      state,
      shardIndex,
      amountSats,
      senderWallet: actorBBaseWallet,
      senderPaycodePub33: actorBPaycodePub33,
      senderTag: ACTOR_B.id,
      receiverPaycodePub33: actorAPaycodePub33,
      fresh: !!opts.fresh,
    });

    await writeState(store, state);

    console.log(`✅ withdraw step done (state saved: ${(program.opts().stateFile as string) ?? STORE_FILE})`);
  });

// --- pool run ---------------------------------------------------------------

pool
  .command('run')
  .option('--shards <n>', 'number of shards', '8')
  .option('--deposit <sats>', 'deposit amount', '120000')
  .option('--withdraw <sats>', 'withdraw amount', '50000')
  .option('--fresh', 'force a new init (creates new shards)', false)
  .action(async (opts) => {
    assertChipnet();
    const store = makeStore();

    const shardCount = Number(opts.shards);
    const depositSats = Number(opts.deposit);
    const withdrawSats = Number(opts.withdraw);

    if (!Number.isFinite(shardCount) || shardCount < 2) throw new Error('shards must be >= 2');
    if (!Number.isFinite(depositSats) || depositSats < Number(DUST)) {
      throw new Error(`deposit must be >= dust (${DUST})`);
    }
    if (!Number.isFinite(withdrawSats) || withdrawSats < Number(DUST)) {
      throw new Error(`withdraw must be >= dust (${DUST})`);
    }

    const { actorABaseWallet, actorBBaseWallet, actorAPaycodePub33, actorBPaycodePub33 } = await loadDemoActors();

    const poolVersion =
      program.opts().poolVersion === 'v1' ? POOL_HASH_FOLD_VERSION.V1 : POOL_HASH_FOLD_VERSION.V1_1;

    let state = await ensurePoolState({
      store,
      ownerWallet: actorBBaseWallet,
      ownerPaycodePub33: actorBPaycodePub33,
      shardCount,
      poolVersion,
      fresh: !!opts.fresh,
    });

    await writeState(store, state);

    console.log(`\n[2/4] deposit ${depositSats} sats (Actor A -> Actor B stealth P2PKH)...`);
    await ensureDeposit({
      state,
      senderWallet: actorABaseWallet,
      senderPaycodePub33: actorAPaycodePub33,
      senderTag: ACTOR_A.id,
      receiverPaycodePub33: actorBPaycodePub33,
      amountSats: depositSats,
      fresh: false,
    });
    await writeState(store, state);

    console.log(`\n[3/4] import deposit into shard (derived selection)...`);
    const imp = await ensureImport({
      state,
      receiverWallet: actorBBaseWallet,
      shardIndexOpt: null,
      fresh: false,
    });
    await writeState(store, state);

    const shardIndex = imp?.shardIndex ?? 0;

    console.log(`\n[4/4] withdraw ${withdrawSats} sats (Actor B shard -> Actor A stealth P2PKH)...`);
    await ensureWithdraw({
      state,
      shardIndex,
      amountSats: withdrawSats,
      senderWallet: actorBBaseWallet,
      senderPaycodePub33: actorBPaycodePub33,
      senderTag: ACTOR_B.id,
      receiverPaycodePub33: actorAPaycodePub33,
      fresh: false,
    });
    await writeState(store, state);

    console.log('\n✅ done');
    console.log(`state saved: ${(program.opts().stateFile as string) ?? STORE_FILE} (${POOL_STATE_STORE_KEY})`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('❌', err?.stack || err?.message || err);
  process.exitCode = 1;
});