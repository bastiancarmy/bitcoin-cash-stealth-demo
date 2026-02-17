// packages/cli/src/pool/stealth.ts
//
// Stealth derivation helpers for the CLI pool demo.

import type { RpaContext, StealthUtxoRecord } from '@bch-stealth/pool-state';
import type { WalletLike } from './context.js';

import {
  RPA_MODE_STEALTH_P2PKH,
  deriveRpaLockIntent,
  deriveSpendPub33FromScanPub33,
} from '@bch-stealth/rpa'; // ok now that @bch-stealth/rpa re-exports rpa-derive
import { bytesToHex } from '@bch-stealth/utils';

/**
 * Convenience: derive a stealth P2PKH locking intent AND the minimum context the receiver needs
 * to derive the one-time private key later.
 *
 * IMPORTANT (LOCKED-IN): prevout txid is used "as-is" (no endian reversal).
 */
export function deriveStealthP2pkhLock(args: {
  senderWallet: WalletLike;
  receiverPaycodePub33: Uint8Array; // interpreted as scan pubkey Q
  prevoutTxidHex: string;
  prevoutN: number;
  index: number;
}): { intent: any; rpaContext: RpaContext } {
  const { senderWallet, receiverPaycodePub33, prevoutTxidHex, prevoutN, index } = args;

  const receiverScanPub33 = receiverPaycodePub33;
  const receiverSpendPub33 = deriveSpendPub33FromScanPub33(receiverScanPub33);

  const intent = deriveRpaLockIntent({
    mode: RPA_MODE_STEALTH_P2PKH,
    senderPrivBytes: senderWallet.privBytes,
    receiverScanPub33,
    receiverSpendPub33,
    prevoutTxidHex,
    prevoutN,
    index,
  });

  // IMPORTANT: use the pool-state RpaContext shape (not the rpa-derive one)
  const rpaContext: RpaContext = {
    senderPub33Hex: bytesToHex(senderWallet.pubBytes),
    prevoutHashHex: prevoutTxidHex,
    prevoutN,
    index,
  };

  return { intent, rpaContext };
}

/**
 * Derive the two stealth outputs used by the demo:
 * - index 0: payment to receiver
 * - index 1: change back to sender
 */
export function deriveStealthOutputsForPaymentAndChange(args: {
  senderWallet: WalletLike;
  senderPaycodePub33: Uint8Array; // scan pubkey Q for sender
  receiverPaycodePub33: Uint8Array; // scan pubkey Q for receiver
  prevoutTxidHex: string;
  prevoutN: number;
}): {
  payment: { intent: any; rpaContext: RpaContext; childHash160: Uint8Array };
  change: { intent: any; rpaContext: RpaContext; childHash160: Uint8Array };
} {
  const { senderWallet, senderPaycodePub33, receiverPaycodePub33, prevoutTxidHex, prevoutN } = args;

  const { intent: payIntent, rpaContext: payContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33,
    prevoutTxidHex,
    prevoutN,
    index: 0,
  });

  const { intent: changeIntent, rpaContext: changeContext } = deriveStealthP2pkhLock({
    senderWallet,
    receiverPaycodePub33: senderPaycodePub33,
    prevoutTxidHex,
    prevoutN,
    index: 1,
  });

  return {
    payment: { intent: payIntent, rpaContext: payContext, childHash160: payIntent.childHash160 },
    change: { intent: changeIntent, rpaContext: changeContext, childHash160: changeIntent.childHash160 },
  };
}

export function makeStealthUtxoRecord(args: {
  owner: string;
  purpose: string;
  txid: string;
  vout: number;
  valueSats: bigint | string | number;
  childHash160: Uint8Array;
  rpaContext: RpaContext;
  createdAt?: string;
}): StealthUtxoRecord {
  const {
    owner,
    purpose,
    txid,
    vout,
    valueSats,
    childHash160,
    rpaContext,
    createdAt = new Date().toISOString(),
  } = args;

  const valueStr = typeof valueSats === 'string' ? valueSats : BigInt(valueSats).toString();

  return {
    owner,
    purpose,
    txid,
    vout,
    valueSats: valueStr,
    value: valueStr, // legacy compat
    hash160Hex: bytesToHex(childHash160),
    rpaContext,
    createdAt,
  } as StealthUtxoRecord;
}