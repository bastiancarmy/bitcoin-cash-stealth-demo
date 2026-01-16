// packages/pool-shards/src/withdraw.ts

import {
  buildRawTx,
  signInput,
  signCovenantInput,
  addTokenToScript,
  getP2PKHScript,
  getP2SHScript,
} from '@bch-stealth/tx-builder';

import { bytesToHex, concat, hexToBytes, hash160, sha256, uint32le } from '@bch-stealth/utils';

import {
  DEFAULT_CAP_BYTE,
  DEFAULT_CATEGORY_MODE,
  DEFAULT_POOL_HASH_FOLD_VERSION,
  DUST_SATS,
} from './policy.js';

import { computePoolStateOut, buildPoolHashFoldUnlockingBytecode } from '@bch-stealth/pool-hash-fold';

import type {
  PoolState,
  PrevoutLike,
  WalletLike,
  WithdrawResult,
  CategoryMode,
  WithdrawDiagnostics,
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

export function withdrawFromShard(args: {
  pool: PoolState;
  shardIndex: number;

  shardPrevout: PrevoutLike;
  feePrevout: PrevoutLike;

  senderWallet: WalletLike;

  receiverP2pkhHash160Hex: string;
  amountSats: bigint | number;

  // optional overrides
  feeSats?: bigint | number | string;
  categoryMode?: CategoryMode;
  amountCommitment?: bigint | number;
}): WithdrawResult {
  const {
    pool,
    shardIndex,
    shardPrevout,
    feePrevout,
    senderWallet,
    receiverP2pkhHash160Hex,
    amountSats,
    feeSats,
    categoryMode,
    amountCommitment,
  } = args;

  const shard = pool.shards[shardIndex];
  if (!shard) throw new Error(`withdrawFromShard: invalid shardIndex ${shardIndex}`);

  const category32 = hexToBytes(pool.categoryHex);
  const redeemScript = hexToBytes(pool.redeemScriptHex);
  ensureBytesLen(category32, 32, 'category32');

  const stateIn32 = hexToBytes(shard.commitmentHex);
  ensureBytesLen(stateIn32, 32, 'stateIn32');

  const receiverHash160 = hexToBytes(receiverP2pkhHash160Hex);
  ensureBytesLen(receiverHash160, 20, 'receiverHash160');

  const payment = asBigInt(amountSats, 'amountSats');
  if (payment < DUST_SATS) throw new Error('withdrawFromShard: payment is dust');

  const fee = feeSats !== undefined ? asBigInt(feeSats, 'feeSats') : 0n;
  const changeValue = feePrevout.valueSats - fee;
  if (changeValue < DUST_SATS) throw new Error('withdrawFromShard: fee prevout too small after fee');

  // deterministic “nullifier-ish” update (no electrum required)
  const nullifier32 = sha256(
    concat(
      stateIn32,
      receiverHash160,
      sha256(uint32le(Number(payment & 0xffffffffn))),
    ),
  );

  const limbs: Uint8Array[] = [];
  const proofBlob32 = sha256(concat(nullifier32, Uint8Array.of(0x02)));

  const effectiveCategoryMode = categoryMode ?? DEFAULT_CATEGORY_MODE;

  const stateOut32 = computePoolStateOut({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    stateIn32,
    category32,
    noteHash32: nullifier32,
    limbs,
    categoryMode: effectiveCategoryMode,
    capByte: DEFAULT_CAP_BYTE,
  });

  const shardUnlockPrefix = buildPoolHashFoldUnlockingBytecode({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    limbs,
    noteHash32: nullifier32,
    proofBlob32,
  });

  const p2shSpk = getP2SHScript(hash160(redeemScript));
  const tokenOut = {
    category: category32,
    nft: { capability: 'mutable' as const, commitment: stateOut32 },
  };
  const shardOutSpk = addTokenToScript(tokenOut, p2shSpk);

  const paySpk = getP2PKHScript(receiverHash160);
  const changeSpk = getP2PKHScript(hexToBytes(senderWallet.pubkeyHash160Hex));

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shardPrevout.txid, vout: shardPrevout.vout, sequence: 0xffffffff }, // covenant
      { txid: feePrevout.txid, vout: feePrevout.vout, sequence: 0xffffffff }, // fee P2PKH
    ],
    outputs: [
      { value: asBigInt(shard.valueSats, 'shard.valueSats'), scriptPubKey: shardOutSpk },
      { value: payment, scriptPubKey: paySpk },
      { value: changeValue, scriptPubKey: changeSpk },
    ],
  };

  // covenant spend
  signCovenantInput(
    tx,
    0,
    senderWallet.signPrivBytes,
    redeemScript,
    shardPrevout.valueSats,
    shardPrevout.scriptPubKey ?? p2shSpk,
    amountCommitment ?? 0n,
  );

  // prepend pool-hash-fold unlock prefix
  const base = hexToBytes(tx.inputs[0].scriptSig);
  tx.inputs[0].scriptSig = bytesToHex(new Uint8Array([...shardUnlockPrefix, ...base]));

  // fee spend
  signInput(tx, 1, senderWallet.signPrivBytes, feePrevout.scriptPubKey, feePrevout.valueSats);

  const rawAny = buildRawTx(tx, { format: 'bytes' });
  const rawTx = normalizeRawTxBytes(rawAny);
  const sizeBytes = rawTx.length;

  const nextPoolState: PoolState = structuredClone(pool) as PoolState;
  nextPoolState.shards[shardIndex] = {
    ...shard,
    txid: '<pending>',
    vout: 0,
    commitmentHex: bytesToHex(stateOut32),
  };

  const diagnostics: WithdrawDiagnostics = {
    shardIndex,
    receiverHash160Hex: receiverP2pkhHash160Hex,
    amountSats: payment.toString(),
    feeSats: fee.toString(),
    changeSats: changeValue.toString(),
    category32Hex: bytesToHex(category32),
    stateIn32Hex: bytesToHex(stateIn32),
    stateOut32Hex: bytesToHex(stateOut32),
    noteHash32Hex: bytesToHex(nullifier32),
    limbsHex: limbs.map(bytesToHex),
    policy: {
      poolHashFoldVersion: 'V1_1',
      categoryMode: effectiveCategoryMode,
      capByte: DEFAULT_CAP_BYTE,
    },
  };

  return { tx, rawTx, sizeBytes, diagnostics, nextPoolState };
}