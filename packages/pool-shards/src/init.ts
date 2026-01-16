import {
  buildRawTx,
  signInput,
  addTokenToScript,
  getP2PKHScript,
  getP2SHScript,
  getBobRedeemScript,
} from '@bch-stealth/tx-builder';

import { bytesToHex, hexToBytes, hash160 } from '@bch-stealth/utils';

import {
  DUST_SATS,
  deriveCategory32FromFundingTxidHex,
  initialShardCommitment32,
} from './policy.js';

import type { InitShardsResult, PoolConfig, WalletLike, PoolState, PrevoutLike } from './types.js';

function asBigInt(v: number | string | bigint, label: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v);
  throw new Error(`${label} must be number|string|bigint`);
}

function ensureBytesLen(u8: Uint8Array, n: number, label: string) {
  if (!(u8 instanceof Uint8Array) || u8.length !== n) throw new Error(`${label} must be ${n} bytes`);
}

function normalizeRawTxBytes(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  // buildRawTx normally returns hex if not bytes; but we always request bytes.
  // Still handle union defensively.
  return hexToBytes(raw);
}

export function initShardsTx(args: {
  cfg: PoolConfig;
  shardCount: number;
  funding: PrevoutLike;
  ownerWallet: WalletLike;
}): InitShardsResult {
  const { cfg, shardCount, funding, ownerWallet } = args;

  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error('initShardsTx: shardCount must be a positive integer');
  }

  const poolId = hexToBytes(cfg.poolIdHex);
  ensureBytesLen(poolId, 20, 'poolId');

  const shardValue = asBigInt(cfg.shardValueSats, 'cfg.shardValueSats');
  const fee = asBigInt(cfg.defaultFeeSats, 'cfg.defaultFeeSats');

  const category32 = deriveCategory32FromFundingTxidHex(funding.txid);
  const categoryHex = bytesToHex(category32);

  const redeemScript = getBobRedeemScript(poolId);
  const redeemScriptHex = bytesToHex(redeemScript);

  const p2shSpk = getP2SHScript(hash160(redeemScript));
  const changeSpk = getP2PKHScript(hexToBytes(ownerWallet.pubkeyHash160Hex));

  // output[0] = change; outputs[1..] = shard anchors
  const outputs: any[] = [{ value: 0n, scriptPubKey: changeSpk }];

  const shards: PoolState['shards'] = [];

  for (let i = 0; i < shardCount; i++) {
    const commitment32 = initialShardCommitment32({
      poolId,
      category32,
      shardIndex: i,
      shardCount,
    });

    const tokenOut = {
      category: category32,
      nft: { capability: 'mutable' as const, commitment: commitment32 },
    };

    const shardSpk = addTokenToScript(tokenOut, p2shSpk);
    outputs.push({ value: shardValue, scriptPubKey: shardSpk });

    shards.push({
      index: i,
      txid: '<pending>',
      vout: i + 1,
      valueSats: shardValue.toString(),
      commitmentHex: bytesToHex(commitment32),
    });
  }

  const totalShardValue = shardValue * BigInt(shardCount);
  const changeValue = funding.valueSats - totalShardValue - fee;

  if (changeValue < DUST_SATS) {
    throw new Error(`initShardsTx: insufficient change after fee; got ${changeValue.toString()} sats`);
  }
  outputs[0].value = changeValue;

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [{ txid: funding.txid, vout: funding.vout, sequence: 0xffffffff }],
    outputs,
  };

  // funding input is P2PKH
  signInput(tx, 0, ownerWallet.signPrivBytes, funding.scriptPubKey, funding.valueSats);

  const rawAny = buildRawTx(tx, { format: 'bytes' });
  const rawTx = normalizeRawTxBytes(rawAny);

  const poolState: PoolState = {
    poolIdHex: cfg.poolIdHex,
    poolVersion: cfg.poolVersion,
    shardCount,
    network: cfg.network,
    categoryHex,
    redeemScriptHex,
    shards,
  };

  return { tx, rawTx, poolState };
}