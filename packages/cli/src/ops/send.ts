// packages/cli/src/ops/send.ts
//
// Patch: mark spent stealth funding records in state after successful broadcast
// (so funding selection stops re-checking them every run).
//
// UPDATE (Fulcrum prefix_bits=16):
// - Paycode sends now grind on a 16-bit prefix by default (2 bytes, 4 hex chars).
// - Still supports legacy 8-bit grind byte override.
// - Adds args.grind.prefixHex16Override for explicit 16-bit override.
export const RUNSEND_BUILD_ID = 'runsend-build-id-2026-02-21a';
import { bytesToHex, decodeCashAddress, encodeCashAddr, sha256, concat } from '@bch-stealth/utils';
import { getP2PKHScript, signInput, buildRawTx, estimateTxSize } from '@bch-stealth/tx-builder';
import { deriveRpaLockIntent, RPA_MODE_STEALTH_P2PKH, deriveSpendPub33FromScanPub33 } from '@bch-stealth/rpa-derive';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { normalizeWalletKeys, debugPrintKeyFlags } from '../wallet/normalizeKeys.js';

import { selectFundingUtxo } from '../pool/state.js';
import { decodePaycode } from '../paycodes.js';
import { deriveSelfStealthChange, recordDerivedChangeUtxo } from '../stealth/change.js';

import { reverseBytes } from '@bch-stealth/utils';

// --- NEW: state helpers to mark spent stealth records ---
type Outpoint = { txid: string; vout: number };

function ensureCanonicalStealthArray(st: any): any[] {
  // Canonical location: state.data.pool.state.stealthUtxos
  st.data = st.data || {};
  st.data.pool = st.data.pool || {};
  st.data.pool.state = st.data.pool.state || {};
  if (!Array.isArray(st.data.pool.state.stealthUtxos)) st.data.pool.state.stealthUtxos = [];
  return st.data.pool.state.stealthUtxos;
}

function findStealthRecordByOutpoint(st: any, op: Outpoint): any | null {
  const arr = ensureCanonicalStealthArray(st);
  const txid = String(op.txid);
  const vout = Number(op.vout);
  for (const r of arr) {
    if (r && String(r.txid) === txid && Number(r.vout) === vout) return r;
  }
  return null;
}

function markStealthRecordSpent(st: any, op: Outpoint, spentByTxid: string): boolean {
  const rec = findStealthRecordByOutpoint(st, op);
  if (!rec) return false;

  rec.spent = true;
  rec.spentByTxid = String(spentByTxid);
  rec.spentAt = new Date().toISOString();
  return true;
}

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

function cashaddrPrefixFromNetwork(network: string): 'bitcoincash' | 'bchtest' {
  const n = String(network ?? '').toLowerCase();
  return n === 'mainnet' ? 'bitcoincash' : 'bchtest';
}

function encodeP2pkhCashaddr(network: string, hash160: Uint8Array): string {
  return encodeCashAddr(cashaddrPrefixFromNetwork(network), 'P2PKH', hash160);
}

/**
 * Extract a BIP47 paycode token from any surrounding text.
 */
function extractPaycodeCandidate(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const tokens = s.split(/\s+/g);
  for (const t0 of tokens) {
    const t = t0.trim();
    if (!t) continue;
    if (t.slice(0, 2).toUpperCase() !== 'PM') continue;
    if (!/^PM[1-9A-HJ-NP-Za-km-z]+$/.test(t)) continue;
    if (t.length < 20) continue;
    return t;
  }

  const m = s.match(/(PM[1-9A-HJ-NP-Za-km-z]{20,})/);
  return m ? m[1] : null;
}

function decodeP2pkhHash160FromCashaddrOrThrow(network: string, addr: string): Uint8Array {
  let s = String(addr ?? '').trim();

  if (!s.includes(':')) {
    s = `${cashaddrPrefixFromNetwork(network)}:${s}`;
  }

  s = s.toLowerCase();

  const decoded: any = decodeCashAddress(s);
  if (decoded?.type !== 'P2PKH') {
    throw new Error(`send: destination must be P2PKH cashaddr (got ${String(decoded?.type ?? 'unknown')})`);
  }
  if (!(decoded?.hash instanceof Uint8Array) || decoded.hash.length !== 20) {
    throw new Error(`send: cashaddr decode failed (expected 20-byte hash160)`);
  }
  return decoded.hash;
}

function decodePaycodeToScanPub33OrThrow(paycode: string): Uint8Array {
  const d: any = decodePaycode(String(paycode ?? '').trim());
  const pub = d?.pubkey33 as unknown;
  if (!(pub instanceof Uint8Array) || pub.length !== 33) {
    throw new Error('send: invalid paycode decode (expected pubkey33)');
  }
  return pub;
}

