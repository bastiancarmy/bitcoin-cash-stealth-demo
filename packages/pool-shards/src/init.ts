// packages/pool-shards/src/init.ts
import type { BuilderDeps } from './di.js';

import { bytesToHex, hexToBytes } from '@bch-stealth/utils';
import { DUST_SATS, deriveCategory32FromFundingTxidHex, initialShardCommitment32 } from './policy.js';

import type {
  InitShardsResult,
  PoolConfig,
  WalletLike,
  PoolState,
  PrevoutLike,
  InitShardsDiagnostics,
} from './types.js';

import {
  asBigInt,
  ensureBytesLen,
  normalizeRawTxBytes,
  resolveBuilderDeps,
  makeShardTokenOut,
} from './shard_common.js';

export function initShardsTx(args: {
  cfg: PoolConfig;
  shardCount: number;
  funding: PrevoutLike;
  ownerWallet: WalletLike;
  deps?: BuilderDeps;
}): InitShardsResult {
  const { cfg, shardCount, funding, ownerWallet, deps } = args;
  const { txb, locking } = resolveBuilderDeps(deps);

  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error('initShardsTx: shardCount must be a positive integer');
  }

  const poolId = hexToBytes(cfg.poolIdHex);
  ensureBytesLen(poolId, 20, 'poolId');

  const shardValue = asBigInt(cfg.shardValueSats, 'cfg.shardValueSats');
  const fee = asBigInt(cfg.defaultFeeSats, 'cfg.defaultFeeSats');

  const category32 = deriveCategory32FromFundingTxidHex(funding.txid);
  const categoryHex = bytesToHex(category32);

  // Prefer explicit redeemScript from config; otherwise require an injected factory.
  const redeemScript =
    cfg.redeemScriptHex
      ? hexToBytes(cfg.redeemScriptHex)
      : deps?.redeemScriptFactory
        ? deps.redeemScriptFactory(poolId)
        : null;

  if (!redeemScript) {
    throw new Error(
      `initShardsTx: missing redeemScript.\n` +
        `Provide cfg.redeemScriptHex or deps.redeemScriptFactory(poolId).`
    );
  }

  const redeemScriptHex = bytesToHex(redeemScript);

  const changeHash160 = hexToBytes(ownerWallet.pubkeyHash160Hex);
  ensureBytesLen(changeHash160, 20, 'ownerWallet.pubkeyHash160Hex');

  const changeSpk = locking.p2pkh(changeHash160);

  // output[0] = change; outputs[1..] = shard anchors
  const outputs: any[] = [{ value: 0n, scriptPubKey: changeSpk }];

  const shards: PoolState['shards'] = [];
  const shardCommitmentsHex: string[] = [];

  for (let i = 0; i < shardCount; i++) {
    const commitment32 = initialShardCommitment32({
      poolId,
      category32,
      shardIndex: i,
      shardCount,
    });

    const tokenOut = makeShardTokenOut({ category32, commitment32 });
    const shardSpk = locking.shardLock({ token: tokenOut, redeemScript });

    outputs.push({ value: shardValue, scriptPubKey: shardSpk });

    const commitmentHex = bytesToHex(commitment32);
    shardCommitmentsHex.push(commitmentHex);

    shards.push({
      index: i,
      txid: '<pending>',
      vout: i + 1,
      valueSats: shardValue.toString(),
      commitmentHex,
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

  // funding input is P2PKH (init currently signs directly)
  txb.signInput(tx, 0, ownerWallet.signPrivBytes, funding.scriptPubKey, funding.valueSats);

  const rawAny = txb.buildRawTx(tx, { format: 'bytes' });
  const rawTx = normalizeRawTxBytes(rawAny);
  const sizeBytes = rawTx.length;

  const poolState: PoolState = {
    poolIdHex: cfg.poolIdHex,
    poolVersion: cfg.poolVersion,
    shardCount,
    network: cfg.network,
    categoryHex,
    redeemScriptHex,
    shards,
  };

  const diagnostics: InitShardsDiagnostics = {
    fundingOutpoint: { txid: funding.txid, vout: funding.vout },
    category32Hex: categoryHex,
    poolIdHex: cfg.poolIdHex,
    poolVersion: cfg.poolVersion,
    shardCount,
    shardValueSats: shardValue.toString(),
    feeSats: fee.toString(),
    changeSats: changeValue.toString(),
    redeemScriptHex,
    shardCommitmentsHex,
    policy: {
      categoryDerivation: 'fundingTxid',
      initialCommitment: 'H(H(poolId||category32||i||shardCount))',
    },
  };

  return {
    tx,
    rawTx,
    sizeBytes,
    diagnostics,
    poolState, // back-compat
    nextPoolState: poolState,
  };
}