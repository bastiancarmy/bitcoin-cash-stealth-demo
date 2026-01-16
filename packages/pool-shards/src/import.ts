import {
  buildRawTx,
  signInput,
  signCovenantInput,
  addTokenToScript,
  getP2SHScript,
} from '@bch-stealth/tx-builder';

import { bytesToHex, hexToBytes, hash160 } from '@bch-stealth/utils';

import {
  DEFAULT_CAP_BYTE,
  DEFAULT_CATEGORY_MODE,
  DEFAULT_POOL_HASH_FOLD_VERSION,
  DUST_SATS,
  outpointHash32,
} from './policy.js';

import {
  computePoolStateOut,
  buildPoolHashFoldUnlockingBytecode,
  makeProofBlobV11,
} from '@bch-stealth/pool-hash-fold';

import type { ImportDepositResult, PoolState, PrevoutLike, WalletLike, CategoryMode } from './types.js';

function ensureBytesLen(u8: Uint8Array, n: number, label: string) {
  if (!(u8 instanceof Uint8Array) || u8.length !== n) throw new Error(`${label} must be ${n} bytes`);
}

function asBigInt(v: number | string | bigint, label: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v);
  throw new Error(`${label} must be number|string|bigint`);
}

function normalizeRawTxBytes(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  return hexToBytes(raw);
}

export function importDepositToShard(args: {
  pool: PoolState;
  shardIndex: number;

  shardPrevout: PrevoutLike;
  depositPrevout: PrevoutLike;

  ownerWallet: WalletLike;

  // optional overrides
  feeSats?: bigint | number | string;
  categoryMode?: CategoryMode;
  amountCommitment?: bigint | number;
}): ImportDepositResult {
  const {
    pool,
    shardIndex,
    shardPrevout,
    depositPrevout,
    ownerWallet,
    feeSats,
    categoryMode,
    amountCommitment,
  } = args;

  const shard = pool.shards[shardIndex];
  if (!shard) throw new Error(`importDepositToShard: invalid shardIndex ${shardIndex}`);

  const category32 = hexToBytes(pool.categoryHex);
  const redeemScript = hexToBytes(pool.redeemScriptHex);
  ensureBytesLen(category32, 32, 'category32');

  const stateIn32 = hexToBytes(shard.commitmentHex);
  ensureBytesLen(stateIn32, 32, 'stateIn32');

  const fee = feeSats !== undefined ? asBigInt(feeSats, 'feeSats') : 0n;
  const changeValue = depositPrevout.valueSats - fee;
  if (changeValue < DUST_SATS) {
    throw new Error(`importDepositToShard: deposit too small after fee; got ${changeValue.toString()} sats`);
  }

  // noteHash = outpointHash32(deposit outpoint)  // txid as-is
  const noteHash32 = outpointHash32(depositPrevout.txid, depositPrevout.vout);
  const proofBlob32 = makeProofBlobV11(noteHash32);

  // demo convention: limbs = [noteHash32]
  const limbs: Uint8Array[] = [noteHash32];

  const stateOut32 = computePoolStateOut({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    stateIn32,
    category32,
    noteHash32,
    limbs,
    categoryMode: categoryMode ?? DEFAULT_CATEGORY_MODE,
    capByte: DEFAULT_CAP_BYTE,
  });

  const shardUnlockPrefix = buildPoolHashFoldUnlockingBytecode({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    limbs,
    noteHash32,
    proofBlob32,
  });

  // shard output locking script: token  P2SH(redeemScript)
  const p2shSpk = getP2SHScript(hash160(redeemScript));
  const tokenOut = {
    category: category32,
    nft: { capability: 'mutable' as const, commitment: stateOut32 },
  };
  const shardOutSpk = addTokenToScript(tokenOut, p2shSpk);

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shardPrevout.txid, vout: shardPrevout.vout, sequence: 0xffffffff },        // covenant
      { txid: depositPrevout.txid, vout: depositPrevout.vout, sequence: 0xffffffff },    // deposit P2PKH
    ],
    outputs: [
      { value: asBigInt(pool.shards[shardIndex].valueSats, 'shard.valueSats'), scriptPubKey: shardOutSpk },
      { value: changeValue, scriptPubKey: depositPrevout.scriptPubKey },
    ],
  };

  // covenant unlocking: prefix  covenant pushes
  // NOTE: tx-builder signCovenantInput expects amountCommitment argument.
   signCovenantInput(
       tx, 0, ownerWallet.signPrivBytes, redeemScript,
       shardPrevout.valueSats,
       shardPrevout.scriptPubKey ?? p2shSpk,
       amountCommitment ?? 0n
     );

  // prepend pool-hash-fold unlock prefix to the covenant scriptSig
  const base = hexToBytes(tx.inputs[0].scriptSig);
  tx.inputs[0].scriptSig = bytesToHex(new Uint8Array([...shardUnlockPrefix, ...base]));

  // sign deposit spend
  signInput(tx, 1, ownerWallet.signPrivBytes, depositPrevout.scriptPubKey, depositPrevout.valueSats);

  const rawAny = buildRawTx(tx, { format: 'bytes' });
  const rawTx = normalizeRawTxBytes(rawAny);

  const nextPoolState: PoolState = structuredClone(pool) as PoolState;
  nextPoolState.shards[shardIndex] = {
    ...shard,
    txid: '<pending>',
    vout: 0,
    commitmentHex: bytesToHex(stateOut32),
  };

  return { tx, rawTx, nextPoolState };
}