/**
 * Spec-aligned RPA prefix derivation from receiver scan pubkey33.
 * - 16-bit prefix: scanPub33[1..3] (skip 02/03)
 * - 8-bit prefix:  scanPub33[1]
 */
function deriveReceiverGrindPrefix16FromScanPub33(scanPub33: Uint8Array): string {
  if (!(scanPub33 instanceof Uint8Array) || scanPub33.length !== 33) {
    throw new Error('send: receiver scanPub33 must be 33 bytes');
  }
  return bytesToHex(scanPub33.slice(1, 3)).toLowerCase();
}

function deriveReceiverGrindByteFromScanPub33(scanPub33: Uint8Array): number {
  if (!(scanPub33 instanceof Uint8Array) || scanPub33.length !== 33) {
    throw new Error('send: receiver scanPub33 must be 33 bytes');
  }
  return scanPub33[1]!;
}

function isPaycodeStringStrict(s: string): boolean {
  return typeof s === 'string' && s.startsWith('PM') && s.length > 8;
}

function findPaycodeStringDeep(root: any, maxDepth = 5): string | null {
  const seen = new Set<any>();

  function walk(v: any, depth: number): string | null {
    if (depth < 0) return null;
    if (v == null) return null;
    if (typeof v === 'string') return isPaycodeStringStrict(v.trim()) ? v.trim() : null;

    if (typeof v !== 'object') return null;
    if (seen.has(v)) return null;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = walk(item, depth - 1);
        if (hit) return hit;
      }
      return null;
    }

    for (const k of Object.keys(v)) {
      const hit = walk((v as any)[k], depth - 1);
      if (hit) return hit;
    }
    return null;
  }

  return walk(root, maxDepth);
}

function resolveSelfPaycodePub33OrThrow(ctx: any): Uint8Array {
  const direct =
    (ctx?.me?.paycodePub33 instanceof Uint8Array && ctx.me.paycodePub33.length === 33 ? ctx.me.paycodePub33 : null) ??
    (ctx?.paycodePub33 instanceof Uint8Array && ctx.paycodePub33.length === 33 ? ctx.paycodePub33 : null) ??
    (ctx?.me?.paycode?.pub33 instanceof Uint8Array && ctx.me.paycode.pub33.length === 33 ? ctx.me.paycode.pub33 : null);

  if (direct) return direct;

  const pm = findPaycodeStringDeep(ctx, 6);
  if (pm) {
    const decoded: any = decodePaycode(pm);
    const pub = decoded?.pubkey33 as unknown;
    if (pub instanceof Uint8Array && pub.length === 33) return pub;
  }

  const scanDirect =
    (ctx?.me?.scanPub33 instanceof Uint8Array && ctx.me.scanPub33.length === 33 ? ctx.me.scanPub33 : null) ??
    (ctx?.me?.wallet?.scanPub33 instanceof Uint8Array && ctx.me.wallet.scanPub33.length === 33
      ? ctx.me.wallet.scanPub33
      : null) ??
    (ctx?.me?.wallet?.scanPubkey33 instanceof Uint8Array && ctx.me.wallet.scanPubkey33.length === 33
      ? ctx.me.wallet.scanPubkey33
      : null);

  if (scanDirect) return scanDirect;

  throw new Error(
    'send: missing self paycode pub33 (expected ctx.me.paycodePub33 OR a PM... string OR scanPub33 on ctx)'
  );
}

function cleanPrefix16OrThrow(raw: unknown): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) throw new Error('send: prefixHex16Override is empty');
  const x = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[0-9a-f]{4}$/.test(x)) {
    throw new Error(`send: prefixHex16Override must be 4 hex chars (2 bytes), got "${String(raw)}"`);
  }
  return x;
}

function scriptToScripthashHex(scriptPubKey: Uint8Array): string {
  // Standard Electrum scripthash: reverseBytes(sha256(script))
  const h = sha256(scriptPubKey);
  return bytesToHex(reverseBytes(h)).toLowerCase();
}

