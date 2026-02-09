// packages/cli/src/ops/send.ts
//
// Drop-in replacement (Phase 2 grinding):
// - Adds optional paycode grinding so outputs land in receiver's RPA server prefix.
// - Keeps output shape standard P2PKH.
// - Bounded work; defaults can be 256 attempts.
//
// Requires: scan side maxRoleIndex/maxIndex must be >= maxAttempts.

import { bytesToHex, decodeCashAddress, encodeCashAddr, sha256, concat } from '@bch-stealth/utils';
// tx-builder primitives (keep it minimal & deterministic)
import { getP2PKHScript, signInput, buildRawTx, estimateTxSize } from '@bch-stealth/tx-builder';
import {
  deriveRpaLockIntent,
  RPA_MODE_STEALTH_P2PKH,
  deriveSpendPub33FromScanPub33,
} from '@bch-stealth/rpa-derive';
// NOTE: we intentionally reuse the existing funding selector.
// It already supports mode:'wallet-send' and will not require state for base utxos.
import { selectFundingUtxo } from '../pool/state.js';
// paycode decode
import { decodePaycode } from '../paycodes.js';

function normalizeRawHex(raw: any): string {
  return typeof raw === 'string' ? raw : bytesToHex(raw);
}

function toBigIntSats(v: any): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v.trim()) return BigInt(v);
  if (v && typeof v === 'object') {
    if ('value' in v) return toBigIntSats((v as any).value);
    if ('valueSats' in v) return toBigIntSats((v as any).valueSats);
    if ('value_sats' in v) return toBigIntSats((v as any).value_sats);
  }
  return 0n;
}

function isPaycodeString(s: string): boolean {
  return typeof s === 'string' && s.startsWith('PM') && s.length > 8;
}

function cashaddrPrefixFromNetwork(network: string): 'bitcoincash' | 'bchtest' {
  const n = String(network ?? '').toLowerCase();
  return n === 'mainnet' ? 'bitcoincash' : 'bchtest';
}

function encodeP2pkhCashaddr(network: string, hash160: Uint8Array): string {
  return encodeCashAddr(cashaddrPrefixFromNetwork(network), 'P2PKH', hash160);
}

function decodeP2pkhHash160FromCashaddrOrThrow(dest: string): Uint8Array {
  const decoded: any = decodeCashAddress(dest);
  // utils/cashaddr.js returns: { prefix, type, hash }
  const hash = decoded?.hash as unknown;
  if (!decoded || decoded.type !== 'P2PKH' || !(hash instanceof Uint8Array)) {
    const t = decoded?.type ? String(decoded.type) : 'unknown';
    throw new Error(`send destination must be P2PKH cashaddr (got ${t})`);
  }
  if (hash.length !== 20) throw new Error(`send destination hash length must be 20 (got ${hash.length})`);
  return hash;
}

function decodePaycodeToScanPub33OrThrow(paycode: string): Uint8Array {
  const d: any = decodePaycode(paycode);
  const pub = d?.pubkey33 as unknown;
  if (!(pub instanceof Uint8Array) || pub.length !== 33) {
    throw new Error('send: invalid paycode decode (expected pubkey33)');
  }
  return pub;
}

function deriveReceiverGrindByteFromScanPub33(scanPub33: Uint8Array): number {
  const tag = new TextEncoder().encode('bch-stealth:rpa:grind:');
  const h = sha256(concat(tag, scanPub33));
  return h[0]!;
}

