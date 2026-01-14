// packages/pool-shards/src/shards.ts

import {
  buildRawTx,
  signInput,
  signCovenantInput,
  addTokenToScript,
  getP2PKHScript,
  getP2SHScript,
  getBobRedeemScript,
} from '@bch-stealth/tx-builder';

import {
  sha256,
  hash160,
  concat,
  hexToBytes,
  bytesToHex,
  reverseBytes,
  uint32le,
} from '@bch-stealth/utils';

import {
  POOL_HASH_FOLD_VERSION,
  computePoolStateOut,
  buildPoolHashFoldUnlockingBytecode,
  makeProofBlobV11,
} from '@bch-stealth/pool-hash-fold';

import {
  getUtxos,
  getPrevoutScriptAndValue,
  broadcastTx,
} from '@bch-stealth/electrum';

import type { PoolConfig, PoolState, Actor } from './types.js';
import type { Prevout } from '@bch-stealth/electrum';

const DUST = 546n; // BCH dust

function outpointHash32(txidHex: string, vout: number): Uint8Array {
  const txidLE = reverseBytes(hexToBytes(txidHex));
  const n = uint32le(vout >>> 0);
  return sha256(concat(txidLE, n));
}

function ensureBytesLen(u8: Uint8Array, n: number, label: string) {
  if (!(u8 instanceof Uint8Array) || u8.length !== n) {
    throw new Error(`${label} must be ${n} bytes`);
  }
}

function toRawHex(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : bytesToHex(raw);
}

function prevoutToSpkAndValue(prev: Prevout): { spk: Uint8Array; value: bigint } {
  return {
    spk: prev.scriptPubKey,
    value: BigInt(prev.value),
  };
}

/**
 * Sign the shard covenant input, then prepend the pool-hash-fold unlocking bytecode
 * (limbs... noteHash32 proofBlob32) before the covenant’s own unlocking pushes.
 *
 * Stack order becomes:
 *   [poolHashFoldUnlock ...] [amountCommitment] [pubkey33] [sig] [redeemScript]
 */
function signShardCovenantWithPrefix(args: {
  tx: any;
  vin: number;
  signerPriv: Uint8Array;

  // prevout
  prevoutValueSats: bigint;
  category32: Uint8Array;
  prevCommitment32: Uint8Array;
  redeemScript: Uint8Array;

  // covenant + fold unlocking data
  poolHashFoldUnlock: Uint8Array;
  amountCommitment: bigint;
}) {
  const {
    tx,
    vin,
    signerPriv,
    prevoutValueSats,
    category32,
    prevCommitment32,
    redeemScript,
    poolHashFoldUnlock,
    amountCommitment,
  } = args;

  // Rebuild the exact prevout locking script (token + P2SH)
  const p2shSpk = getP2SHScript(hash160(redeemScript));
  const tokenPrev = {
    category: category32,
    nft: {
      capability: 'mutable' as const, // keep shard anchors mutable throughout the demo
      commitment: prevCommitment32,
    },
  };
  const prevoutScript = addTokenToScript(tokenPrev, p2shSpk);

  // Let tx-builder produce: amountCommitment, pubkey33, sig, redeemScript
  signCovenantInput(tx, vin, signerPriv, redeemScript, prevoutValueSats, prevoutScript, amountCommitment);

  // Prepend the pool-hash-fold unlocking bytecode
  const base = hexToBytes(tx.inputs[vin].scriptSig);
  tx.inputs[vin].scriptSig = bytesToHex(concat(poolHashFoldUnlock, base));
}

