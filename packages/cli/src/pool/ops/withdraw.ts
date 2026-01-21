// packages/cli/src/pool/ops/withdraw.ts
import type { StealthUtxoRecord } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, upsertStealthUtxo, markStealthSpent } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex } from '@bch-stealth/utils';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../state.js';
import { toPoolShardsState, patchShardFromNextPoolState } from '../adapters.js';
import { deriveStealthP2pkhLock } from '../stealth.js';

function shouldDebug(): boolean {
  return (
    process.env.BCH_STEALTH_DEBUG_WITHDRAW === '1' ||
    process.env.BCH_STEALTH_DEBUG_WITHDRAW === 'true' ||
    process.env.BCH_STEALTH_DEBUG_WITHDRAW === 'yes'
  );
}

function normalizeMode(mode: unknown): string | null {
  if (mode == null) return null;
  const s = String(mode).trim();
  return s.length ? s : null;
}

function scriptContainsHash160(scriptPubKey: Uint8Array, h160: Uint8Array): boolean {
  const spkHex = bytesToHex(scriptPubKey).toLowerCase();
  const needle = bytesToHex(h160).toLowerCase();
  return spkHex.includes(needle);
}

function pickCovenantSignerWallet(ctx: PoolOpContext, shardScriptPubKey: Uint8Array) {
  const a = ctx.actors.actorABaseWallet;
  const b = ctx.actors.actorBBaseWallet;

  const hasA = scriptContainsHash160(shardScriptPubKey, a.hash160);
  const hasB = scriptContainsHash160(shardScriptPubKey, b.hash160);

  if (shouldDebug()) {
    console.log(`[withdraw:debug] covenant signer search: contains(A.h160)=${hasA} contains(B.h160)=${hasB}`);
    console.log(`[withdraw:debug] A.h160=${bytesToHex(a.hash160)} B.h160=${bytesToHex(b.hash160)}`);
  }

  if (hasA && !hasB) return { wallet: a, ownerTag: 'A' as const };
  if (hasB && !hasA) return { wallet: b, ownerTag: 'B' as const };

  if (shouldDebug()) {
    console.log(`[withdraw:debug] WARNING: ambiguous covenant signer (both/neither h160 found). Defaulting to actor B.`);
  }
  return { wallet: b, ownerTag: 'B' as const };
}

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

  // ✅ Covenant signer must match the h160 embedded in the shard locking script.
  const covenantSigner = pickCovenantSignerWallet(ctx, shardPrev.scriptPubKey);
  const covenantSignerWallet = covenantSigner.wallet;

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
    receiverPaycodePub33: ctx.actors.actorAPaycodePub33,
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

  const forcedMode = normalizeMode(process.env.BCH_STEALTH_CATEGORY_MODE);

  if (shouldDebug()) {
    console.log(
      `\n[withdraw:debug] shard=${shardIndex} payment=${payment.toString()} fee=${String(ctx.config.DEFAULT_FEE)}`
    );
    console.log(`[withdraw:debug] categoryMode=${forcedMode ?? '<default>'}`);
    console.log(`[withdraw:debug] covenantSigner=${covenantSigner.ownerTag}`);
  }

  const built = PoolShards.withdrawFromShard({
    pool,
    shardIndex,
    shardPrevout,
    feePrevout: feePrevouts.shards,
    covenantWallet: {
      // ✅ FIX: sign with the wallet whose h160 is embedded in the shard covenant script
      signPrivBytes: covenantSignerWallet.privBytes,
      pubkeyHash160Hex: bytesToHex(covenantSignerWallet.hash160),
    },
    feeWallet: {
      signPrivBytes: feeUtxo.signPrivBytes,
      pubkeyHash160Hex: bytesToHex(senderWallet.hash160),
    },
    receiverP2pkhHash160Hex: bytesToHex(payIntent.childHash160),
    amountSats: payment,
    feeSats: BigInt(ctx.config.DEFAULT_FEE),
    changeP2pkhHash160Hex: bytesToHex(changeIntent.childHash160),
    categoryMode: forcedMode ?? undefined,
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