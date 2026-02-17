// packages/cli/src/stealth/change.ts
//
// Stealth change helper:
// - deterministically derives self-paycode stealth P2PKH change output
// - allocates a monotonic change index in state (restoreHints.nextSelfChangeIndex)
// - records the resulting outpoint into state.stealthUtxos (upsert)
// - caller must pass selfSpendPub33
//
// Designed to be used by wallet send, pool withdraw, pool import, etc.
//
// Debugging:
// - set BCH_STEALTH_DEBUG_CHANGE=1 to print derivation + record context
// - optionally pass fundingOutpoint to deriveSelfStealthChange() / recordDerivedChangeUtxo()

import type { PoolState, StealthUtxoRecord } from '@bch-stealth/pool-state';
import { upsertStealthUtxo } from '@bch-stealth/pool-state';

import { bytesToHex } from '@bch-stealth/utils';
import { deriveRpaLockIntent, RPA_MODE_STEALTH_P2PKH } from '@bch-stealth/rpa-derive';

import { secp256k1 } from '@noble/curves/secp256k1.js';

// Keep purpose names narrow but allow string callers safely.
export type ChangePurpose =
  | 'wallet_change'
  | 'pool_withdraw_change'
  | 'pool_import_change'
  | 'pool_init_change'
  | (string & {});

function dbgEnabled(): boolean {
  return String(process.env.BCH_STEALTH_DEBUG_CHANGE ?? '').trim() === '1';
}

function dlog(obj: any) {
  if (!dbgEnabled()) return;
  console.log(`[change] ${JSON.stringify(obj, null, 2)}`);
}

function fmtOutpoint(txid: string, vout: number): string {
  const t = String(txid ?? '').trim().toLowerCase();
  const n = Number(vout);
  return `${t}:${Number.isFinite(n) ? n : String(vout)}`;
}

// Minimal P2PKH locking script helper
function p2pkhLockingBytecode(hash160: Uint8Array): Uint8Array {
  if (!(hash160 instanceof Uint8Array) || hash160.length !== 20) {
    throw new Error(`p2pkhLockingBytecode: expected 20-byte hash160`);
  }
  return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160, 0x88, 0xac]);
}

function ensureRestoreHints(st: any): any {
  st.restoreHints ??= {};
  return st.restoreHints;
}

/**
 * Deterministic index allocator for self-change derivations.
 * Stored in state.restoreHints.nextSelfChangeIndex (monotonic counter).
 */
export function nextSelfChangeIndex(st: PoolState): number {
  const hints = ensureRestoreHints(st as any);
  const cur = Number(hints.nextSelfChangeIndex ?? 0);
  const next = Number.isFinite(cur) && cur >= 0 ? cur : 0;
  hints.nextSelfChangeIndex = next + 1;
  return next;
}