export async function runSend(
  ctx: any,
  args: {
    dest: string;
    sats: bigint;
    dryRun?: boolean;
    grind?: { enabled?: boolean; maxAttempts?: number; prefixByteOverride?: number | null };
  }
): Promise<any> {
  const destRaw = String(args.dest ?? '').trim();
  if (!destRaw) throw new Error('send: missing <dest>');
  if (args.sats <= 0n) throw new Error('send: sats must be positive');

  // Fee policy: deterministic, minimal
  const feeRate = await ctx.chainIO.getFeeRateOrFallback(); // sats/byte
  const dust = ctx.dustSats;
  if (args.sats < dust) throw new Error(`send: amount below dust (${args.sats} < ${dust})`);

  // 1) Select funding
  const wantTwoOutputs = true;
  const estSize2 = BigInt(estimateTxSize(1, wantTwoOutputs ? 2 : 1));
  const fee2 = BigInt(Math.ceil(Number(estSize2) * feeRate));
  const minSats = args.sats + fee2 + dust; // leave room for change>=dust

  const funding = await selectFundingUtxo({
    mode: 'wallet-send',
    state: ctx.state,
    wallet: ctx.me,
    ownerTag: ctx.ownerTag,
    prefer: ['base', 'stealth'], // base-first
    minSats,
    allowTokens: false,
    includeUnconfirmed: true,
    minConfirmations: 0,
    markStaleStealthRecords: false,
    chainIO: ctx.chainIO,
    getUtxos: ctx.getUtxos,
    network: String(ctx.network),
    dustSats: ctx.dustSats,
  });

  const prev = funding.prevOut;
  const inputValue = toBigIntSats((prev as any)?.value);

  // 2) Resolve destination locking script
  let destType: 'paycode' | 'cashaddr';
  let destHash160!: Uint8Array;
  let destAddress!: string;

  let grindMeta: any = { used: false };

  if (isPaycodeString(destRaw)) {
    destType = 'paycode';

    // Paycode provides scan pubkey Q
    const receiverScanPub33 = decodePaycodeToScanPub33OrThrow(destRaw);

    // Spend pubkey R derived deterministically from Q
    const receiverSpendPub33 = deriveSpendPub33FromScanPub33(receiverScanPub33);

    // sender priv for ECDH
    const senderPrivBytes = ctx.me.privBytes;
    if (!(senderPrivBytes instanceof Uint8Array) || senderPrivBytes.length !== 32) {
      throw new Error('send: wallet privBytes must be 32 bytes');
    }

    // Grinding config (Phase 2)
    const enabled = args.grind?.enabled !== false;
    const maxAttempts = Math.max(0, Math.floor(Number(args.grind?.maxAttempts ?? 256)));
    const override = args.grind?.prefixByteOverride;

    const targetByte =
      typeof override === 'number' && Number.isFinite(override)
        ? (override & 0xff)
        : deriveReceiverGrindByteFromScanPub33(receiverScanPub33);

    // Always compute index=0 first (fast path)
    let intent = deriveRpaLockIntent({
      mode: RPA_MODE_STEALTH_P2PKH,
      senderPrivBytes,
      receiverScanPub33,
      receiverSpendPub33,
      prevoutTxidHex: funding.txid,
      prevoutN: funding.vout,
      index: 0,
    });

    let usedIndex = 0;
    let found = intent.childHash160[0] === targetByte;

    if (enabled && !found && maxAttempts > 0) {
      // try 1..maxAttempts-1
      for (let i = 1; i < maxAttempts; i++) {
        const cand = deriveRpaLockIntent({
          mode: RPA_MODE_STEALTH_P2PKH,
          senderPrivBytes,
          receiverScanPub33,
          receiverSpendPub33,
          prevoutTxidHex: funding.txid,
          prevoutN: funding.vout,
          index: i,
        });

        if (cand.childHash160[0] === targetByte) {
          intent = cand;
          usedIndex = i;
          found = true;
          break;
        }
      }
    }

    // If not found, keep index=0 (still valid; scan may need --txid)
    destHash160 = intent.childHash160;
    destAddress = encodeP2pkhCashaddr(String(ctx.network), destHash160);

    grindMeta = {
      used: enabled && maxAttempts > 0,
      found,
      index: usedIndex,
      maxAttempts,
      prefixByte: targetByte,
      override: typeof override === 'number' ? (override & 0xff) : null,
    };
  } else {
    destType = 'cashaddr';
    destHash160 = decodeP2pkhHash160FromCashaddrOrThrow(destRaw);
    destAddress = destRaw; // preserve exact user input
  }

  const destLock = getP2PKHScript(destHash160);

  // 3) Build tx (1 input, 1 or 2 outputs)
  const tx: any = {
    version: 1,
    locktime: 0,
    inputs: [
      {
        txid: funding.txid,
        vout: funding.vout,
        sequence: 0xffffffff,
        scriptSig: new Uint8Array(),
      },
    ],
    outputs: [] as any[],
  };

  // add payment output
  tx.outputs.push({ value: args.sats, scriptPubKey: destLock });

  // compute change with 2-output estimate first
  const change2 = inputValue - args.sats - fee2;
  if (change2 >= dust) {
    const changeHash160 = ctx.me.hash160; // base transparent change
    const changeLock = getP2PKHScript(changeHash160);
    tx.outputs.push({ value: change2, scriptPubKey: changeLock });
  } else {
    // drop change output; recompute fee for 1 output
    const estSize1 = BigInt(estimateTxSize(1, 1));
    const fee1 = BigInt(Math.ceil(Number(estSize1) * feeRate));
    const change1 = inputValue - args.sats - fee1;
    if (change1 < 0n) {
      throw new Error(
        `send: insufficient funds. input=${inputValue} sats, amount=${args.sats} sats, fee≈${fee1} sats`
      );
    }
    // burn dust into fee
  }

  // 4) Sign input (P2PKH)
  signInput(tx, 0, funding.signPrivBytes, prev.scriptPubKey, BigInt((prev as any).value));

  // 5) Serialize + broadcast
  const rawAny = buildRawTx(tx, { format: 'hex' });
  const rawHex = normalizeRawHex(rawAny);
  const txid = args.dryRun ? null : await ctx.chainIO.broadcastRawTx(rawHex);

  return {
    txid,
    destType,
    destAddress,
    destHash160Hex: bytesToHex(destHash160),
    rawHex,
    grind: destType === 'paycode' ? grindMeta : undefined,
  };
}