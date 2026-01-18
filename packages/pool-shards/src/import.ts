// packages/pool-shards/src/import.ts
import type { BuilderDeps } from './di.js';

import * as txbDefault from '@bch-stealth/tx-builder';
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

import type {
  ImportDepositResult,
  PoolState,
  PrevoutLike,
  WalletLike,
  CategoryMode,
  ImportDepositDiagnostics,
} from './types.js';

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

  deps?: BuilderDeps;
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
    deps,
  } = args;

  const txb = deps?.txb ?? txbDefault;

  const shard = pool.shards[shardIndex];
  if (!shard) throw new Error(`importDepositToShard: invalid shardIndex ${shardIndex}`);

  const category32 = hexToBytes(pool.categoryHex);
  const redeemScript = hexToBytes(pool.redeemScriptHex);
  ensureBytesLen(category32, 32, 'category32');

  const stateIn32 = hexToBytes(shard.commitmentHex);
  ensureBytesLen(stateIn32, 32, 'stateIn32');

  const fee = feeSats !== undefined ? asBigInt(feeSats, 'feeSats') : 0n;

  const shardValueIn = asBigInt(shardPrevout.valueSats, 'shardPrevout.valueSats');
  const depositValueIn = asBigInt(depositPrevout.valueSats, 'depositPrevout.valueSats');
  
  const newShardValue = shardValueIn + depositValueIn - fee;
  
  if (newShardValue < DUST_SATS) {
    throw new Error(`importDepositToShard: new shard value below dust; got ${newShardValue.toString()} sats`);
  }

  // noteHash = outpointHash32(deposit outpoint)
  const noteHash32 = outpointHash32(depositPrevout.txid, depositPrevout.vout);
  const proofBlob32 = makeProofBlobV11(noteHash32);

  // demo convention: limbs = [noteHash32]
  const limbs: Uint8Array[] = [noteHash32];

  const effectiveCategoryMode = categoryMode ?? DEFAULT_CATEGORY_MODE;

  const stateOut32 = computePoolStateOut({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    stateIn32,
    category32,
    noteHash32,
    limbs,
    categoryMode: effectiveCategoryMode,
    capByte: DEFAULT_CAP_BYTE,
  });

  const shardUnlockPrefix = buildPoolHashFoldUnlockingBytecode({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    limbs,
    noteHash32,
    proofBlob32,
  });

  // shard output locking script: token + P2SH(redeemScript)
  const p2shSpk = txb.getP2SHScript(hash160(redeemScript));
  const tokenOut = {
    category: category32,
    nft: { capability: 'mutable' as const, commitment: stateOut32 },
  };
  const shardOutSpk = txb.addTokenToScript(tokenOut, p2shSpk);

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shardPrevout.txid, vout: shardPrevout.vout, sequence: 0xffffffff }, // covenant
      { txid: depositPrevout.txid, vout: depositPrevout.vout, sequence: 0xffffffff }, // deposit P2PKH
    ],
    outputs: [{ value: newShardValue, scriptPubKey: shardOutSpk }],
  };

  // covenant unlocking: signCovenantInput(tx, idx, priv, redeem, value, rawPrevScript, amount, [hashtype])
  txb.signCovenantInput(
    tx,
    0,
    ownerWallet.signPrivBytes,
    redeemScript,
    shardPrevout.valueSats,
    shardPrevout.scriptPubKey ?? p2shSpk,
    amountCommitment ?? 0n,
  );

  // prepend pool-hash-fold unlock prefix to the covenant scriptSig
  const base = hexToBytes(tx.inputs[0].scriptSig);
  tx.inputs[0].scriptSig = bytesToHex(new Uint8Array([...shardUnlockPrefix, ...base]));

  // sign deposit spend
  txb.signInput(tx, 1, ownerWallet.signPrivBytes, depositPrevout.scriptPubKey, depositPrevout.valueSats);

  const rawAny = txb.buildRawTx(tx, { format: 'bytes' });
  const rawTx = normalizeRawTxBytes(rawAny);
  const sizeBytes = rawTx.length;

  const nextPoolState: PoolState = structuredClone(pool) as PoolState;
  nextPoolState.shards[shardIndex] = {
    ...shard,
    txid: '<pending>',
    vout: 0,
    valueSats: newShardValue.toString(),
    commitmentHex: bytesToHex(stateOut32),
  };

  const diagnostics: ImportDepositDiagnostics = {
    shardIndex,
    depositOutpoint: { txid: depositPrevout.txid, vout: depositPrevout.vout },
    category32Hex: bytesToHex(category32),
    stateIn32Hex: bytesToHex(stateIn32),
    stateOut32Hex: bytesToHex(stateOut32),
    noteHash32Hex: bytesToHex(noteHash32),
    limbsHex: limbs.map(bytesToHex),
    feeSats: fee.toString(),
    shardValueInSats: shardValueIn.toString(),
    depositValueInSats: depositValueIn.toString(),
    newShardValueSats: newShardValue.toString(),
    policy: {
      poolHashFoldVersion: 'V1_1',
      categoryMode: effectiveCategoryMode,
      capByte: DEFAULT_CAP_BYTE,
    },
  };

  return { tx, rawTx, sizeBytes, diagnostics, nextPoolState };
}