// packages/cli/src/pool/ops/withdraw.ts

import type { PoolState } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, markStealthSpent } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex, decodeCashAddress, hexToBytes } from '@bch-stealth/utils';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../state.js';
import { toPoolShardsState, patchShardFromNextPoolState } from '../adapters.js';
import { deriveStealthP2pkhLock } from '../stealth.js';
import { extractPubKeyFromPaycode } from '../../paycodes.js';
import { NETWORK } from '../../config.js';

import { deriveSelfStealthChange, recordDerivedChangeUtxo } from '../../stealth/change.js';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { normalizeWalletKeys, debugPrintKeyFlags } from '../../wallet/normalizeKeys.js';

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
 * Pick a shard that can satisfy a withdraw from a single shard.
 *
 * Strategy: best-fit (smallest shard that works), prefer keep-alive if possible.
 */
function pickShardIndexForWithdrawSingleShard(st: PoolState, payment: bigint, dust: bigint): {
  shardIndex: number;
  willKeepAlive: boolean;
} | null {
  let bestKeep: { i: number; v: bigint } | null = null;
  let bestClose: { i: number; v: bigint } | null = null;

  for (let i = 0; i < (st.shards?.length ?? 0); i++) {
    const s: any = st.shards[i];
    if (!s) continue;

    let v: bigint;
    try {
      v = BigInt(s.valueSats ?? s.value ?? '0');
    } catch {
      continue;
    }

    if (v >= payment) {
      if (!bestClose || v < bestClose.v) bestClose = { i, v };
    }
    if (v >= payment + dust) {
      if (!bestKeep || v < bestKeep.v) bestKeep = { i, v };
    }
  }

  if (bestKeep) return { shardIndex: bestKeep.i, willKeepAlive: true };
  if (bestClose) return { shardIndex: bestClose.i, willKeepAlive: false };
  return null;
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
  if (!st.covenantSigner?.pubkeyHash160Hex) return;
  const want = String(st.covenantSigner.pubkeyHash160Hex).toLowerCase();
  const have = bytesToHex(ctx.me.wallet.hash160).toLowerCase();
  if (want && want !== have) {
    throw new Error(`covenantSigner mismatch: state=${want} me=${have}`);
  }
}