export async function initShards(
  _state: unknown,
  cfg: PoolConfig,
  shardCount: number,
  actor: Actor,
): Promise<PoolState> {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error('shardCount must be a positive integer');
  }

  const shardValue = BigInt(cfg.shardValueSats);

  // Pick a funding UTXO from actor address
  const utxos = await getUtxos(actor.addressCashAddr, cfg.network);
  if (!utxos.length) throw new Error(`No UTXOs for ${actor.addressCashAddr}`);

  // Rough funding target: N shards + fee + dust buffer
  const target = shardValue * BigInt(shardCount) + BigInt(cfg.defaultFeeSats) + DUST;

  const fund = utxos
    .map((u: any) => ({ ...u, value: BigInt(u.value) }))
    .find((u: any) => u.value >= target);

  if (!fund) throw new Error(`No single UTXO large enough to fund ${shardCount} shards`);

  const fundPrev = await getPrevoutScriptAndValue(fund.txid, fund.vout, cfg.network);
  const { spk: fundPrevSpk, value: fundPrevValue } = prevoutToSpkAndValue(fundPrev);

  // Pool id / category
  const poolId = hexToBytes(cfg.poolIdHex); // demo treats this as 20-byte identifier
  const category32 = outpointHash32(fund.txid, fund.vout);
  const categoryHex = bytesToHex(category32);

  // Redeem + P2SH locking script
  const redeemScript = getBobRedeemScript(poolId);
  const redeemScriptHex = bytesToHex(redeemScript);
  const p2shSpk = getP2SHScript(hash160(redeemScript));

  // Build shard outputs (output[0] reserved for change)
  const outputs: any[] = [];

  // Change output placeholder; set value after fee calc
  const changeSpk = getP2PKHScript(hexToBytes(actor.pubkeyHashHex));
  outputs.push({ value: 0n, scriptPubKey: changeSpk });

  const shards: PoolState['shards'] = [];

  for (let i = 0; i < shardCount; i++) {
    // Deterministic initial commitment: H(H(poolId || category || i || shardCount))
    const commitment32 = sha256(
      sha256(concat(poolId, category32, uint32le(i >>> 0), uint32le(shardCount >>> 0))),
    );

    // Use mutable from the start for simplicity (keeps prevout script consistent for signing)
    const tokenOut = {
      category: category32,
      nft: { capability: 'mutable' as const, commitment: commitment32 },
    };

    const shardSpk = addTokenToScript(tokenOut, p2shSpk);
    outputs.push({ value: shardValue, scriptPubKey: shardSpk });

    // vout is i+1 (since vout0 is change)
    shards.push({
      index: i,
      txid: '<pending>',
      vout: i + 1,
      valueSats: shardValue.toString(),
      commitmentHex: bytesToHex(commitment32),
    });
  }

  // Fee handling: keep it simple (cfg.defaultFeeSats)
  const fee = BigInt(cfg.defaultFeeSats);
  const changeValue = fundPrevValue - shardValue * BigInt(shardCount) - fee;
  if (changeValue < DUST) {
    throw new Error(`Insufficient change after fee; got ${changeValue.toString()} sats`);
  }
  outputs[0].value = changeValue;

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [{ txid: fund.txid, vout: fund.vout, sequence: 0xffffffff }],
    outputs,
  };

  // Sign + broadcast (funding input is normal P2PKH)
  signInput(tx, 0, actor.signPrivBytes, fundPrevSpk, fundPrevValue);

  const raw = buildRawTx(tx, { format: 'bytes' });
  const txid = await broadcastTx(toRawHex(raw), cfg.network);

  // finalize shard txids
  for (const s of shards) s.txid = txid;

  return {
    poolIdHex: cfg.poolIdHex,
    poolVersion: cfg.poolVersion,
    shardCount,
    network: cfg.network,
    categoryHex,
    redeemScriptHex,
    shards,
  };
}

export async function importDepositToShard(
  pool: PoolState,
  cfg: PoolConfig,
  shardIndex: number,
  depositTxid: string,
  depositVout: number,
  receiver: Actor,
): Promise<PoolState> {
  const shard = pool.shards[shardIndex];
  if (!shard) throw new Error(`Invalid shardIndex ${shardIndex}`);

  const category32 = hexToBytes(pool.categoryHex);
  const redeemScript = hexToBytes(pool.redeemScriptHex);
  ensureBytesLen(category32, 32, 'category32');

  // Prevouts
  const depositPrev = await getPrevoutScriptAndValue(depositTxid, depositVout, cfg.network);
  const { spk: depositPrevSpk, value: depositPrevValue } = prevoutToSpkAndValue(depositPrev);

  const shardPrevValue = BigInt(shard.valueSats);

  const stateIn32 = hexToBytes(shard.commitmentHex);
  ensureBytesLen(stateIn32, 32, 'stateIn32');

  // demo convention: noteHash32 = outpointHash32(depositOutpoint)
  const noteHash32 = outpointHash32(depositTxid, depositVout);
  const proofBlob32 = makeProofBlobV11(noteHash32);

  // demo convention: limbs = [noteHash32]
  const limbs: Uint8Array[] = [noteHash32];

  const stateOut32 = computePoolStateOut({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    stateIn32,
    category32,
    noteHash32,
    limbs,
    categoryMode: 'reverse',
    capByte: 0x01,
  });

  const shardUnlock = buildPoolHashFoldUnlockingBytecode({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    limbs,
    noteHash32,
    proofBlob32,
  });

  const p2shSpk = getP2SHScript(hash160(redeemScript));
  const tokenOut = { category: category32, nft: { capability: 'mutable' as const, commitment: stateOut32 } };
  const shardOutSpk = addTokenToScript(tokenOut, p2shSpk);

  // Fee model (simple)
  const fee = BigInt(cfg.defaultFeeSats);
  const changeValue = depositPrevValue - fee;
  if (changeValue < DUST) throw new Error(`Deposit too small after fee: ${changeValue.toString()} sats`);

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shard.txid, vout: shard.vout, sequence: 0xffffffff },   // shard covenant input
      { txid: depositTxid, vout: depositVout, sequence: 0xffffffff }, // deposit P2PKH input
    ],
    outputs: [
      // new shard first
      { value: BigInt(cfg.shardValueSats), scriptPubKey: shardOutSpk },
      // change second (back to depositor’s locking script)
      { value: changeValue, scriptPubKey: depositPrevSpk },
    ],
  };

  // covenant spend (prepend pool-hash-fold unlock)
  signShardCovenantWithPrefix({
    tx,
    vin: 0,
    signerPriv: receiver.signPrivBytes,
    prevoutValueSats: shardPrevValue,
    category32,
    prevCommitment32: stateIn32,
    redeemScript,
    poolHashFoldUnlock: shardUnlock,
    amountCommitment: 0n, // demo placeholder: covenant expects a commitment; keep stable
  });

  // deposit spend (P2PKH)
  signInput(tx, 1, receiver.signPrivBytes, depositPrevSpk, depositPrevValue);

  const raw = buildRawTx(tx, { format: 'bytes' });
  const txid = await broadcastTx(toRawHex(raw), cfg.network);

  // update shard state (new shard is vout=0)
  const next = structuredClone(pool) as PoolState;
  next.shards[shardIndex] = {
    ...shard,
    txid,
    vout: 0,
    commitmentHex: bytesToHex(stateOut32),
  };
  return next;
}

