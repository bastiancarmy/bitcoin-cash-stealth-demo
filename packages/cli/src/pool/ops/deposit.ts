// packages/cli/src/pool/ops/deposit.ts
import type { DepositRecord, StealthUtxoRecord } from '@bch-stealth/pool-state';
import {
  ensurePoolStateDefaults,
  upsertDeposit,
  upsertStealthUtxo,
  markStealthSpent,
} from '@bch-stealth/pool-state';

import { bytesToHex } from '@bch-stealth/utils';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../state.js';
import { deriveStealthOutputsForPaymentAndChange, makeStealthUtxoRecord } from '../stealth.js';

// Keep P2PKH script construction local to CLI policy.
function p2pkhLockingBytecode(hash160: Uint8Array): Uint8Array {
  if (!(hash160 instanceof Uint8Array) || hash160.length !== 20) {
    throw new Error('p2pkhLockingBytecode: hash160 must be 20 bytes');
  }
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160, 0x88, 0xac]);
}

function shouldDebug(): boolean {
  const v = String(process.env.BCH_STEALTH_DEBUG_DEPOSIT ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export async function runDeposit(
  ctx: PoolOpContext,
  opts: {
    amountSats: number;
    changeMode?: 'auto' | 'transparent' | 'stealth';
    depositMode?: 'rpa' | 'base';
  }
): Promise<{ txid: string; deposit: DepositRecord; change: StealthUtxoRecord | null }> {
  const amountSatsNum = Number(opts.amountSats);
  if (!Number.isFinite(amountSatsNum) || amountSatsNum <= 0) {
    throw new Error(`[deposit] invalid amount: ${String(opts.amountSats)}`);
  }

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);

  const DUST = BigInt(ctx.config.DUST);
  const amount = BigInt(amountSatsNum);
  if (amount < DUST) throw new Error('deposit amount below dust');

  const senderTag = 'me';
  const senderWallet = ctx.me.wallet;

  // 1) Select a funding UTXO owned by me
  const senderUtxo = await selectFundingUtxo({
    state: st,
    wallet: senderWallet,
    ownerTag: senderTag,
    minSats: amount + DUST + 2_000n,
    chainIO: ctx.chainIO,
    getUtxos: ctx.getUtxos,
    network: ctx.network,
    dustSats: DUST,
  });

  const prev = senderUtxo.prevOut;
  const inputValue = BigInt(prev.value);

  // 2) Derive RPA intents (self-send to me)
  const { payment: paymentIntent, change: changeIntent } = deriveStealthOutputsForPaymentAndChange({
    senderWallet,
    senderPaycodePub33: ctx.me.paycodePub33,
    receiverPaycodePub33: ctx.me.paycodePub33,
    prevoutTxidHex: senderUtxo.txid,
    prevoutN: senderUtxo.vout,
  });

  // 3) Decide whether deposit output is stealth/RPA or base P2PKH (both to me)
  const requestedDepositMode = (opts.depositMode ?? 'rpa') as 'rpa' | 'base';
  const depositMode: 'rpa' | 'base' = requestedDepositMode === 'base' ? 'base' : 'rpa';

  let paymentHash160: Uint8Array;
  let paymentSpk: Uint8Array;
  let paymentRpaContext: any | null = null;
  let depositKind: 'rpa' | 'base_p2pkh' = 'rpa';

  if (depositMode === 'rpa') {
    paymentHash160 = paymentIntent.childHash160;
    paymentSpk = p2pkhLockingBytecode(paymentHash160);
    paymentRpaContext = paymentIntent.rpaContext;
    depositKind = 'rpa';
  } else {
    paymentHash160 = senderWallet.hash160;
    paymentSpk = p2pkhLockingBytecode(paymentHash160);
    paymentRpaContext = null;
    depositKind = 'base_p2pkh';
  }

  // 4) Change policy
  const requestedMode = opts.changeMode ?? 'auto';
  const effectiveMode: 'transparent' | 'stealth' =
    requestedMode === 'auto'
      ? (senderUtxo.source === 'stealth' ? 'stealth' : 'transparent')
      : requestedMode;

  if (shouldDebug()) {
    console.log(
      `[deposit] depositMode=${depositMode} funding=${senderUtxo.source} changeMode=${effectiveMode}`
    );
  }

  const changeSpkTransparent = p2pkhLockingBytecode(senderWallet.hash160);
  const changeSpkStealth = p2pkhLockingBytecode(changeIntent.childHash160);

  const feeRate = await ctx.chainIO.getFeeRateOrFallback();
  const estSize = 225; // 1-in, 2-out P2PKH estimate
  const feeFloor = BigInt(feeRate) * BigInt(estSize);

  let changeValue = inputValue - amount - feeFloor;

  const outputs: any[] = [{ value: amount, scriptPubKey: paymentSpk }];

  let changeRec: StealthUtxoRecord | null = null;
  if (changeValue >= DUST) {
    outputs.push({
      value: changeValue,
      scriptPubKey: effectiveMode === 'stealth' ? changeSpkStealth : changeSpkTransparent,
    });

    if (effectiveMode === 'stealth') {
      changeRec = makeStealthUtxoRecord({
        owner: senderTag,
        purpose: 'deposit_change',
        txid: '<pending>',
        vout: 1,
        valueSats: changeValue,
        childHash160: changeIntent.childHash160,
        rpaContext: changeIntent.rpaContext,
      });
    }
  } else {
    changeValue = 0n;
  }

  // 5) Build + sign tx
  const { buildRawTx, signInput }: any = await import('@bch-stealth/tx-builder');
  const tx = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        txid: senderUtxo.txid,
        vout: senderUtxo.vout,
        scriptSig: new Uint8Array(),
        sequence: 0xffffffff,
      },
    ],
    outputs,
  };

  signInput(tx, 0, senderUtxo.signPrivBytes, prev.scriptPubKey, BigInt(prev.value));
  const rawTx = buildRawTx(tx);
  const txid = await ctx.chainIO.broadcastRawTx(rawTx);

  // 6) Update state
  if (senderUtxo.source === 'stealth') {
    markStealthSpent(st, senderUtxo.txid, senderUtxo.vout, txid);
  }
  if (changeRec) changeRec.txid = txid;

  const warnings: string[] = [];
  if (depositKind === 'base_p2pkh') {
    warnings.push('BASE_P2PKH_DEPOSIT_NOT_STEALTH');
    warnings.push('If privacy matters, mix coins externally before deposit/import (e.g. CashFusion).');
  }

  const deposit: DepositRecord = {
    txid,
    vout: 0,
    valueSats: amount.toString(),
    value: amount.toString(),

    // keep populated for unspent checks:
    receiverRpaHash160Hex: bytesToHex(paymentHash160),

    createdAt: new Date().toISOString(),

    // rpa-only
    rpaContext: paymentRpaContext ?? undefined,

    // metadata
    depositKind,
    baseP2pkhHash160Hex: depositKind === 'base_p2pkh' ? bytesToHex(paymentHash160) : undefined,
    warnings: warnings.length ? warnings : undefined,
  } as any;

  upsertDeposit(st, deposit);
  if (changeRec) upsertStealthUtxo(st, changeRec);

  await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });
  return { txid, deposit, change: changeRec };
}