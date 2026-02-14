// packages/cli/src/ops/send.ts
//
// Patch: mark spent stealth funding records in state after successful broadcast
// (so funding selection stops re-checking them every run).

import { bytesToHex, decodeCashAddress, encodeCashAddr, sha256, concat } from '@bch-stealth/utils';
import { getP2PKHScript, signInput, buildRawTx, estimateTxSize } from '@bch-stealth/tx-builder';
import { deriveRpaLockIntent, RPA_MODE_STEALTH_P2PKH, deriveSpendPub33FromScanPub33 } from '@bch-stealth/rpa-derive';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { normalizeWalletKeys, debugPrintKeyFlags } from '../wallet/normalizeKeys.js';

import { selectFundingUtxo } from '../pool/state.js';
import { decodePaycode } from '../paycodes.js';
import { deriveSelfStealthChange, recordDerivedChangeUtxo } from '../stealth/change.js';

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

  // Keep it forward/backward compatible: add a few obvious markers.
  // (Selection can skip if any of these are present.)
  rec.spent = true;
  rec.spentByTxid = String(spentByTxid);
  rec.spentAt = new Date().toISOString();

  // Some existing code logs "reason: spent" via chain checks; this makes it deterministic locally.
  // If you later want to preserve provenance, keep the old fields unchanged.
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

function deriveReceiverGrindByteFromScanPub33(scanPub33: Uint8Array): number {
  const tag = new TextEncoder().encode('bch-stealth:rpa:grind:');
  const h = sha256(concat(tag, scanPub33));
  return h[0]!;
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

  const feeRate = await ctx.chainIO.getFeeRateOrFallback(); // sats/byte
  const dust: bigint = BigInt(ctx.dustSats);
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

  if (paycodeCand) {
    destType = 'paycode';

    const receiverScanPub33 = decodePaycodeToScanPub33OrThrow(paycodeCand);
    const receiverSpendPub33 = deriveSpendPub33FromScanPub33(receiverScanPub33);

    // IMPORTANT: senderPrivBytes must match the key that will appear in the input scriptSig.
    // If we spend a stealth UTXO, the signing key is NOT ctx.me.privBytes.
    const senderPrivBytes = funding.signPrivBytes;
    if (!(senderPrivBytes instanceof Uint8Array) || senderPrivBytes.length !== 32) {
      throw new Error('send: funding.signPrivBytes must be 32 bytes');
    }

    const enabled = args.grind?.enabled !== false;
    const maxAttempts = Math.max(0, Math.floor(Number(args.grind?.maxAttempts ?? 256)));
    const override = args.grind?.prefixByteOverride;

    const targetByte =
      typeof override === 'number' && Number.isFinite(override)
        ? (override & 0xff)
        : deriveReceiverGrindByteFromScanPub33(receiverScanPub33);

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
    destHash160 = decodeP2pkhHash160FromCashaddrOrThrow(String(ctx.network), destRaw);
    destAddress = destRaw;
  }

  const destLock = getP2PKHScript(destHash160);

  // 3) Build tx
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

    // ✅ canonical key normalization (single source of truth)
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

  // 4) Sign input
  signInput(tx, 0, funding.signPrivBytes, prev.scriptPubKey, BigInt((prev as any).value));

  // 5) Broadcast
  const rawAny = buildRawTx(tx, { format: 'hex' });
  const rawHex = normalizeRawHex(rawAny);
  const txid = args.dryRun ? null : await ctx.chainIO.broadcastRawTx(rawHex);

  // --- NEW: mark stealth funding record as spent after successful broadcast ---
  if (!args.dryRun && txid) {
    // Only makes sense if we *actually* used a stealth outpoint.
    // selectFundingUtxo already knows which outpoint we used: funding.txid/funding.vout.
    // If it was base funding, there won't be a matching stealth record; harmless no-op.
    const didMark = markStealthRecordSpent(ctx.state, { txid: funding.txid, vout: funding.vout }, txid);
    // Optional debug hook if you want it:
    // if (process.env.BCH_STEALTH_DEBUG_POOL) console.log(`[send] marked spent=${didMark} for ${funding.txid}:${funding.vout}`);
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
    rawHex,
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