// packages/cli/src/pool/ops/deposit.ts
import type { DepositRecord, StealthUtxoRecord } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, upsertDeposit, upsertStealthUtxo, markStealthSpent } from '@bch-stealth/pool-state';

import { bytesToHex } from '@bch-stealth/utils';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../state.js';
import { deriveStealthOutputsForPaymentAndChange, makeStealthUtxoRecord } from '../stealth.js';

// Keep P2PKH script construction local to CLI policy (still “mechanical”).
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
    depositMode?: 'rpa' | 'base'; // NEW
  }
): Promise<{ txid: string; deposit: DepositRecord; change: StealthUtxoRecord | null }> {
  const amountSats = Number(opts.amountSats);
  if (!Number.isFinite(amountSats) || amountSats <= 0) {
    throw new Error(`[deposit] invalid amount: ${String(opts.amountSats)}`);
  }

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);

  const DUST = BigInt(ctx.config.DUST);

  const amount = BigInt(amountSats);
  if (amount < DUST) throw new Error('deposit amount below dust');

  const senderTag = 'A';
  const senderWallet = ctx.actors.actorABaseWallet;

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

  const requestedDepositMode = (opts.depositMode ?? 'rpa') as 'rpa' | 'base';
  const depositMode: 'rpa' | 'base' = requestedDepositMode === 'base' ? 'base' : 'rpa';

  // ------------------------------------------------------------
  // Payment selection:
  // - rpa: current behavior (RPA-derived P2PKH)
  // - base: pay directly to actorB base P2PKH (not stealth)
  // ------------------------------------------------------------
  let paymentSpk: Uint8Array;
  let paymentHash160: Uint8Array;
  let paymentRpaContext: any | null = null;
  let depositKind: 'rpa' | 'base_p2pkh' = 'rpa';

  // Change derivation: we can still derive stealth intents for change when requested/auto,
  // even if the *deposit output* is base. (Change is a separate policy decision.)
  const { payment, change } = deriveStealthOutputsForPaymentAndChange({
    senderWallet,
    senderPaycodePub33: ctx.actors.actorAPaycodePub33,
    receiverPaycodePub33: ctx.actors.actorBPaycodePub33,
    prevoutTxidHex: senderUtxo.txid,
    prevoutN: senderUtxo.vout,
  });

  if (depositMode === 'rpa') {
    paymentHash160 = payment.childHash160;
    paymentSpk = p2pkhLockingBytecode(paymentHash160);
    paymentRpaContext = payment.rpaContext;
    depositKind = 'rpa';
  } else {
    // base deposit to actor B's base address (P2PKH)
    paymentHash160 = ctx.actors.actorBBaseWallet.hash160;
    paymentSpk = p2pkhLockingBytecode(paymentHash160);
    paymentRpaContext = null;
    depositKind = 'base_p2pkh';
  }

  // Change policy:
  // - base funding -> transparent change (sender base P2PKH)
  // - stealth funding -> stealth change (recorded)
  const requestedMode = opts.changeMode ?? 'auto';
  const effectiveMode: 'transparent' | 'stealth' =
    requestedMode === 'auto' ? (senderUtxo.source === 'stealth' ? 'stealth' : 'transparent') : requestedMode;

  if (shouldDebug()) {
    console.log(`[deposit] depositMode=${depositMode} funding=${senderUtxo.source} changeMode=${effectiveMode}`);
  }

  const changeSpkTransparent = p2pkhLockingBytecode(senderWallet.hash160);
  const changeSpkStealth = p2pkhLockingBytecode(change.childHash160);

  const feeRate = await ctx.chainIO.getFeeRateOrFallback();
  const estSize = 225; // 1-in, 2-out P2PKH (demo estimate)
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
        childHash160: change.childHash160,
        rpaContext: change.rpaContext,
      });
    }
  } else {
    changeValue = 0n;
  }

  // Keep tx construction identical to index.ts version.
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

  if (senderUtxo.source === 'stealth') {
    markStealthSpent(st, senderUtxo.txid, senderUtxo.vout, txid);
  }

  if (changeRec) changeRec.txid = txid;

  const warnings: string[] = [];
  if (depositKind === 'base_p2pkh') {
    warnings.push('BASE_P2PKH_DEPOSIT_NOT_STEALTH');
    warnings.push('If using this for privacy, mix coins externally before deposit/import (e.g. CashFusion).');
  }

  const deposit: DepositRecord = {
    txid,
    vout: 0,
    valueSats: amount.toString(),
    value: amount.toString(), // legacy compat

    // keep this field populated so existing unspent checks work:
    receiverRpaHash160Hex: bytesToHex(paymentHash160),

    createdAt: new Date().toISOString(),

    // rpa-only
    rpaContext: paymentRpaContext ?? undefined,

    // NEW metadata (safe; requires your DepositRecord update in pool-state)
    depositKind,
    baseP2pkhHash160Hex: depositKind === 'base_p2pkh' ? bytesToHex(paymentHash160) : undefined,
    warnings: warnings.length ? warnings : undefined,
  } as any;

  upsertDeposit(st, deposit);
  if (changeRec) upsertStealthUtxo(st, changeRec);

  await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });
  return { txid, deposit, change: changeRec };
}