function parseP2pkhHash160(scriptPubKey: Uint8Array): Uint8Array | null {
  if (
    scriptPubKey.length === 25 &&
    scriptPubKey[0] === 0x76 &&
    scriptPubKey[1] === 0xa9 &&
    scriptPubKey[2] === 0x14 &&
    scriptPubKey[23] === 0x88 &&
    scriptPubKey[24] === 0xac
  ) {
    return scriptPubKey.slice(3, 23);
  }
  return null;
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

  let shardIndex =
    typeof opts.shardIndex === 'number' && Number.isFinite(opts.shardIndex) ? opts.shardIndex : undefined;

  if (shardIndex == null) {
    if (opts.requireShard) throw new Error('Missing --shard and requireShard=true. Provide --shard explicitly.');
    const dust = BigInt(ctx.config.DUST);

    const picked = pickShardIndexForWithdrawSingleShard(st, payment, dust);
    if (picked == null) {
      const max = maxShardValue(st);
      const needKeep = payment + dust;
      const needClose = payment;
      throw new Error(
        `No shard can satisfy withdraw from a single shard.\n` +
          `Need >= ${needKeep.toString()} sats in one shard (keep-alive), or >= ${needClose.toString()} sats (close-shard), ` +
          `but max shard is ${max.toString()} sats.`
      );
    }
    shardIndex = picked.shardIndex;
  }

  const shard = st.shards[shardIndex];
  if (!shard) throw new Error(`Unknown shard index ${shardIndex}`);

  const shardPrev = await ctx.chainIO.getPrevOutput(shard.txid, shard.vout);
  const dust = BigInt(ctx.config.DUST);

  const shardValueSats = (() => {
    try {
      return BigInt((shard as any).valueSats ?? (shard as any).value ?? '0');
    } catch {
      return BigInt(shardPrev.value);
    }
  })();

  const remainder = shardValueSats - payment;
  if (remainder < 0n) {
    throw new Error(
      `withdraw: insufficient shard funds: shard=${shardIndex} in=${shardValueSats.toString()} need=${payment.toString()}`
    );
  }

  const willCloseShard = remainder === 0n || remainder < dust;

  const covenantSignerWallet = ctx.me.wallet;
  const senderWallet = ctx.me.wallet;

  const ownerTag = String((ctx as any)?.profile ?? (ctx as any)?.ownerTag ?? '').trim();
  if (!ownerTag) throw new Error('withdraw: missing active profile (ownerTag)');

  const feeUtxo = await selectFundingUtxo({
    mode: 'pool-op',
    state: st,
    wallet: senderWallet,
    ownerTag,
    minSats: BigInt(ctx.config.DUST) + BigInt(ctx.config.DEFAULT_FEE) + 2_000n,
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

  const feeValueSats = BigInt(feePrevouts.chain.value);
  const feeSats = BigInt(ctx.config.DEFAULT_FEE);
  const changeValueSatsBig = feeValueSats - feeSats;

  if (changeValueSatsBig > 0n && changeValueSatsBig < BigInt(ctx.config.DUST)) {
    throw new Error(
      `withdraw: fee funding would create dust change (${changeValueSatsBig.toString()} sats). ` +
        `Use a larger fee UTXO (fund wallet) or bump DEFAULT_FEE logic.`
    );
  }

  const { paycodePub33, p2pkhH160 } = parseDestToPub33OrH160(dest);

  const anchorTxidHex = feeUtxo.txid;
  const anchorVout = feeUtxo.vout;

  let receiverH160: Uint8Array;
  let payContext: any = null;

  if (paycodePub33) {
    const { intent: payIntent, rpaContext } = deriveStealthP2pkhLock({
      senderWallet,
      receiverPaycodePub33: paycodePub33,
      prevoutTxidHex: anchorTxidHex,
      prevoutN: anchorVout,
      index: 0,
    });
    receiverH160 = payIntent.childHash160;
    payContext = rpaContext;
  } else if (p2pkhH160) {
    receiverH160 = p2pkhH160;
  } else {
    throw new Error('unable to parse dest (expected paycode or cashaddr)');
  }

  if (!(ctx.me.paycodePub33 instanceof Uint8Array) || ctx.me.paycodePub33.length !== 33) {
    throw new Error('withdraw: ctx.me.paycodePub33 missing/invalid (expected 33 bytes)');
  }

  // --- normalize once ---
  const nk = normalizeWalletKeys(ctx.me.wallet);
  debugPrintKeyFlags('pool-withdraw', nk.flags);

  const selfSpendPub33 = secp256k1.getPublicKey(nk.spendPriv32, true);

  const selfChange = deriveSelfStealthChange({
    st,
    senderPrivBytes: senderWallet.privBytes,
    selfPaycodePub33: ctx.me.paycodePub33,
    selfSpendPub33,
    anchorTxidHex,
    anchorVout,
    purpose: 'pool_withdraw_change',
    fundingOutpoint: { txid: feeUtxo.txid, vout: feeUtxo.vout },
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
      `\n[withdraw:debug] shard=${shardIndex} payment=${payment.toString()} fee=${feeSats.toString()} closeShard=${willCloseShard}`
    );
    console.log(`[withdraw:debug] categoryMode=${forcedMode ?? '<default>'}`);
    console.log(`[withdraw:debug] me.h160=${bytesToHex(ctx.me.wallet.hash160)}`);
    console.log(`[withdraw:debug] dest=${dest}`);
    console.log(
      `[withdraw:debug] change(self-stealth) index=${selfChange.index} anchor=${anchorTxidHex}:${anchorVout} h160=${selfChange.changeHash160Hex}`
    );
  }

  const built: any = PoolShards.withdrawFromShard({
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
    feeSats,
    changeP2pkhHash160Hex: selfChange.changeHash160Hex,
    remainderPolicy: 'close-if-dust',
  } as any);

  const rawHex = bytesToHex(built.rawTx);
  const txid = await ctx.chainIO.broadcastRawTx(rawHex);

  // Determine change vout robustly.
  let changeVout: number | null = null;

  if (typeof built?.changeVout === 'number' && Number.isFinite(built.changeVout)) {
    changeVout = built.changeVout;
  } else if (typeof built?.changeOutputIndex === 'number' && Number.isFinite(built.changeOutputIndex)) {
    changeVout = built.changeOutputIndex;
  } else if (Array.isArray(built?.outputs)) {
    for (let i = 0; i < built.outputs.length; i++) {
      const spk = built.outputs[i]?.scriptPubKey;
      if (!(spk instanceof Uint8Array)) continue;
      const h160 = parseP2pkhHash160(spk);
      if (!h160) continue;
      if (bytesToHex(h160).toLowerCase() === selfChange.changeHash160Hex.toLowerCase()) {
        changeVout = i;
        break;
      }
    }
  }

  if (changeVout != null && changeValueSatsBig > 0n) {
    recordDerivedChangeUtxo({
      st,
      txid,
      vout: changeVout,
      valueSats: changeValueSatsBig,
      derived: selfChange,
      owner: ownerTag,
      fundingOutpoint: { txid: feeUtxo.txid, vout: feeUtxo.vout },
    });
  } else if (shouldDebug()) {
    console.log('[withdraw:debug] WARNING: could not determine change vout; change not recorded');
  }

  if (feeUtxo.source === 'stealth') {
    markStealthSpent(st, feeUtxo.txid, feeUtxo.vout, txid);
  }

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