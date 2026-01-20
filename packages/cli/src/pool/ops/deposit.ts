// packages/cli/src/pool/ops/deposit.ts
import type { DepositRecord, PoolState, StealthUtxoRecord } from '@bch-stealth/pool-state';
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

export async function runDeposit(
  ctx: PoolOpContext,
  opts: { amountSats: number }
): Promise<{ txid: string; deposit: DepositRecord; change: StealthUtxoRecord | null }> {
  const amountSats = Number(opts.amountSats);
  if (!Number.isFinite(amountSats) || amountSats <= 0) throw new Error(`[deposit] invalid amount: ${String(opts.amountSats)}`);

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

  const { payment, change } = deriveStealthOutputsForPaymentAndChange({
    senderWallet,
    senderPaycodePub33: ctx.actors.actorAPaycodePub33,
    receiverPaycodePub33: ctx.actors.actorBPaycodePub33,
    prevoutTxidHex: senderUtxo.txid,
    prevoutN: senderUtxo.vout,
  });

  const outSpk = p2pkhLockingBytecode(payment.childHash160);
  const changeSpkStealth = p2pkhLockingBytecode(change.childHash160);

  const feeRate = await ctx.chainIO.getFeeRateOrFallback();
  const estSize = 225; // 1-in, 2-out P2PKH (demo estimate)
  const feeFloor = BigInt(feeRate) * BigInt(estSize);

  let changeValue = inputValue - amount - feeFloor;

  const outputs: any[] = [{ value: amount, scriptPubKey: outSpk }];

  let changeRec: StealthUtxoRecord | null = null;
  if (changeValue >= DUST) {
    outputs.push({ value: changeValue, scriptPubKey: changeSpkStealth });

    changeRec = makeStealthUtxoRecord({
      owner: senderTag,
      purpose: 'deposit_change',
      txid: '<pending>',
      vout: 1,
      valueSats: changeValue,
      childHash160: change.childHash160,
      rpaContext: change.rpaContext,
    });
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

  const deposit: DepositRecord = {
    txid,
    vout: 0,
    valueSats: amount.toString(),
    value: amount.toString(), // legacy compat
    receiverRpaHash160Hex: bytesToHex(payment.childHash160),
    createdAt: new Date().toISOString(),
    rpaContext: payment.rpaContext,
  } as any;

  upsertDeposit(st, deposit);
  if (changeRec) upsertStealthUtxo(st, changeRec);

  await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });
  return { txid, deposit, change: changeRec };
}