async function doesFulcrumBucketContainTxid(args: {
  client: any;
  prefixHex: string;
  txid: string;
}): Promise<boolean> {
  try {
    const mp = await args.client.request('blockchain.rpa.get_mempool', args.prefixHex);
    if (Array.isArray(mp)) {
      for (const it of mp) {
        if ((it as any)?.tx_hash === args.txid) return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

export async function runSend(
  ctx: any,
  args: {
    dest: string;
    sats: bigint;
    dryRun?: boolean;
    grind?: {
      enabled?: boolean;
      maxAttempts?: number;
      prefixByteOverride?: number | null; // legacy 8-bit override
      prefixHex16Override?: string | null; // preferred 16-bit override
    };
  }
): Promise<any> {
  if (String(process.env.BCH_STEALTH_DEBUG_SEND ?? '') === '1') {
    console.log(`[send:debug] RUNSEND_BUILD_ID=${RUNSEND_BUILD_ID}`);
  }
  const destRaw = String(args.dest ?? '').trim();
  if (!destRaw) throw new Error('send: missing <dest>');
  if (args.sats <= 0n) throw new Error('send: sats must be positive');

  const feeRate = await ctx.chainIO.getFeeRateOrFallback(); // sats/byte
  const dust: bigint = BigInt(ctx.dustSats);
  if (args.sats < dust) throw new Error(`send: amount below dust (${args.sats} < ${dust})`);

  // ---- helpers: Fulcrum RPA prefix from first input serialization ----
  const hexToBytesLocal = (hex: string): Uint8Array => {
    const h = String(hex ?? '').trim();
    if (h.length % 2 !== 0) throw new Error('send: rawHex must have even length');
    return Uint8Array.from(Buffer.from(h, 'hex'));
  };

  const readVarInt = (b: Uint8Array, o: number): { n: number; o: number } => {
    const x = b[o]!;
    if (x < 0xfd) return { n: x, o: o + 1 };
    if (x === 0xfd) {
      const n = b[o + 1]! | (b[o + 2]! << 8);
      return { n, o: o + 3 };
    }
    if (x === 0xfe) {
      const n =
        (b[o + 1]!) |
        (b[o + 2]! << 8) |
        (b[o + 3]! << 16) |
        (b[o + 4]! << 24);
      return { n: n >>> 0, o: o + 5 };
    }
    // 0xff (u64) – not expected for scriptSig lengths; support anyway
    let nn = 0n;
    for (let i = 0; i < 8; i++) nn |= BigInt(b[o + 1 + i]!) << (8n * BigInt(i));
    if (nn > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('send: varint too large');
    return { n: Number(nn), o: o + 9 };
  };

  const hash256 = (msg: Uint8Array): Uint8Array => sha256(sha256(msg));

  const computeRpaPrefix16FromRawTxHex = (rawHex: string): string => {
    const b = hexToBytesLocal(rawHex);
    let o = 0;

    // version
    o += 4;

    // vin count
    const vin = readVarInt(b, o);
    o = vin.o;
    if (vin.n < 1) throw new Error('send: tx has no inputs');

    const input0Start = o;

    // prevout txid (32) + vout (4)
    o += 32 + 4;

    // scriptSig length + scriptSig
    const sl = readVarInt(b, o);
    o = sl.o;
    o += sl.n;

    // sequence (4)
    o += 4;

    const input0End = o;
    const input0 = b.slice(input0Start, input0End);
    const h = hash256(input0);
    return bytesToHex(h).slice(0, 4).toLowerCase();
  };

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
    prefer: ['base', 'stealth'],
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

  const paycodeCand = extractPaycodeCandidate(destRaw);

  // These will be populated for paycode sends (used later for grindMeta + printing)
  let wantPrefix16: string | null = null;
  let wantPrefixByte: number | null = null;
  let use16 = true;

  // paycode intent (we keep your current derivation behavior)
  let paycodeIntent: any | null = null;
  let usedRoleIndex = 0;

  if (paycodeCand) {
    destType = 'paycode';

    const receiverScanPub33 = decodePaycodeToScanPub33OrThrow(paycodeCand);
    const receiverSpendPub33 = deriveSpendPub33FromScanPub33(receiverScanPub33);

    const senderPrivBytes = funding.signPrivBytes;
    if (!(senderPrivBytes instanceof Uint8Array) || senderPrivBytes.length !== 32) {
      throw new Error('send: funding.signPrivBytes must be 32 bytes');
    }

    const enabled = args.grind?.enabled !== false;
    const maxAttempts = Math.max(1, Math.floor(Number(args.grind?.maxAttempts ?? 256)));

    const prefixHex16OverrideRaw = args.grind?.prefixHex16Override ?? null;
    const prefixByteOverrideRaw = args.grind?.prefixByteOverride ?? null;

    const derived16 = deriveReceiverGrindPrefix16FromScanPub33(receiverScanPub33);
    const derived8 = deriveReceiverGrindByteFromScanPub33(receiverScanPub33);

    wantPrefix16 =
      prefixHex16OverrideRaw != null ? cleanPrefix16OrThrow(prefixHex16OverrideRaw) : derived16;

    wantPrefixByte =
      prefixByteOverrideRaw != null &&
      typeof prefixByteOverrideRaw === 'number' &&
      Number.isFinite(prefixByteOverrideRaw)
        ? (prefixByteOverrideRaw & 0xff)
        : null;

    use16 = wantPrefix16 != null && wantPrefixByte == null;

    // Keep role index fixed at 0 for now (receiver scanning cost stays low).
    // The grind happens on the first input serialization (sequence/signature).
    paycodeIntent = deriveRpaLockIntent({
      mode: RPA_MODE_STEALTH_P2PKH,
      senderPrivBytes,
      receiverScanPub33,
      receiverSpendPub33,
      prevoutTxidHex: funding.txid,
      prevoutN: funding.vout,
      index: 0,
    });
    usedRoleIndex = 0;

    destHash160 = paycodeIntent.childHash160;
    destAddress = encodeP2pkhCashaddr(String(ctx.network), destHash160);

    const destHash160Hex = bytesToHex(destHash160).toLowerCase();
    const spk0 = getP2PKHScript(destHash160);
    const sh0 = scriptToScripthashHex(spk0);

    grindMeta = {
      used: enabled && maxAttempts > 0,
      // "found" below will mean: we successfully ground the tx so that
      // its first-input hash prefix matches the desired prefix.
      found: false,

      // role index used inside deriveRpaLockIntent (not the grind nonce)
      roleIndex: usedRoleIndex,

      // grind attempts for tx input prefix
      maxAttempts,
      mode: use16 ? 'prefix16' : 'prefix8',
      wantPrefix16: use16 ? wantPrefix16 : null,
      wantPrefix8: !use16 ? (wantPrefixByte ?? derived8) : null,

      derivedPrefix16: derived16,
      derivedPrefix8: derived8,

      override16: prefixHex16OverrideRaw != null ? cleanPrefix16OrThrow(prefixHex16OverrideRaw) : null,
      override8: prefixByteOverrideRaw != null ? (Number(prefixByteOverrideRaw) & 0xff) : null,

      gotHash160Prefix16: destHash160Hex.slice(0, 4),
      gotHash160Prefix8: destHash160Hex.slice(0, 2),
      gotScripthashPrefix16: sh0.slice(0, 4),
      gotScripthashPrefix8: sh0.slice(0, 2),

      // filled in after we grind/sign
      gotInputPrefix16: null as string | null,
      grindNonce: null as number | null,
      sequence: null as number | null,
    };
  } else {
    destType = 'cashaddr';
    destHash160 = decodeP2pkhHash160FromCashaddrOrThrow(String(ctx.network), destRaw);
    destAddress = destRaw;
  }

  const destLock = getP2PKHScript(destHash160);

  // 3) Build tx skeleton (we will sign/grind later for paycode)
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

  tx.outputs.push({ value: args.sats, scriptPubKey: destLock });

  const change2 = inputValue - args.sats - fee2;

  let changePlanned = false;
  let changeVout: number | null = null;
  let changeValue: bigint = 0n;
  let selfChange: ReturnType<typeof deriveSelfStealthChange> | null = null;

  // --- Compute stealth change (if change output) ---
  if (change2 >= dust) {
    const selfPaycodePub33 = resolveSelfPaycodePub33OrThrow(ctx);

    const nk = normalizeWalletKeys(ctx.me);
    debugPrintKeyFlags('send', nk.flags);

    const selfSpendPriv32 = nk.spendPriv32;
    const selfSpendPub33 = secp256k1.getPublicKey(selfSpendPriv32, true);

    selfChange = deriveSelfStealthChange({
      st: ctx.state,
      senderPrivBytes: funding.signPrivBytes,
      selfPaycodePub33,
      selfSpendPub33,
      anchorTxidHex: funding.txid,
      anchorVout: funding.vout,
      purpose: 'wallet_change',
      fundingOutpoint: { txid: funding.txid, vout: funding.vout },
    });

    tx.outputs.push({ value: change2, scriptPubKey: selfChange.changeSpk });

    changePlanned = true;
    changeVout = 1;
    changeValue = change2;
  } else {
    const estSize1 = BigInt(estimateTxSize(1, 1));
    const fee1 = BigInt(Math.ceil(Number(estSize1) * feeRate));
    const change1 = inputValue - args.sats - fee1;
    if (change1 < 0n) {
      throw new Error(
        `send: insufficient funds. input=${inputValue} sats, amount=${args.sats} sats, fee≈${fee1} sats`
      );
    }
  }

  // 4) Sign + (optional) grind for paycode sends
  const enabled = args.grind?.enabled !== false;
  const maxAttempts = Math.max(1, Math.floor(Number(args.grind?.maxAttempts ?? 256)));

  let rawHexFinal: string | null = null;
  let gotInputPrefix16Final: string | null = null;
  let grindNonceFinal: number | null = null;
  let seqFinal: number | null = null;

  if (destType === 'paycode' && enabled && wantPrefix16) {
    // Grind sequence so that the first input hash prefix matches wantPrefix16 (or wantPrefix8 legacy).
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // 32-bit grind nonce split across locktime + sequence
      const locktime = (attempt >>> 16) >>> 0;        // upper 16 bits
      const seq = (0xffffffff - (attempt & 0xffff)) >>> 0; // lower 16 bits

      tx.locktime = locktime;
      tx.inputs[0].sequence = seq;

      // Sign (signature changes with sequence/tx, which affects scriptSig, which affects input hash)
      signInput(tx, 0, funding.signPrivBytes, prev.scriptPubKey, BigInt((prev as any).value));

      const rawAny = buildRawTx(tx, { format: 'hex' });
      const rawHex = normalizeRawHex(rawAny);

      const pref16 = computeRpaPrefix16FromRawTxHex(rawHex);
      const ok = use16
        ? pref16 === wantPrefix16
        : pref16.slice(0, 2) === ((wantPrefixByte ?? 0) & 0xff).toString(16).padStart(2, '0');

      if (ok) {
        rawHexFinal = rawHex;
        gotInputPrefix16Final = pref16;
        grindNonceFinal = attempt;
        seqFinal = seq;
        (grindMeta as any).locktime = locktime;
        break;
      }
    }

    // If we didn't find a match, still use the last signed tx hex (attempt 0 already signed above?).
    if (!rawHexFinal) {
      // Ensure tx is signed at least once
      tx.inputs[0].sequence = 0xffffffff;
      signInput(tx, 0, funding.signPrivBytes, prev.scriptPubKey, BigInt((prev as any).value));
      const rawAny = buildRawTx(tx, { format: 'hex' });
      rawHexFinal = normalizeRawHex(rawAny);
      gotInputPrefix16Final = computeRpaPrefix16FromRawTxHex(rawHexFinal);
      grindNonceFinal = 0;
      seqFinal = 0xffffffff;
    }

    if (grindMeta) {
      grindMeta.gotInputPrefix16 = gotInputPrefix16Final;
      grindMeta.grindNonce = grindNonceFinal;
      grindMeta.sequence = seqFinal;
      grindMeta.found = use16
        ? gotInputPrefix16Final === wantPrefix16
        : gotInputPrefix16Final?.slice(0, 2) === ((wantPrefixByte ?? 0) & 0xff).toString(16).padStart(2, '0');
    }
  } else {
    // Non-paycode or grind disabled: sign once normally
    signInput(tx, 0, funding.signPrivBytes, prev.scriptPubKey, BigInt((prev as any).value));
    const rawAny = buildRawTx(tx, { format: 'hex' });
    rawHexFinal = normalizeRawHex(rawAny);

    if (destType === 'paycode' && grindMeta) {
      // Fill in what bucket it actually ended up in (useful for debugging).
      try {
        grindMeta.gotInputPrefix16 = computeRpaPrefix16FromRawTxHex(rawHexFinal);
      } catch {
        grindMeta.gotInputPrefix16 = null;
      }
      grindMeta.found = false;
    }
  }

  // 5) Broadcast
  const txid = args.dryRun ? null : await ctx.chainIO.broadcastRawTx(rawHexFinal!);

  // --- mark stealth funding record as spent after successful broadcast ---
  if (!args.dryRun && txid) {
    const didMark = markStealthRecordSpent(ctx.state, { txid: funding.txid, vout: funding.vout }, txid);
    void didMark;
  }

  // 6) Record stealth change
  if (!args.dryRun && txid && changePlanned && changeVout != null && selfChange) {
    recordDerivedChangeUtxo({
      st: ctx.state,
      txid,
      vout: changeVout,
      valueSats: changeValue,
      derived: selfChange,
      owner: ctx.ownerTag ?? 'me',
      fundingOutpoint: { txid: funding.txid, vout: funding.vout },
    });
  }

  return {
    txid,
    destType,
    destAddress,
    destHash160Hex: bytesToHex(destHash160),
    rawHex: rawHexFinal,
    grind: destType === 'paycode' ? grindMeta : undefined,
    change: changePlanned
      ? {
          vout: changeVout,
          valueSats: changeValue.toString(),
          hash160Hex: selfChange?.changeHash160Hex ?? null,
          index: selfChange?.index ?? null,
        }
      : null,
  };
}