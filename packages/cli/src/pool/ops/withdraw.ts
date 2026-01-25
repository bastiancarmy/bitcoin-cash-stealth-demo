// packages/cli/src/pool/ops/withdraw.ts
import type { StealthUtxoRecord, PoolState } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, upsertStealthUtxo, markStealthSpent } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex, decodeCashAddress } from '@bch-stealth/utils';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../state.js';
import { toPoolShardsState, patchShardFromNextPoolState } from '../adapters.js';
import { deriveStealthP2pkhLock } from '../stealth.js';
import { extractPubKeyFromPaycode } from '../../paycodes.js';
import { NETWORK } from '../../config.js';

function shouldDebug(): boolean {
  const v = String(process.env.BCH_STEALTH_DEBUG_WITHDRAW ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function normalizeMode(mode: unknown): string | null {
  if (mode == null) return null;
  const s = String(mode).trim();
  return s.length ? s : null;
}

function expectedPrefixFromNetwork(): 'bitcoincash' | 'bchtest' {
  const n = String(NETWORK ?? '').toLowerCase();
  return n === 'mainnet' ? 'bitcoincash' : 'bchtest';
}

/**
 * Decode a cashaddr and return the hash160 for P2PKH.
 * Accepts both prefixed (bchtest:...) and unprefixed (...).
 */
export function decodeCashAddrToHash160(addr: string): Uint8Array {
  const s = String(addr ?? '').trim();
  if (!s) throw new Error('empty cashaddr');

  const expectedPrefix = expectedPrefixFromNetwork();
  const normalized = s.includes(':') ? s : `${expectedPrefix}:${s}`;

  const decoded = decodeCashAddress(normalized);

  if (decoded.prefix !== expectedPrefix) {
    throw new Error(`cashaddr prefix mismatch: got "${decoded.prefix}", expected "${expectedPrefix}"`);
  }
  if (decoded.type !== 'P2PKH') {
    throw new Error(`withdraw destination must be P2PKH cashaddr (got ${decoded.type})`);
  }

  return decoded.hash;
}

function parseDestToPub33OrH160(dest: string): { paycodePub33?: Uint8Array; p2pkhH160?: Uint8Array } {
  const s = String(dest ?? '').trim();
  if (!s) throw new Error('withdraw dest is required');

  if (s.startsWith('PM')) return { paycodePub33: extractPubKeyFromPaycode(s) };
  return { p2pkhH160: decodeCashAddrToHash160(s) };
}

/**
 * Pick a shard that can satisfy a single-shard withdraw:
 *   shardValue >= payment + dust
 *
 * Strategy: best-fit (smallest shard that works).
 */
function pickShardIndexForSingleShardWithdraw(st: PoolState, payment: bigint, dust: bigint): number | null {
  const need = payment + dust;

  let bestIndex: number | null = null;
  let bestValue: bigint | null = null;

  for (let i = 0; i < (st.shards?.length ?? 0); i++) {
    const s: any = st.shards[i];
    if (!s) continue;

    let v: bigint;
    try {
      v = BigInt(s.valueSats ?? s.value ?? '0');
    } catch {
      continue;
    }

    if (v < need) continue;

    if (bestValue === null || v < bestValue) {
      bestValue = v;
      bestIndex = i;
    }
  }

  return bestIndex;
}

function maxShardValue(st: PoolState): bigint {
  let m = 0n;
  for (const s of st.shards ?? []) {
    if (!s) continue;
    try {
      const v = BigInt((s as any).valueSats ?? (s as any).value ?? '0');
      if (v > m) m = v;
    } catch {}
  }
  return m;
}

function assertCovenantSignerIsMe(ctx: PoolOpContext, st: PoolState) {
  if (!st.covenantSigner?.pubkeyHash160Hex) return; // allow legacy states; init should set it
  const want = String(st.covenantSigner.pubkeyHash160Hex).toLowerCase();
  const have = bytesToHex(ctx.me.wallet.hash160).toLowerCase();
  if (want && want !== have) {
    throw new Error(`covenantSigner mismatch: state=${want} me=${have}`);
  }
}

export async function runWithdraw(
  ctx: PoolOpContext,
  opts: {
    dest: string;
    shardIndex?: number;
    amountSats: number;
    fresh?: boolean;
    requireShard?: boolean;
  }
): Promise<{ txid: string }> {
  const { amountSats, dest } = opts;

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);

  if (!st.categoryHex || !st.redeemScriptHex) {
    throw new Error('State missing redeemScriptHex/categoryHex. Run pool init first or repair state.');
  }
  if (!st.covenantSigner) {
    throw new Error('Missing covenantSigner in state. Re-run pool init or repair state.');
  }
  assertCovenantSignerIsMe(ctx, st);

  const payment = BigInt(amountSats);
  if (payment < BigInt(ctx.config.DUST)) throw new Error('withdraw amount below dust');

  // shard selection
  let shardIndex =
    typeof opts.shardIndex === 'number' && Number.isFinite(opts.shardIndex) ? opts.shardIndex : undefined;

  if (shardIndex == null) {
    if (opts.requireShard) throw new Error('Missing --shard and requireShard=true. Provide --shard explicitly.');

    const picked = pickShardIndexForSingleShardWithdraw(st, payment, BigInt(ctx.config.DUST));
    if (picked == null) {
      const max = maxShardValue(st);
      throw new Error(
        `No shard can satisfy single-shard withdraw. Need >= ${(payment + BigInt(ctx.config.DUST)).toString()} sats in one shard, ` +
          `but max shard is ${max.toString()} sats.`
      );
    }
    shardIndex = picked;
  }

  const shard = st.shards[shardIndex];
  if (!shard) throw new Error(`Unknown shard index ${shardIndex}`);

  const shardPrev = await ctx.chainIO.getPrevOutput(shard.txid, shard.vout);

  // single-user: covenant signer + fee wallet are "me"
  const covenantSignerWallet = ctx.me.wallet;
  const senderWallet = ctx.me.wallet;

  const feeUtxo = await selectFundingUtxo({
    state: st,
    wallet: senderWallet,
    ownerTag: 'me',
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

  const { paycodePub33, p2pkhH160 } = parseDestToPub33OrH160(dest);

  // receiver hash160
  let receiverH160: Uint8Array;
  let payContext: any = null;

  if (paycodePub33) {
    const { intent: payIntent, rpaContext } = deriveStealthP2pkhLock({
      senderWallet,
      receiverPaycodePub33: paycodePub33,
      prevoutTxidHex: feeUtxo.txid,
      prevoutN: feeUtxo.vout,
      index: 0,
    });
    receiverH160 = payIntent.childHash160;
    payContext = rpaContext;
  } else if (p2pkhH160) {
    receiverH160 = p2pkhH160;
  } else {
    throw new Error('unable to parse dest (expected paycode or cashaddr)');
  }

  // change back to me (stealth)
  const { intent: changeIntent, rpaContext: changeContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33: ctx.me.paycodePub33,
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
    console.log(`\n[withdraw:debug] shard=${shardIndex} payment=${payment.toString()} fee=${String(ctx.config.DEFAULT_FEE)}`);
    console.log(`[withdraw:debug] categoryMode=${forcedMode ?? '<default>'}`);
    console.log(`[withdraw:debug] me.h160=${bytesToHex(ctx.me.wallet.hash160)}`);
    console.log(`[withdraw:debug] dest=${dest}`);
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
    receiverP2pkhHash160Hex: bytesToHex(receiverH160),
    amountSats: payment,
    feeSats: BigInt(ctx.config.DEFAULT_FEE),
    changeP2pkhHash160Hex: bytesToHex(changeIntent.childHash160),
    categoryMode: forcedMode ?? undefined,
  } as any);

  const rawHex = bytesToHex(built.rawTx);
  const txid = await ctx.chainIO.broadcastRawTx(rawHex);

  const changeRec: StealthUtxoRecord = {
    owner: 'me',
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

  patchShardFromNextPoolState({ poolState: st, shardIndex, txid, nextPool: built.nextPoolState });

  st.withdrawals ??= [];
  st.withdrawals.push({
    txid,
    shardIndex,
    amountSats,
    receiverRpaHash160Hex: bytesToHex(receiverH160),
    createdAt: new Date().toISOString(),
    rpaContext: payContext ?? undefined,
    receiverPaycodePub33Hex: paycodePub33 ? bytesToHex(paycodePub33) : undefined,
  } as any);

  await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });
  return { txid };
}