export async function withdrawFromShard(
  pool: PoolState,
  cfg: PoolConfig,
  shardIndex: number,
  receiverP2pkhHash160Hex: string,
  amountSats: number,
  sender: Actor,
): Promise<PoolState> {
  const shard = pool.shards[shardIndex];
  if (!shard) throw new Error(`Invalid shardIndex ${shardIndex}`);
  if (!Number.isInteger(amountSats) || amountSats <= 0) throw new Error('amountSats must be positive');

  const category32 = hexToBytes(pool.categoryHex);
  const redeemScript = hexToBytes(pool.redeemScriptHex);
  ensureBytesLen(category32, 32, 'category32');

  const shardPrevValue = BigInt(shard.valueSats);

  // pick a fee utxo from sender address (not the shard itself)
  const utxos = await getUtxos(sender.addressCashAddr, cfg.network);
  const feeUtxo = utxos.find((u: any) => !(u.txid === shard.txid && u.vout === shard.vout));
  if (!feeUtxo) throw new Error('No fee UTXO available');

  const feePrev = await getPrevoutScriptAndValue(feeUtxo.txid, feeUtxo.vout, cfg.network);
  const { spk: feePrevSpk, value: feePrevValue } = prevoutToSpkAndValue(feePrev);

  const payment = BigInt(amountSats);
  if (payment < DUST) throw new Error('payment is dust');

  const fee = BigInt(cfg.defaultFeeSats);
  const changeValue = feePrevValue - fee;
  if (changeValue < DUST) throw new Error('fee utxo too small for fee');

  // “nullifier-ish” state update (demo placeholder)
  const stateIn32 = hexToBytes(shard.commitmentHex);
  const receiverHash160 = hexToBytes(receiverP2pkhHash160Hex);
  ensureBytesLen(stateIn32, 32, 'stateIn32');
  ensureBytesLen(receiverHash160, 20, 'receiverHash160');

  const nullifier32 = sha256(concat(stateIn32, receiverHash160, sha256(uint32le(amountSats >>> 0))));
  const proofBlob32 = sha256(concat(nullifier32, Uint8Array.of(0x02)));
  const limbs: Uint8Array[] = [];

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

  const p2shSpk = getP2SHScript(hash160(redeemScript));
  const tokenOut = { category: category32, nft: { capability: 'mutable' as const, commitment: stateOut32 } };
  const shardOutSpk = addTokenToScript(tokenOut, p2shSpk);

  const paySpk = getP2PKHScript(receiverHash160);
  const changeSpk = getP2PKHScript(hexToBytes(sender.pubkeyHashHex));

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shard.txid, vout: shard.vout, sequence: 0xffffffff },          // shard covenant input
      { txid: feeUtxo.txid, vout: feeUtxo.vout, sequence: 0xffffffff },      // fee P2PKH input
    ],
    outputs: [
      { value: BigInt(cfg.shardValueSats), scriptPubKey: shardOutSpk },       // new shard anchor
      { value: payment, scriptPubKey: paySpk },                               // payment
      { value: changeValue, scriptPubKey: changeSpk },                        // fee change
    ],
  };

  // covenant spend (prepend pool-hash-fold unlock)
  signShardCovenantWithPrefix({
    tx,
    vin: 0,
    signerPriv: sender.signPrivBytes,
    prevoutValueSats: shardPrevValue,
    category32,
    prevCommitment32: stateIn32,
    redeemScript,
    poolHashFoldUnlock: shardUnlock,
    amountCommitment: 0n, // demo placeholder
  });

  // fee spend (P2PKH)
  signInput(tx, 1, sender.signPrivBytes, feePrevSpk, feePrevValue);

  const raw = buildRawTx(tx, { format: 'bytes' });
  const txid = await broadcastTx(toRawHex(raw), cfg.network);

  const next = structuredClone(pool) as PoolState;
  next.shards[shardIndex] = {
    ...shard,
    txid,
    vout: 0,
    commitmentHex: bytesToHex(stateOut32),
  };
  return next;
}