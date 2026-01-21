// packages/cli/src/pool/ops/withdraw.ts
import type { StealthUtxoRecord, PoolState } from '@bch-stealth/pool-state';
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

function resolveCovenantSignerWalletFromState(ctx: PoolOpContext, st: PoolState) {
  const id = st.covenantSigner;
  if (!id) {
    throw new Error('Missing covenantSigner in state. Re-run init or repair state.');
  }

  const wantActor = (id.actorId ?? '').toLowerCase();
  const wantH160 = (id.pubkeyHash160Hex ?? '').toLowerCase();

  const a = ctx.actors.actorABaseWallet;
  const b = ctx.actors.actorBBaseWallet;

  let chosen =
    wantActor === 'actor_a' || wantActor === 'alice' || wantActor === 'a'
      ? a
      : wantActor === 'actor_b' || wantActor === 'bob' || wantActor === 'b'
        ? b
        : undefined;

  if (!chosen) {
    const aH = bytesToHex(a.hash160).toLowerCase();
    const bH = bytesToHex(b.hash160).toLowerCase();
    if (wantH160 === aH) chosen = a;
    if (wantH160 === bH) chosen = b;
  }

  if (!chosen) {
    throw new Error(
      `Unknown covenantSigner in state: actorId=${id.actorId} pubkeyHash160Hex=${id.pubkeyHash160Hex}`
    );
  }

  const actual = bytesToHex(chosen.hash160).toLowerCase();
  if (wantH160 && wantH160 !== actual) {
    throw new Error(
      `covenantSigner mismatch: state.pubkeyHash160Hex=${id.pubkeyHash160Hex} actualWalletHash160=${actual}`
    );
  }

  return { actorId: id.actorId, wallet: chosen };
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

  // B452: fail early if missing signer identity (withdraw requires covenant spend)
  if (!st.covenantSigner) {
    throw new Error('Missing covenantSigner in state. Re-run init or repair state.');
  }

  const shard = st.shards[shardIndex];
  if (!shard) throw new Error(`Unknown shard index ${shardIndex}`);

  const shardPrev = await ctx.chainIO.getPrevOutput(shard.txid, shard.vout);

  // ✅ Covenant signer is resolved from state (no script scanning).
  const covenantSigner = resolveCovenantSignerWalletFromState(ctx, st);
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
    console.log(`[withdraw:debug] covenantSigner.actorId=${covenantSigner.actorId}`);
    console.log(`[withdraw:debug] covenantSigner.h160=${bytesToHex(covenantSignerWallet.hash160)}`);
  }

  const built = PoolShards.withdrawFromShard({
    pool,
    shardIndex,
    shardPrevout,
    feePrevout: feePrevouts.shards,
    covenantWallet: {
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