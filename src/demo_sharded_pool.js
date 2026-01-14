// src/demo_sharded_pool.js
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
 * Recommended way to run:
 *   node src/demo_sharded_pool.js run --shards 8 --deposit 120000 --withdraw 50000
 *
 * You can also run steps individually:
 *   node src/demo_sharded_pool.js init --shards 8
 *   node src/demo_sharded_pool.js deposit --amount 120000
 *   node src/demo_sharded_pool.js import
 *   node src/demo_sharded_pool.js withdraw --amount 50000
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import fsSync from 'node:fs';

import {
  bytesToHex,
  hexToBytes,
  sha256,
  _hash160,
  ensureEvenYPriv,
  extractPubKeyFromPaycode,
  concat,
  reverseBytes,
  uint32le,
} @bch-stealth/utils

import {
  broadcastTx,
  getUtxos,
  getTxDetails,
  getUtxosFromScripthash,
  getFeeRate,
  consolidateUtxos,
  parseTx,
} from '@bch-stealth/electrum';

import { buildRawTx, signInput, addTokenToScript } from '@bch-stealth/tx-builder';

import {
  RPA_MODE_STEALTH_P2PKH,
  deriveRpaLockIntent,
  deriveRpaOneTimePrivReceiver,
} from '@bch-stealth/rpa';

import {
  POOL_HASH_FOLD_VERSION,
  getPoolHashFoldBytecode,
  computePoolStateOut,
  // NOTE: these must exist in your pool-hash-fold package; if names differ, update imports.
  buildPoolHashFoldUnlockingBytecode,
  makeProofBlobV11,
} from '@bch-stealth/pool-hash-fold';

import { NETWORK, DUST } from './config.js';
import { getWallets } from './wallets.js';
import { setupPaycodesAndDerivation } from './paycodes.js';

// -------------------------------------------------------------------------------------
// Actor identifiers (generic, stable)
// -------------------------------------------------------------------------------------

const ACTOR_A = { id: 'actor_a', label: 'Actor A' };
const ACTOR_B = { id: 'actor_b', label: 'Actor B' };

// -------------------------------------------------------------------------------------
// Repo root & state file
// -------------------------------------------------------------------------------------