export function deriveSelfStealthChange(args: {
  st: PoolState;
  senderPrivBytes: Uint8Array;
  senderPub33Hex?: string;

  selfPaycodePub33: Uint8Array; // receiver scan pub33
  selfSpendPub33: Uint8Array; // receiver spend pub33 (MUST be consistent with selectFundingUtxo spending derivation)

  anchorTxidHex: string;
  anchorVout: number;

  index?: number;
  purpose?: ChangePurpose;

  // DEBUG ONLY: funding input outpoint that led to this change derivation (for correlation)
  fundingOutpoint?: { txid: string; vout: number };
}): {
  index: number;
  changeHash160Hex: string;
  changeSpk: Uint8Array;
  rpaContext: {
    senderPub33Hex: string;
    prevoutTxidHex: string;
    prevoutHashHex: string;
    prevoutN: number;
    index: number;
  };
  purpose: ChangePurpose;
} {
  const st = args.st;
  const purpose: ChangePurpose = (args.purpose ?? 'wallet_change') as ChangePurpose;

  if (!(args.senderPrivBytes instanceof Uint8Array) || args.senderPrivBytes.length !== 32) {
    throw new Error('deriveSelfStealthChange: senderPrivBytes must be 32 bytes');
  }
  if (!(args.selfPaycodePub33 instanceof Uint8Array) || args.selfPaycodePub33.length !== 33) {
    throw new Error('deriveSelfStealthChange: selfPaycodePub33 must be 33 bytes');
  }
  if (!(args.selfSpendPub33 instanceof Uint8Array) || args.selfSpendPub33.length !== 33) {
    throw new Error('deriveSelfStealthChange: selfSpendPub33 must be 33 bytes');
  }

  const anchorTxidHex = String(args.anchorTxidHex ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(anchorTxidHex)) {
    throw new Error(`deriveSelfStealthChange: invalid anchorTxidHex`);
  }

  const anchorVout = Number(args.anchorVout);
  if (!Number.isFinite(anchorVout) || anchorVout < 0) {
    throw new Error(`deriveSelfStealthChange: invalid anchorVout`);
  }

  // allocate index if not provided
  const index =
    typeof args.index === 'number' && Number.isFinite(args.index) && args.index >= 0
      ? args.index
      : nextSelfChangeIndex(st);

  // Sender pubkey must match senderPrivBytes (used by deriveRpaLockIntent).
  const senderPub33Hex =
    typeof args.senderPub33Hex === 'string' && args.senderPub33Hex.trim()
      ? String(args.senderPub33Hex).trim().toLowerCase()
      : bytesToHex(secp256k1.getPublicKey(args.senderPrivBytes, true)).toLowerCase();

  // ✅ Correct: receiver spend pubkey comes from caller (wallet spend key), not derived from senderPrivBytes.
  const receiverSpendPub33 = args.selfSpendPub33;

  // ✅ print: funding input outpoint + anchor used for derivation
  dlog({
    stage: 'derive',
    purpose,
    fundingOutpoint: args.fundingOutpoint
      ? fmtOutpoint(args.fundingOutpoint.txid, args.fundingOutpoint.vout)
      : undefined,
    anchor: fmtOutpoint(anchorTxidHex, anchorVout),
    index,
    senderPub33Hex,
  });

  const intent = deriveRpaLockIntent({
    mode: RPA_MODE_STEALTH_P2PKH,
    senderPrivBytes: args.senderPrivBytes,
    receiverScanPub33: args.selfPaycodePub33,
    receiverSpendPub33,
    prevoutTxidHex: anchorTxidHex,
    prevoutN: anchorVout,
    index,
  } as any);

  const changeHash160Hex = bytesToHex(intent.childHash160);
  const changeSpk = p2pkhLockingBytecode(intent.childHash160);

  const rpaContext = {
    senderPub33Hex,
    prevoutTxidHex: anchorTxidHex,
    prevoutHashHex: anchorTxidHex, // keep both for compatibility
    prevoutN: anchorVout,
    index,
  };

  // ✅ print: rpaContext + derived hash160
  dlog({
    stage: 'derive-result',
    purpose,
    anchor: fmtOutpoint(anchorTxidHex, anchorVout),
    changeHash160Hex,
    rpaContext,
  });

  return { index, changeHash160Hex, changeSpk, rpaContext, purpose };
}

/**
 * Record a derived change outpoint into state.stealthUtxos (upsert).
 * Caller provides txid/vout/value from the broadcasted tx outputs.
 */
export function recordDerivedChangeUtxo(args: {
  st: PoolState;

  // change output being recorded
  txid: string;
  vout: number;
  valueSats: string | number | bigint;

  derived: ReturnType<typeof deriveSelfStealthChange>;
  owner?: string; // default 'me'

  // DEBUG ONLY: the funding input outpoint that was actually selected to fund the tx
  fundingOutpoint?: { txid: string; vout: number };
}): StealthUtxoRecord {
  const st = args.st;

  const txid = String(args.txid ?? '').trim().toLowerCase();
  const vout = Number(args.vout);

  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('recordDerivedChangeUtxo: invalid txid');
  if (!Number.isFinite(vout) || vout < 0) throw new Error('recordDerivedChangeUtxo: invalid vout');

  const valueSats = String(args.valueSats ?? '').trim();
  if (!valueSats) throw new Error('recordDerivedChangeUtxo: missing valueSats');

  // ✅ print: funding outpoint + anchor + derived context/hash + the change outpoint being recorded
  dlog({
    stage: 'record',
    owner: args.owner ?? 'me',
    purpose: args.derived.purpose,
    fundingOutpoint: args.fundingOutpoint
      ? fmtOutpoint(args.fundingOutpoint.txid, args.fundingOutpoint.vout)
      : undefined,
    anchor: fmtOutpoint(args.derived.rpaContext.prevoutTxidHex, args.derived.rpaContext.prevoutN),
    derived: {
      changeHash160Hex: args.derived.changeHash160Hex,
      rpaContext: args.derived.rpaContext,
      index: args.derived.index,
    },
    changeOutpoint: fmtOutpoint(txid, vout),
    valueSats,
  });

  const rec: StealthUtxoRecord = {
    owner: args.owner ?? 'me',
    purpose: args.derived.purpose,
    txid,
    vout,
    valueSats,
    value: valueSats,
    hash160Hex: args.derived.changeHash160Hex,
    lockingBytecodeHex: bytesToHex(args.derived.changeSpk),
    rpaContext: args.derived.rpaContext as any,
    createdAt: new Date().toISOString(),
  } as any;

  upsertStealthUtxo(st, rec);
  return rec;
}