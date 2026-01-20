// packages/cli/src/pool/ops/withdraw.ts
import type { PoolState, StealthUtxoRecord } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, upsertStealthUtxo, markStealthSpent } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex } from '@bch-stealth/utils';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../state.js';
import { toPoolShardsState, patchShardFromNextPoolState } from '../adapters.js';
import { deriveStealthP2pkhLock } from '../stealth.js';

export async function runWithdraw(
  ctx: PoolOpContext,
  opts: {
    shardIndex: number;
    amountSats: number;
    fresh?: boolean;
  }
): Promise<{ txid: string }> {
  const { shardIndex, amountSats } = opts;

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);

  if (!st.categoryHex || !st.redeemScriptHex) {
    throw new Error('State missing redeemScriptHex/categoryHex. Run init first or repair state.');
  }

  const shard = st.shards[shardIndex];
  if (!shard) throw new Error(`Unknown shard index ${shardIndex}`);

  const shardPrev = await ctx.chainIO.getPrevOutput(shard.txid, shard.vout);

  const payment = BigInt(amountSats);
  if (payment < BigInt(ctx.config.DUST)) throw new Error('withdraw amount below dust');

  const senderTag = 'B';
  const senderWallet = ctx.actors.actorBBaseWallet;

  const feeUtxo = await selectFundingUtxo({
    state: st,
    wallet: senderWallet,
    ownerTag: senderTag,
    minSats: BigInt(ctx.config.DUST) + 2_000n,
    chainIO: ctx.chainIO,
    getUtxos: ctx.getUtxos,
    network: ctx.network,
    dustSats: BigInt(ctx.config.DUST),
  });

  const feePrevouts = {
    chain: feeUtxo.prevOut,
    shards: {
      txid: feeUtxo.txid,
      vout: feeUtxo.vout,
      valueSats: BigInt(feeUtxo.prevOut.value),
      scriptPubKey: feeUtxo.prevOut.scriptPubKey,
    } satisfies PoolShards.PrevoutLike,
  };

  const changeValueSats = String(BigInt(feePrevouts.chain.value) - BigInt(ctx.config.DEFAULT_FEE));

  const { intent: payIntent, rpaContext: payContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33: ctx.actors.actorAPaycodePub33, // receiver is A in demo withdraw flow (adjust if yours differs)
    prevoutTxidHex: feeUtxo.txid,
    prevoutN: feeUtxo.vout,
    index: 0,
  });

  const { intent: changeIntent, rpaContext: changeContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33: ctx.actors.actorBPaycodePub33,
    prevoutTxidHex: feeUtxo.txid,
    prevoutN: feeUtxo.vout,
    index: 1,
  });

  const pool = toPoolShardsState(st, ctx.network);

  const shardPrevout: PoolShards.PrevoutLike = {
    txid: shard.txid,
    vout: shard.vout,
    valueSats: BigInt(shardPrev.value),
    scriptPubKey: shardPrev.scriptPubKey,
  };

  const built = PoolShards.withdrawFromShard({
    pool,
    shardIndex,
    shardPrevout,
    feePrevout: feePrevouts.shards,
    covenantWallet: {
      signPrivBytes: senderWallet.privBytes,
      pubkeyHash160Hex: bytesToHex(senderWallet.hash160),
    },
    feeWallet: {
      signPrivBytes: feeUtxo.signPrivBytes,
      pubkeyHash160Hex: bytesToHex(senderWallet.hash160),
    },
    receiverP2pkhHash160Hex: bytesToHex(payIntent.childHash160),
    amountSats: payment,
    feeSats: BigInt(ctx.config.DEFAULT_FEE),
    changeP2pkhHash160Hex: bytesToHex(changeIntent.childHash160),
  } as any);

  const rawHex = bytesToHex(built.rawTx);
  const txid = await ctx.chainIO.broadcastRawTx(rawHex);

  const changeRec: StealthUtxoRecord = {
    owner: senderTag,
    purpose: 'withdraw_change',
    txid,
    vout: 2,
    valueSats: changeValueSats,
    value: changeValueSats,
    hash160Hex: bytesToHex(changeIntent.childHash160),
    rpaContext: changeContext,
    createdAt: new Date().toISOString(),
  } as any;
  upsertStealthUtxo(st, changeRec);

  if (feeUtxo.source === 'stealth') markStealthSpent(st, feeUtxo.txid, feeUtxo.vout, txid);

  patchShardFromNextPoolState({
    poolState: st,
    shardIndex,
    txid,
    nextPool: built.nextPoolState,
  });

  st.withdrawals ??= [];
  st.withdrawals.push({
    txid,
    shardIndex,
    amountSats,
    receiverRpaHash160Hex: bytesToHex(payIntent.childHash160),
    createdAt: new Date().toISOString(),
    rpaContext: payContext,
    receiverPaycodePub33Hex: bytesToHex(ctx.actors.actorAPaycodePub33),
  } as any);

  await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });
  return { txid };
}