function findRepoRoot(startDir = process.cwd()) {
  let dir = startDir;
  while (true) {
    const pkg = path.join(dir, 'package.json');
    if (fsSync.existsSync(pkg)) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // fallback
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot();
const STATE_FILE = path.join(REPO_ROOT, 'demo_state', 'sharded_pool_state.json');

// Conservative defaults for chipnet demos.
const SHARD_VALUE = 2_000n;
const DEFAULT_FEE = 2_000n;

// -------------------------------------------------------------------------------------
// Small script helpers
// -------------------------------------------------------------------------------------

function parseP2pkhHash160(scriptPubKey) {
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

function reverseHex32(txidHex) {
  return bytesToHex(reverseBytes(hexToBytes(txidHex)));
}

function pubkeyHashFromPriv(privBytes) {
  const pub = secp256k1.getPublicKey(privBytes, true);
  const h160 = _hash160(pub);
  return { pub, h160 };
}

function flattenBinArray(chunks) {
  return concat(...chunks);
}

/** Build standard P2PKH locking bytecode for a 20-byte hash160. */
function p2pkhLockingBytecode(hash160) {
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
function pushData(data) {
  if (!(data instanceof Uint8Array)) throw new Error('pushData: Uint8Array required');
  if (data.length > 75) throw new Error('pushData: only supports <= 75B pushes in this demo');
  return Uint8Array.from([data.length, ...data]);
}

/** Derive a stable 32-byte hash for an outpoint (demo placeholder). */
function outpointHash32(txidHex, vout) {
  const txid = hexToBytes(txidHex);
  const n = uint32le(vout >>> 0);
  return sha256(flattenBinArray([txid, n]));
}

function assertChipnet() {
  // This demo intentionally targets chipnet for BCH2026-introspection opcodes.
  if ((NETWORK ?? '').toLowerCase() !== 'chipnet') {
    throw new Error(`This demo targets CHIPNET only. Current NETWORK=${NETWORK}`);
  }
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const st = JSON.parse(raw);
    ensureStateDefaults(st);
    return st;
  } catch {
    return null;
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function ensureStateDefaults(state) {
  if (!state) return state;
  state.stealthUtxos = Array.isArray(state.stealthUtxos) ? state.stealthUtxos : [];
  state.deposits = Array.isArray(state.deposits) ? state.deposits : [];
  state.withdrawals = Array.isArray(state.withdrawals) ? state.withdrawals : [];
  return state;
}

function upsertStealthUtxo(state, rec) {
  ensureStateDefaults(state);
  const key = `${rec.txid}:${rec.vout}`;
  const idx = state.stealthUtxos.findIndex((r) => r && `${r.txid}:${r.vout}` === key);
  if (idx >= 0) state.stealthUtxos[idx] = { ...state.stealthUtxos[idx], ...rec };
  else state.stealthUtxos.push(rec);
}

function markStealthSpent(state, txid, vout, spentInTxid) {
  ensureStateDefaults(state);
  const key = `${txid}:${vout}`;
  const idx = state.stealthUtxos.findIndex((r) => r && `${r.txid}:${r.vout}` === key);
  if (idx >= 0) {
    state.stealthUtxos[idx] = {
      ...state.stealthUtxos[idx],
      spentInTxid,
      spentAt: new Date().toISOString(),
    };
  }
}

function getLatestUnimportedDeposit(state, amountSats) {
  const deps = Array.isArray(state?.deposits) ? state.deposits : [];
  for (let i = deps.length - 1; i >= 0; i--) {
    const d = deps[i];
    if (!d) continue;
    if (d.importTxid) continue;
    if (amountSats != null && Number(d.value) !== Number(amountSats)) continue;
    return d;
  }
  return null;
}

function upsertDeposit(state, dep) {
  ensureStateDefaults(state);
  const i = state.deposits.findIndex((d) => d.txid === dep.txid && d.vout === dep.vout);
  if (i >= 0) state.deposits[i] = { ...state.deposits[i], ...dep };
  else state.deposits.push(dep);
}

async function getPrevOutput(txid, vout) {
  const details = await getTxDetails(txid, NETWORK);
  const out = details.outputs?.[vout];
  if (!out) throw new Error(`Unable to read prevout ${txid}:${vout}`);
  return out;
}

async function pickFeeRateOrFallback() {
  try {
    const fr = await getFeeRate();
    if (typeof fr === 'number' && Number.isFinite(fr) && fr >= 1) return Math.ceil(fr);
  } catch {}
  return 2;
}

function feeFromSize(sizeBytes, feeRateSatPerByte, { safety = 200n } = {}) {
  return BigInt(sizeBytes) * BigInt(feeRateSatPerByte) + safety;
}

function toBigIntSats(x) {
  return typeof x === 'bigint' ? x : BigInt(x);
}

function toLowerHex(x) {
  if (typeof x === 'string') return x.toLowerCase();
  if (x instanceof Uint8Array) return bytesToHex(x).toLowerCase();
  return null;
}

function p2pkhScripthashFromHash160(hash16020) {
  const script = p2pkhLockingBytecode(hash16020);
  const h = sha256(script);
  const scripthash = reverseBytes(h);
  return bytesToHex(scripthash);
}

async function isP2pkhOutpointUnspent({ txid, vout, hash160Hex }) {
  const hash160 = hexToBytes(hash160Hex);
  const sh = p2pkhScripthashFromHash160(hash160).toLowerCase();
  const utxos = await getUtxosFromScripthash(sh, NETWORK, true);
  return Array.isArray(utxos) && utxos.some((u) => u.txid === txid && u.vout === vout);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForP2pkhOutpointUnspent({ txid, vout, hash160Hex }, { attempts = 10, delayMs = 800 } = {}) {
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
function deriveStealthP2pkhLock({ senderWallet, receiverPaycodePub33, prevoutTxidHex, prevoutN, index }) {
  const intent = deriveRpaLockIntent({
    mode: RPA_MODE_STEALTH_P2PKH,
    senderPrivBytes: senderWallet.privBytes,
    receiverPub33: receiverPaycodePub33,
    prevoutTxidHex,
    prevoutN,
    index,
  });

  const rpaContext = {
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
async function selectFundingUtxo({ state, wallet, ownerTag, minSats = BigInt(DUST) }) {
  ensureStateDefaults(state);

  // 1) Prefer stealth UTXOs created by this demo (we can derive spending keys deterministically).
  const stealthRecs = (state?.stealthUtxos ?? [])
    .filter((r) => r && r.owner === ownerTag && !r.spentInTxid)
    .sort((a, b) => (toBigIntSats(b.value ?? 0) > toBigIntSats(a.value ?? 0) ? 1 : -1));

  for (const r of stealthRecs) {
    const unspent = await isP2pkhOutpointUnspent({ txid: r.txid, vout: r.vout, hash160Hex: r.hash160Hex });
    if (!unspent) {
      markStealthSpent(state, r.txid, r.vout, '<spent>');
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

async function finalizeAndSignInitTx({ tx, inputPrivBytes, prevOut }) {
  signInput(tx, 0, inputPrivBytes, prevOut.scriptPubKey, toBigIntSats(prevOut.value));
  const rawBytes = buildRawTx(tx, { format: 'bytes' });
  const sizeBytes = rawBytes.length;
  const rawHex = bytesToHex(rawBytes);
  return { rawHex, sizeBytes };
}

// -------------------------------------------------------------------------------------
// State init / reuse
// -------------------------------------------------------------------------------------

async function ensurePoolState({ ownerWallet, ownerPaycodePub33, shardCount, poolVersion, fresh = false }) {
  let state = await readState();

  const stateLooksValid =
    state?.network === NETWORK &&
    Array.isArray(state?.shards) &&
    state.shards.length > 0 &&
    typeof state.categoryHex === 'string' &&
    typeof state.redeemScriptHex === 'string';

  if (!fresh && stateLooksValid) {
    // quick validation: do the shard outpoints still exist?
    const missing = [];
    for (const s of state.shards) {
      try {
        await getPrevOutput(s.txid, s.vout);
      } catch {
        missing.push(`${s.txid}:${s.vout}`);
      }
    }

    if (missing.length === 0) {
      console.log(`\n[0/4] using existing shard state: ${STATE_FILE}`);
      console.log(`      shards: ${state.shards.length}`);
      ensureStateDefaults(state);
      return state;
    }

    console.warn(`\n[0/4] state exists but ${missing.length} shard outpoints missing/spent.`);
    console.warn(`      attempting repair by scanning wallet UTXOs...`);

    const repaired = await tryRepairShardsFromWallet({ state, ownerWallet });
    if (repaired) {
      state = repaired;
      await writeState(state);
      console.log(`      ✅ repaired shard pointers and updated state file.`);
      ensureStateDefaults(state);
      return state;
    }

    console.warn(`      ⚠️ repair failed; falling back to fresh init.`);
  }

  console.log(`\n[1/4] init ${shardCount} shards...`);
  const init = await initShardsTx({ state: null, ownerWallet, ownerPaycodePub33, shardCount, poolVersion });

  state = {
    network: NETWORK,
    ...init,
    stealthUtxos: init.stealthUtxos ?? [],
    deposits: [],
    withdrawals: [],
    createdAt: new Date().toISOString(),
  };

  await writeState(state);
  return state;
}

async function tryRepairShardsFromWallet({ state, ownerWallet }) {
  const redeemScriptHex = state.redeemScriptHex.toLowerCase();
  const categoryHex = state.categoryHex.toLowerCase();

  const utxos = await getUtxos(ownerWallet.address, NETWORK, true);

  const tokenUtxos = utxos.filter((u) => {
    const catHex = toLowerHex(u?.token_data?.category);
    return catHex && catHex === categoryHex;
  });

  if (tokenUtxos.length === 0) return null;

  const matches = [];
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
  const repairedShards = matches.map((m, i) => ({ index: i, ...m }));

  const unknown = repairedShards.filter((s) => s.commitmentHex === 'UNKNOWN').length;
  if (unknown) console.warn(`repair: ${unknown} shard commitments missing; outpoints recovered only.`);

  return {
    ...state,
    shards: repairedShards,
    repairedAt: new Date().toISOString(),
  };
}

// -------------------------------------------------------------------------------------
// Core demo steps
// -------------------------------------------------------------------------------------

async function initShardsTx({ state = null, ownerWallet, ownerPaycodePub33 = null, shardCount, poolVersion }) {
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
  let changeStealthTemplate = null;

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

  const shards = shardCommitments.map((c, i) => ({
    txid,
    vout: i,
    value: SHARD_VALUE.toString(),
    commitmentHex: bytesToHex(c),
  }));

  const stealthUtxos = [];
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
}) {
  ensureStateDefaults(state);

  const amount = BigInt(amountSats);
  if (amount < BigInt(DUST)) throw new Error('deposit amount below dust');

  const senderUtxo = await selectFundingUtxo({
    state,
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

  const outputs = [{ value: amount, scriptPubKey: outSpk }];

  let changeRec = null;
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
    markStealthSpent(state, senderUtxo.txid, senderUtxo.vout, txid);
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
}) {
  ensureStateDefaults(state);

  if (!fresh) {
    const existing = getLatestUnimportedDeposit(state, amountSats);
    if (existing?.txid && existing?.receiverRpaHash160Hex) {
      const unspent = await isP2pkhOutpointUnspent({
        txid: existing.txid,
        vout: existing.vout,
        hash160Hex: existing.receiverRpaHash160Hex,
      });
      if (unspent) {
        state.lastDeposit = existing;
        await writeState(state);
        console.log(`[deposit] reusing existing deposit: ${existing.txid}:${existing.vout}`);
        return existing;
      }
    }
  }

  const { deposit: dep, change } = await createDeposit({
    state,
    senderWallet,
    senderPaycodePub33,
    senderTag,
    receiverPaycodePub33,
    amountSats,
  });

  if (change) upsertStealthUtxo(state, change);

  state.lastDeposit = dep;
  upsertDeposit(state, dep);
  await writeState(state);

  console.log(`[deposit] created new deposit: ${dep.txid}:${dep.vout}`);
  return dep;
}

async function sweepDepositDebug({ depositOutpoint, receiverWallet }) {
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

async function importDepositToShard({ poolState, shardIndex, depositOutpoint, receiverWallet }) {
  const redeemScript = hexToBytes(poolState.redeemScriptHex);
  const category32 = hexToBytes(poolState.categoryHex);

  const shard = poolState.shards[shardIndex];
  if (!shard) throw new Error(`invalid shardIndex ${shardIndex}`);

  const shardPrev = await getPrevOutput(shard.txid, shard.vout);
  const depositPrev = await getPrevOutput(depositOutpoint.txid, depositOutpoint.vout).catch(async (e) => {
    const ageMs = Date.now() - Date.parse(depositOutpoint.createdAt || new Date().toISOString());
    if (ageMs < 5 * 60 * 1000 && depositOutpoint.receiverRpaHash160Hex && depositOutpoint.value) {
      const h160 = hexToBytes(depositOutpoint.receiverRpaHash160Hex);
      return { value: depositOutpoint.value, scriptPubKey: p2pkhLockingBytecode(h160), _fallback: true };
    }
    throw e;
  });

  const shardValue = BigInt(shardPrev.value);
  const depositValue = BigInt(depositPrev.value);
  const fee = DEFAULT_FEE;
  const newShardValue = shardValue + depositValue - fee;
  if (newShardValue < BigInt(DUST)) throw new Error('new shard value below dust');

  const expectedH160 = parseP2pkhHash160(depositPrev.scriptPubKey);
  if (!expectedH160) throw new Error('deposit prevout is not P2PKH (unexpected for demo)');

  const ctx = depositOutpoint.rpaContext;
  if (!ctx?.senderPub33Hex || !ctx?.prevoutHashHex) throw new Error('depositOutpoint missing rpaContext');

  const senderPub33 = hexToBytes(ctx.senderPub33Hex);

  // Preflight logs (do NOT branch on these)
  try {
    const candA = ctx.prevoutHashHex;
    const candB = reverseHex32(ctx.prevoutHashHex);

    const deriveH160 = (prevoutHashHex, normalizeEvenY) => {
      try {
        const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
          receiverWallet.scanPrivBytes ?? receiverWallet.privBytes,
          receiverWallet.spendPrivBytes ?? receiverWallet.privBytes,
          senderPub33,
          prevoutHashHex,
          ctx.prevoutN,
          ctx.index
        );
        const pk = normalizeEvenY ? ensureEvenYPriv(oneTimePriv) : oneTimePriv;
        const { h160 } = pubkeyHashFromPriv(pk);
        return bytesToHex(h160);
      } catch {
        return null;
      }
    };

    console.log('[import-preflight] expected deposit hash160:', bytesToHex(expectedH160));
    console.log('[import-preflight] candidate as-is txid, no evenY:', deriveH160(candA, false));
    console.log('[import-preflight] candidate as-is txid, evenY:', deriveH160(candA, true));
    console.log('[import-preflight] candidate reversed txid, no evenY:', deriveH160(candB, false));
    console.log('[import-preflight] candidate reversed txid, evenY:', deriveH160(candB, true));
  } catch {}

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
    throw new Error(`deposit spend derivation mismatch. expected=${bytesToHex(expectedH160)} derived=${bytesToHex(h160)}`);
  }

  // ---- Locked-in note hash policy (A) ----
  const noteHash32 = outpointHash32(depositOutpoint.txid, depositOutpoint.vout);
  console.log('[import] noteHash32A:', bytesToHex(noteHash32));

  const stateIn32 = hexToBytes(shard.commitmentHex);
  const limbs = []; // placeholder (must match covenant expectations)

  // ---- Locked-in category mode (B) ----
  const stateOut32 = computePoolStateOut({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    stateIn32,
    category32,
    noteHash32,
    limbs,
    categoryMode: 'none',
    capByte: 0x01,
  });

  const proofBlob32 = makeProofBlobV11(noteHash32, 0x50);

  const shardUnlock = buildPoolHashFoldUnlockingBytecode({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    limbs,
    noteHash32,
    proofBlob32,
  });

  const tokenOut = {
    category: category32,
    nft: { capability: 'mutable', commitment: stateOut32 },
  };

  const shardOutSpk = addTokenToScript(tokenOut, redeemScript);

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        txid: shard.txid,
        vout: shard.vout,
        scriptSig: shardUnlock,
        sequence: 0xffffffff,
      },
      {
        txid: depositOutpoint.txid,
        vout: depositOutpoint.vout,
        scriptSig: new Uint8Array(),
        sequence: 0xffffffff,
      },
    ],
    outputs: [{ value: newShardValue, scriptPubKey: shardOutSpk }],
  };

  signInput(tx, 1, oneTimePriv, depositPrev.scriptPubKey, BigInt(depositPrev.value));

  const rawTx = buildRawTx(tx);

  if (typeof parseTx === 'function') {
    const parsed = parseTx(rawTx);
    const out0 = parsed.outputs?.[0];
    const outCommit = out0?.token_data?.nft?.commitment;
    if (!outCommit || bytesToHex(outCommit) !== bytesToHex(stateOut32)) {
      throw new Error('preflight: output commitment mismatch vs computed stateOut');
    }
  }

  const txid = await broadcastTx(rawTx);

  poolState.shards[shardIndex] = {
    txid,
    vout: 0,
    value: newShardValue.toString(),
    commitmentHex: bytesToHex(stateOut32),
  };

  return { txid };
}

async function ensureImport({ state, receiverWallet, shardIndexOpt = null, fresh = false }) {
  ensureStateDefaults(state);

  const dep =
    (state.lastDeposit && !state.lastDeposit.importTxid ? state.lastDeposit : null) ??
    getLatestUnimportedDeposit(state, null);

  if (!dep) {
    console.log('[import] no unimported deposit found; skipping.');
    return null;
  }

  if (!fresh && dep.importTxid) {
    console.log(`[import] already imported (state): ${dep.txid}:${dep.vout} -> tx ${dep.importTxid}`);
    return { txid: dep.importTxid, shardIndex: dep.importedIntoShard };
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

  const shardCount = state.shards.length;
  const noteHash = outpointHash32(dep.txid, dep.vout);
  const derivedIndex = noteHash[0] % shardCount;
  const shardIndex =
    shardIndexOpt == null ? derivedIndex : Math.max(0, Math.min(shardCount - 1, Number(shardIndexOpt)));

  const shardBefore = { ...state.shards[shardIndex] };

  const res = await importDepositToShard({
    poolState: state,
    shardIndex,
    depositOutpoint: dep,
    receiverWallet,
  });

  upsertDeposit(state, {
    ...dep,
    importedIntoShard: shardIndex,
    importTxid: res.txid,
  });

  state.lastImport = {
    txid: res.txid,
    shardIndex,
    deposit: { txid: dep.txid, vout: dep.vout },
    shardBefore,
    shardAfter: { ...state.shards[shardIndex] },
    createdAt: new Date().toISOString(),
  };

  await writeState(state);

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
}) {
  ensureStateDefaults(poolState);

  const redeemScript = hexToBytes(poolState.redeemScriptHex);
  const category32 = hexToBytes(poolState.categoryHex);

  const shard = poolState.shards[shardIndex];
  if (!shard) throw new Error(`Unknown shard index ${shardIndex}`);

  const shardPrev = await getPrevOutput(shard.txid, shard.vout);
  const shardValue = BigInt(shardPrev.value);

  const payment = BigInt(amountSats);
  if (payment < BigInt(DUST)) throw new Error('withdraw amount below dust');
  if (shardValue < payment + BigInt(DUST)) throw new Error('shard value too small for withdraw');

  const newShardValue = shardValue - payment;

  const feeUtxo = await selectFundingUtxo({
    state: poolState,
    wallet: senderWallet,
    ownerTag: senderTag,
    minSats: BigInt(DUST) + 2_000n,
  });
  const feePrev = feeUtxo.prevOut;

  const { intent: payIntent, rpaContext: payContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33,
    prevoutTxidHex: feeUtxo.txid,
    prevoutN: feeUtxo.vout,
    index: 0,
  });
  const paySpk = p2pkhLockingBytecode(payIntent.childHash160);

  const { intent: changeIntent, rpaContext: changeContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33: senderPaycodePub33,
    prevoutTxidHex: feeUtxo.txid,
    prevoutN: feeUtxo.vout,
    index: 1,
  });
  const changeSpk = p2pkhLockingBytecode(changeIntent.childHash160);

  const feeRate = await pickFeeRateOrFallback();
  const estSize = 420; // rough: 2 inputs (1 covenant), 3 outputs
  const fee = BigInt(feeRate) * BigInt(estSize);

  // Placeholder: fold "nullifier-ish" into state
  const nullifier32 = sha256(
    flattenBinArray([hexToBytes(shard.commitmentHex), payIntent.childHash160, sha256(uint32le(amountSats >>> 0))])
  );
  const proofBlob32 = sha256(flattenBinArray([nullifier32, Uint8Array.from([0x02])]));
  const limbs = [];

  const stateIn32 = hexToBytes(shard.commitmentHex);
  const stateOut32 = computePoolStateOut({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    stateIn32,
    category32,
    noteHash32: nullifier32,
    limbs,
    categoryMode: 'none',
    capByte: 0x01,
  });

  const shardUnlock = buildPoolHashFoldUnlockingBytecode({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    limbs,
    noteHash32: nullifier32,
    proofBlob32,
  });

  const tokenOut = { category: category32, nft: { capability: 'mutable', commitment: stateOut32 } };
  const shardOutSpk = addTokenToScript(tokenOut, redeemScript);

  const feeValue = BigInt(feePrev.value);
  let changeValue = feeValue - fee;

  const outputs = [
    { value: newShardValue, scriptPubKey: shardOutSpk },
    { value: payment, scriptPubKey: paySpk },
  ];

  let changeRec = null;
  if (changeValue >= BigInt(DUST)) {
    outputs.push({ value: changeValue, scriptPubKey: changeSpk });

    changeRec = {
      owner: senderTag,
      purpose: 'withdraw_change',
      txid: '<pending>',
      vout: 2,
      value: changeValue.toString(),
      hash160Hex: bytesToHex(changeIntent.childHash160),
      rpaContext: changeContext,
      createdAt: new Date().toISOString(),
    };
  } else {
    changeValue = 0n; // avoid dust output
  }

  const tx = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shard.txid, vout: shard.vout, scriptSig: shardUnlock, sequence: 0xffffffff },
      { txid: feeUtxo.txid, vout: feeUtxo.vout, scriptSig: new Uint8Array(), sequence: 0xffffffff },
    ],
    outputs,
  };

  signInput(tx, 1, feeUtxo.signPrivBytes, feePrev.scriptPubKey, BigInt(feePrev.value));

  const rawTx = buildRawTx(tx);
  const txid = await broadcastTx(rawTx);

  console.log(
    `[withdraw] payment (stealth) -> outpoint ${txid}:1 value=${payment.toString()} sats hash160=${bytesToHex(payIntent.childHash160)}`
  );

  if (changeRec && changeValue > 0n) {
    console.log(
      `[withdraw] change (stealth)  -> outpoint ${txid}:${changeRec.vout} value=${changeValue.toString()} sats hash160=${changeRec.hash160Hex}`
    );
  } else {
    console.log(`[withdraw] change: none (remainder absorbed into fee to avoid dust)`);
  }

  if (feeUtxo.source === 'stealth') markStealthSpent(poolState, feeUtxo.txid, feeUtxo.vout, txid);

  if (changeRec) {
    changeRec.txid = txid;
    upsertStealthUtxo(poolState, changeRec);
  }

  poolState.shards[shardIndex] = {
    txid,
    vout: 0,
    value: newShardValue.toString(),
    commitmentHex: bytesToHex(stateOut32),
  };

  poolState.withdrawals.push({
    txid,
    shardIndex,
    amountSats,
    receiverRpaHash160Hex: bytesToHex(payIntent.childHash160),
    createdAt: new Date().toISOString(),
    rpaContext: payContext,
  });

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
}) {
  ensureStateDefaults(state);

  const receiverPaycodePub33Hex = bytesToHex(receiverPaycodePub33);

  if (!fresh && Array.isArray(state.withdrawals)) {
    for (let i = state.withdrawals.length - 1; i >= 0; i--) {
      const w = state.withdrawals[i];
      if (!w) continue;
      if (w.shardIndex !== shardIndex) continue;
      if (Number(w.amountSats) !== Number(amountSats)) continue;
      if (w.receiverPaycodePub33Hex !== receiverPaycodePub33Hex) continue;

      const cur = state.shards[shardIndex];
      if (cur?.txid === w.shardAfter?.txid && cur?.vout === w.shardAfter?.vout) {
        console.log(`[withdraw] already done (state): tx ${w.txid}`);
        return { txid: w.txid };
      }
      break;
    }
  }

  const shardBefore = { ...state.shards[shardIndex] };

  const res = await withdrawFromShard({
    poolState: state,
    shardIndex,
    amountSats,
    senderWallet,
    senderPaycodePub33,
    senderTag,
    receiverPaycodePub33,
  });

  const shardAfter = { ...state.shards[shardIndex] };

  // Patch the most recent withdrawal entry with idempotence fields
  const last = state.withdrawals[state.withdrawals.length - 1];
  state.withdrawals[state.withdrawals.length - 1] = {
    ...last,
    receiverPaycodePub33Hex,
    shardBefore,
    shardAfter,
  };

  state.lastWithdraw = {
    txid: res.txid,
    shardIndex,
    amountSats,
    receiverPaycodePub33Hex,
    shardBefore,
    shardAfter,
    createdAt: new Date().toISOString(),
  };

  await writeState(state);

  console.log(`[withdraw] withdrew ${amountSats} from shard ${shardIndex} (tx ${res.txid})`);
  return res;
}

// -------------------------------------------------------------------------------------
// Wallet integration helpers (repo-specific)
// -------------------------------------------------------------------------------------

async function loadDemoActors() {
  const wallets = await getWallets();
  const actorABaseWallet = wallets.alice; // existing wallet naming
  const actorBBaseWallet = wallets.bob;

  if (!actorABaseWallet?.pubBytes || !actorBBaseWallet?.pubBytes) {
    throw new Error(`getWallets() returned unexpected shape. Keys: ${Object.keys(wallets ?? {}).join(', ')}`);
  }

  // ✅ paycodes.js expects (alice, bob) wallet args
  const { alicePaycode, bobPaycode } = setupPaycodesAndDerivation(actorABaseWallet, actorBBaseWallet);

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
  .name('demo_sharded_pool')
  .description('Sharded per-user pool demo (Phase 2.5 scaffolding)')
  .option('--pool-version <ver>', 'pool hash-fold version: v1 or v1_1', 'v1_1');

program
  .command('init')
  .option('--shards <n>', 'number of shards', '8')
  .action(async (opts) => {
    assertChipnet();
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

    const state = {
      network: NETWORK,
      ...init,
      deposits: [],
      withdrawals: [],
      createdAt: new Date().toISOString(),
    };

    await writeState(state);

    console.log(`✅ init txid: ${init.txid}`);
    console.log(`   shards: ${shardCount}`);
    console.log(`   state saved: ${STATE_FILE}`);
  });

program
  .command('deposit')
  .option('--amount <sats>', 'deposit amount in sats', '120000')
  .option('--fresh', 'force a new deposit even if one exists', false)
  .action(async (opts) => {
    assertChipnet();
    const amountSats = Number(opts.amount);
    if (!Number.isFinite(amountSats) || amountSats < Number(DUST)) {
      throw new Error(`amount must be >= dust (${DUST})`);
    }

    const state = (await readState()) ?? {};
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

    console.log(`✅ deposit step done (state saved: ${STATE_FILE})`);
  });

program
  .command('import')
  .option('--shard <i>', 'shard index (default: derived from deposit outpoint)', '')
  .option('--fresh', 'force a new import even if already marked imported', false)
  .option('--sweep', 'debug: sweep the deposit UTXO alone (and stop)', false)
  .action(async (opts) => {
    assertChipnet();
    const state = await readState();
    if (!state?.shards?.length) throw new Error(`Run init first (state file missing).`);

    const { actorBBaseWallet } = await loadDemoActors();
    const shardIndexOpt = opts.shard === '' ? null : Number(opts.shard);

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
      await writeState(state);

      console.log('[sweep-debug] sweep done. (import skipped)');
      return;
    }

    await ensureImport({
      state,
      receiverWallet: actorBBaseWallet,
      shardIndexOpt,
      fresh: !!opts.fresh,
    });

    console.log(`✅ import step done (state saved: ${STATE_FILE})`);
  });

program
  .command('withdraw')
  .option('--shard <i>', 'shard index', '0')
  .option('--amount <sats>', 'withdraw amount in sats', '50000')
  .option('--fresh', 'force a new withdrawal even if already recorded', false)
  .action(async (opts) => {
    assertChipnet();
    const state = await readState();
    if (!state?.shards?.length) throw new Error(`Run init first (state file missing).`);

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

    console.log(`✅ withdraw step done (state saved: ${STATE_FILE})`);
  });

program
  .command('run')
  .option('--shards <n>', 'number of shards', '8')
  .option('--deposit <sats>', 'deposit amount', '120000')
  .option('--withdraw <sats>', 'withdraw amount', '50000')
  .option('--fresh', 'force a new init (creates new shards)', false)
  .action(async (opts) => {
    assertChipnet();

    const shardCount = Number(opts.shards);
    const depositSats = Number(opts.deposit);
    const withdrawSats = Number(opts.withdraw);

    if (!Number.isFinite(shardCount) || shardCount < 2) throw new Error('shards must be >= 2');
    if (!Number.isFinite(depositSats) || depositSats < Number(DUST)) throw new Error(`deposit must be >= dust (${DUST})`);
    if (!Number.isFinite(withdrawSats) || withdrawSats < Number(DUST)) throw new Error(`withdraw must be >= dust (${DUST})`);

    const { actorABaseWallet, actorBBaseWallet, actorAPaycodePub33, actorBPaycodePub33 } = await loadDemoActors();

    const poolVersion =
      program.opts().poolVersion === 'v1' ? POOL_HASH_FOLD_VERSION.V1 : POOL_HASH_FOLD_VERSION.V1_1;

    let state = await ensurePoolState({
      ownerWallet: actorBBaseWallet,
      ownerPaycodePub33: actorBPaycodePub33,
      shardCount,
      poolVersion,
      fresh: !!opts.fresh,
    });

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

    console.log(`\n[3/4] import deposit into shard (derived selection)...`);
    const imp = await ensureImport({
      state,
      receiverWallet: actorBBaseWallet,
      shardIndexOpt: null,
      fresh: false,
    });

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

    console.log('\n✅ done');
    console.log(`state saved: ${STATE_FILE}`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error('❌', err?.stack || err?.message || err);
  process.exitCode = 1;
});