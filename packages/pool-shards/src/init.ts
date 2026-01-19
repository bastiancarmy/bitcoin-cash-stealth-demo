// packages/pool-shards/src/init.ts
import type { BuilderDeps } from './di.js';

import { bytesToHex, hexToBytes } from '@bch-stealth/utils';

import {
  asBigInt,
  ensureBytesLen,
  normalizeRawTxBytes,
  resolveBuilderDeps,
  appendWitnessInput,
  makeShardTokenOut,
} from './shard_common.js';

import { DUST_SATS, deriveCategory32FromFundingTxidHex, initialShardCommitment32 } from './policy.js';

import type {
  InitShardsResult,
  PoolConfig,
  WalletLike,
  PoolState,
  PrevoutLike,
  InitShardsDiagnostics,
} from './types.js';

export function initShardsTx(args: {
  cfg: PoolConfig;
  shardCount: number;
  funding: PrevoutLike;
  ownerWallet: WalletLike;

  // Optional “proof/witness carrier” input, appended last when provided
  witnessPrevout?: PrevoutLike;
  witnessPrivBytes?: Uint8Array;

  deps?: BuilderDeps;
}): InitShardsResult {
  const { cfg, shardCount, funding, ownerWallet, witnessPrevout, witnessPrivBytes, deps } = args;

  const { txb, auth, locking } = resolveBuilderDeps(deps);

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

  // change output
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
  const changeValue = asBigInt(funding.valueSats as any, 'funding.valueSats') - totalShardValue - fee;

  if (changeValue < DUST_SATS) {
    throw new Error(
      `initShardsTx: insufficient change after fee; got ${changeValue.toString()} sats`
    );
  }
  outputs[0].value = changeValue;

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [{ txid: funding.txid, vout: funding.vout, sequence: 0xffffffff }],
    outputs,
  };

  // If present, append witness input LAST before any signing (stable ordering).
  const { witnessVin, witnessPrevoutCtx } = appendWitnessInput(tx, witnessPrevout);

  // Funding input is P2PKH — route through AuthProvider for consistency
  auth.authorizeP2pkhInput({
    tx,
    vin: 0,
    privBytes: ownerWallet.signPrivBytes,
    prevout: {
      valueSats: asBigInt(funding.valueSats as any, 'funding.valueSats'),
      scriptPubKey: funding.scriptPubKey as Uint8Array,
    },
    witnessVin,
    witnessPrevout: witnessPrevoutCtx,
  });

  // Optional witness signing (same “sign if priv provided” convention as import/withdraw)
  if (witnessVin !== undefined && witnessPrevoutCtx && witnessPrivBytes) {
    auth.authorizeP2pkhInput({
      tx,
      vin: witnessVin,
      privBytes: witnessPrivBytes,
      prevout: {
        valueSats: witnessPrevoutCtx.valueSats,
        scriptPubKey: witnessPrevoutCtx.scriptPubKey,
      },
      witnessVin,
      witnessPrevout: witnessPrevoutCtx,
    });
  }

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