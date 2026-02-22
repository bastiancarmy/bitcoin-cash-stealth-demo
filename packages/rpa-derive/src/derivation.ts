// packages/rpa-derive/src/derivation.ts
//
// RPA derivation + session key helpers (Phase 1)
//
// Dual-key model WITHOUT changing paycode format:
// - Paycode contains scan pubkey Q
// - Spend pubkey R is derived deterministically from Q:
//     t = H("bch-stealth:rpa:spend:" || Q) mod n
//     R = Q + tG
// - Receiver spendPriv = scanPriv + t mod n
//
// Sender uses:
//   sharedSecret = calculatePaycodeSharedSecret(senderPriv=e, receiverScanPub=Q, outpointStr)
//   childPub = CKDpub(spendPub=R, chainCode=sharedSecret, index)
//
// Receiver uses:
//   sharedSecret = calculatePaycodeSharedSecret(scanPriv=d, senderPub=P, outpointStr)
//   oneTimePriv = CKDpriv(spendPriv=f, chainCode=sharedSecret, index)
//
// IMPORTANT: outpointStr convention must match on both sides.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import aesjs from 'aes-js';

import {
  sha256,
  concat,
  bytesToHex,
  hexToBytes,
  bytesToBigInt,
  bigIntToBytes,
  ensureEvenYPriv,
  hash160,
} from '@bch-stealth/utils';

// -------------------- constants / modes --------------------

export const RPA_MODE_CONF_ASSET = 'confidential-asset' as const;
export const RPA_MODE_STEALTH_P2PKH = 'stealth-p2pkh' as const;
export const RPA_MODE_PQ_VAULT = 'pq-vault' as const;

export type RpaMode =
  | typeof RPA_MODE_CONF_ASSET
  | typeof RPA_MODE_STEALTH_P2PKH
  | typeof RPA_MODE_PQ_VAULT;

function assertMode(mode: unknown): asserts mode is RpaMode {
  if (
    mode !== RPA_MODE_CONF_ASSET &&
    mode !== RPA_MODE_STEALTH_P2PKH &&
    mode !== RPA_MODE_PQ_VAULT
  ) {
    throw new Error('Invalid RPA mode');
  }
}

// -------------------- types --------------------

export type RpaContext = {
  paycodeId: string | null;
  senderPub33: Uint8Array; // 33 bytes
  prevoutTxidHex: string; // 64 hex chars
  prevoutN: number;
  index: number;
  mode: RpaMode;
};

export type DeriveRpaLockIntentParams = {
  paycodeId?: string | null;
  mode: RpaMode;
  senderPrivBytes: Uint8Array; // 32
  receiverScanPub33: Uint8Array; // Q (33)
  receiverSpendPub33?: Uint8Array | null; // R (33) optional
  prevoutTxidHex: string; // 64 hex
  prevoutN: number;
  index?: number;
  extraCtx?: Uint8Array;
};

export type RpaSessionKeys = {
  sessionKey: Uint8Array; // 32
  amountKey: Uint8Array; // 16
  memoKey: Uint8Array; // 16
  zkSeed: Uint8Array; // 32
};

export type RpaLockIntent = {
  mode: RpaMode;
  address: string | null;
  childPubkey: Uint8Array; // 33
  childHash160: Uint8Array; // 20
  sharedSecret: Uint8Array; // 32
  session: Omit<RpaSessionKeys, 'sessionKey'>;
  extraCtx: Uint8Array;
  context: RpaContext;
};

// -------------------- small helpers --------------------

function curveOrder(): bigint {
  return secp256k1.Point.CURVE().n;
}

function modN(x: bigint): bigint {
  const n = curveOrder();
  const r = x % n;
  return r >= 0n ? r : r + n;
}

function uint32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function hmacSHA512(keyBytes: Uint8Array, dataBytes: Uint8Array): Uint8Array {
  return hmac(sha512, keyBytes, dataBytes);
}

function randomBytesCompat(n: number): Uint8Array {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('Secure randomness unavailable (crypto.getRandomValues missing).');
  }
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}

// -------------------- dual-key paycode mapping --------------------

function spendTweakFromScanPub(scanPub33: Uint8Array): bigint {
  if (!(scanPub33 instanceof Uint8Array) || scanPub33.length !== 33) {
    throw new Error('spendTweakFromScanPub: scanPub33 must be 33 bytes');
  }
  const tag = new TextEncoder().encode('bch-stealth:rpa:spend:');
  const h = sha256(concat(tag, scanPub33));
  return modN(bytesToBigInt(h));
}

/** Public-only: derive spend pubkey R from scan pubkey Q. */
export function deriveSpendPub33FromScanPub33(scanPub33: Uint8Array): Uint8Array {
  const t = spendTweakFromScanPub(scanPub33);
  if (t === 0n) return scanPub33; // astronomically unlikely fallback
  const Q = secp256k1.Point.fromHex(bytesToHex(scanPub33));
  const R = secp256k1.Point.BASE.multiply(t).add(Q);
  return R.toBytes(true);
}

/** Private-only: derive spend priv f from scan priv d (and implied Q). */
export function deriveSpendPriv32FromScanPriv32(scanPriv32: Uint8Array): Uint8Array {
  if (!(scanPriv32 instanceof Uint8Array) || scanPriv32.length !== 32) {
    throw new Error('deriveSpendPriv32FromScanPriv32: scanPriv32 must be 32 bytes');
  }
  const scanPub33 = secp256k1.getPublicKey(scanPriv32, true);
  const t = spendTweakFromScanPub(scanPub33);
  const f = modN(bytesToBigInt(scanPriv32) + t);
  return bigIntToBytes(f, 32);
}

// -------------------- core primitives --------------------

export function buildRpaContext(args: RpaContext): RpaContext {
  const { paycodeId, senderPub33, prevoutTxidHex, prevoutN, index, mode } = args;

  assertMode(mode);

  if (!(senderPub33 instanceof Uint8Array) || senderPub33.length !== 33) {
    throw new Error('buildRpaContext: senderPub33 must be 33 bytes');
  }
  if (typeof prevoutTxidHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(prevoutTxidHex)) {
    throw new Error('buildRpaContext: prevoutTxidHex must be 64 hex chars');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('buildRpaContext: prevoutN must be non-negative integer');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('buildRpaContext: index must be non-negative integer');
  }

  return {
    paycodeId: paycodeId ?? null,
    senderPub33,
    prevoutTxidHex,
    prevoutN,
    index,
    mode,
  };
}

/**
 * JS port of EC-style shared secret:
 *  shared_secret = sha256( toBytes( sha256(x33) + sha256(outpointStr) ) )
 */
export function calculatePaycodeSharedSecret(
  privateKeyBytes: Uint8Array,
  publicKey33: Uint8Array,
  outpointStr: string
): Uint8Array {
  if (!(privateKeyBytes instanceof Uint8Array) || privateKeyBytes.length !== 32) {
    throw new Error('privateKeyBytes must be 32-byte Uint8Array');
  }
  if (!(publicKey33 instanceof Uint8Array) || publicKey33.length !== 33) {
    throw new Error('publicKey33 must be 33-byte compressed pubkey');
  }
  if (typeof outpointStr !== 'string' || outpointStr.length === 0) {
    throw new Error('outpointStr must be a non-empty string');
  }

  const privBig = bytesToBigInt(privateKeyBytes);
  const pubPoint = secp256k1.Point.fromHex(bytesToHex(publicKey33));

  // ECDH: e * Q
  const product = pubPoint.multiply(privBig);
  const { x: xBig } = product.toAffine();

  // x -> 33-byte big-endian (EC does to_bytes(33))
  const xHex32 = xBig.toString(16).padStart(64, '0');
  const xHex33 = xHex32.padStart(66, '0');
  const xBytes33 = hexToBytes(xHex33);

  const shaX = sha256(xBytes33);
  const shaXBig = bytesToBigInt(shaX);

  const outBytes = new TextEncoder().encode(outpointStr);
  const outHash = sha256(outBytes);
  const outBig = bytesToBigInt(outHash);

  const grand = shaXBig + outBig;
  const grandHex = grand.toString(16);
  const grandHexEven = grandHex.length % 2 ? '0' + grandHex : grandHex;
  const grandBytes = hexToBytes(grandHexEven);

  return sha256(grandBytes);
}

/**
 * Minimal BIP32 CKDpub: non-hardened child with chainCode = secret (32 bytes).
 * childPub = (IL*G) + parentPub, where I = HMAC-SHA512(chainCode, serP(parent)||ser32(index))
 */
export function ckdPubFromSecret(parentPub33: Uint8Array, chainCode: Uint8Array, index = 0): Uint8Array {
  if (!(parentPub33 instanceof Uint8Array) || parentPub33.length !== 33) {
    throw new Error('parentPub33 must be 33-byte compressed pubkey');
  }
  if (!(chainCode instanceof Uint8Array) || chainCode.length !== 32) {
    throw new Error('chainCode must be 32-byte Uint8Array');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index must be a non-negative integer');
  }

  const data = concat(parentPub33, uint32be(index));
  const I = hmacSHA512(chainCode, data);
  const IL = I.slice(0, 32);

  const ilBig = bytesToBigInt(IL) % curveOrder();
  if (ilBig === 0n) throw new Error('Invalid derived IL (zero) in ckdPub');

  const parentPoint = secp256k1.Point.fromHex(bytesToHex(parentPub33));
  const childPoint = secp256k1.Point.BASE.multiply(ilBig).add(parentPoint);

  return childPoint.toBytes(true);
}

/**
 * Minimal BIP32 CKDpriv: non-hardened child with chainCode = secret (32 bytes).
 * childPriv = (IL + parentPriv) mod n
 */
export function ckdPrivFromSecret(parentPriv: Uint8Array, chainCode: Uint8Array, index = 0): Uint8Array {
  if (!(parentPriv instanceof Uint8Array) || parentPriv.length !== 32) {
    throw new Error('parentPriv must be 32-byte Uint8Array');
  }
  if (!(chainCode instanceof Uint8Array) || chainCode.length !== 32) {
    throw new Error('chainCode must be 32-byte Uint8Array');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index must be a non-negative integer');
  }

  const parentPub33 = secp256k1.getPublicKey(parentPriv, true);
  const data = concat(parentPub33, uint32be(index));
  const I = hmacSHA512(chainCode, data);
  const IL = I.slice(0, 32);

  const ilBig = bytesToBigInt(IL) % curveOrder();
  const kparBig = bytesToBigInt(parentPriv) % curveOrder();
  const childPrivBig = (ilBig + kparBig) % curveOrder();

  if (childPrivBig === 0n) throw new Error('Invalid derived private key (zero) in ckdPriv');
  return bigIntToBytes(childPrivBig, 32);
}

// -------------------- sender/receiver derivations --------------------

/**
 * Fulcrum RPA "grind prefix" derived from receiver scan pubkey Q.
 * Returns 16-bit prefix (2 bytes => 4 hex chars) for Fulcrum prefix_bits=16.
 */
export function deriveFulcrumRpaPrefix16FromScanPub33(scanPub33: Uint8Array): string {
  if (!(scanPub33 instanceof Uint8Array) || scanPub33.length !== 33) {
    throw new Error('deriveFulcrumRpaPrefix16FromScanPub33: scanPub33 must be 33 bytes');
  }
  const tag = new TextEncoder().encode('bch-stealth:rpa:grind:');
  const h = sha256(concat(tag, scanPub33));
  return bytesToHex(h.slice(0, 2)).toLowerCase();
}

/** Convenience for legacy servers / min prefix_bits=8. */
export function prefix8FromPrefix16(prefix16: string): string {
  const p = String(prefix16 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{4}$/.test(p)) throw new Error('prefix8FromPrefix16: expected 4 hex chars');
  return p.slice(0, 2);
}

export function deriveRpaOneTimeAddressSender(
  senderPrivBytes: Uint8Array,
  scanPub33: Uint8Array,
  spendPub33: Uint8Array,
  prevoutHashHex: string,
  prevoutN: number,
  index = 0
): { address: string | null; childPubkey: Uint8Array; childHash160: Uint8Array; sharedSecret: Uint8Array } {
  if (!(senderPrivBytes instanceof Uint8Array) || senderPrivBytes.length !== 32) {
    throw new Error('senderPrivBytes must be 32-byte Uint8Array');
  }
  if (!(scanPub33 instanceof Uint8Array) || scanPub33.length !== 33) {
    throw new Error('scanPub33 must be 33-byte compressed pubkey');
  }
  if (!(spendPub33 instanceof Uint8Array) || spendPub33.length !== 33) {
    throw new Error('spendPub33 must be 33-byte compressed pubkey');
  }
  if (typeof prevoutHashHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(prevoutHashHex)) {
    throw new Error('prevoutHashHex must be 32-byte txid hex (64 chars)');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('prevoutN must be a non-negative integer');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index must be a non-negative integer');
  }

  const outpointStr = `${prevoutHashHex}${String(prevoutN)}`;
  const sharedSecret = calculatePaycodeSharedSecret(senderPrivBytes, scanPub33, outpointStr);

  const childPubkey = ckdPubFromSecret(spendPub33, sharedSecret, index);
  const childHash160 = hash160(childPubkey);

  return { address: null, childPubkey, childHash160, sharedSecret };
}

// ✅ Synthesized: deriveRpaOneTimePrivReceiver (current version + optional sharedSecret32 reuse)

export function deriveRpaOneTimePrivReceiver(
  scanPrivBytes: Uint8Array,
  spendPrivBytes: Uint8Array,
  senderPub33: Uint8Array,
  prevoutHashHex: string,
  prevoutN: number,
  index = 0,
  // (optional): caller may provide a precomputed sharedSecret to avoid recomputing per-index
  sharedSecret32: Uint8Array | null = null
): { oneTimePriv: Uint8Array; sharedSecret: Uint8Array } {
  if (!(scanPrivBytes instanceof Uint8Array) || scanPrivBytes.length !== 32) {
    throw new Error('scanPrivBytes must be 32-byte Uint8Array');
  }
  if (!(spendPrivBytes instanceof Uint8Array) || spendPrivBytes.length !== 32) {
    throw new Error('spendPrivBytes must be 32-byte Uint8Array');
  }
  if (!(senderPub33 instanceof Uint8Array) || senderPub33.length !== 33) {
    throw new Error('senderPub33 must be 33-byte compressed pubkey');
  }
  if (typeof prevoutHashHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(prevoutHashHex)) {
    throw new Error('prevoutHashHex must be 32-byte txid hex (64 chars)');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('prevoutN must be a non-negative integer');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index must be a non-negative integer');
  }
  if (sharedSecret32 != null) {
    if (!(sharedSecret32 instanceof Uint8Array) || sharedSecret32.length !== 32) {
      throw new Error('sharedSecret32 must be 32-byte Uint8Array when provided');
    }
  }

  const outpointStr = `${prevoutHashHex}${String(prevoutN)}`;

  // ✅ compute shared secret once per (scanPrivBytes, senderPub33, outpointStr) when caller provides it
  const sharedSecret =
    sharedSecret32 ?? calculatePaycodeSharedSecret(scanPrivBytes, senderPub33, outpointStr);

  // ✅ per-index derivation remains the same
  const oneTimePriv = ckdPrivFromSecret(spendPrivBytes, sharedSecret, index);

  return { oneTimePriv, sharedSecret };
}

// Optional convenience helper (encourages callers to do the 1x-per-input computation)
export function deriveRpaSharedSecretReceiver(
  scanPrivBytes: Uint8Array,
  senderPub33: Uint8Array,
  prevoutHashHex: string,
  prevoutN: number
): Uint8Array {
  if (!(scanPrivBytes instanceof Uint8Array) || scanPrivBytes.length !== 32) {
    throw new Error('scanPrivBytes must be 32-byte Uint8Array');
  }
  if (!(senderPub33 instanceof Uint8Array) || senderPub33.length !== 33) {
    throw new Error('senderPub33 must be 33-byte compressed pubkey');
  }
  if (typeof prevoutHashHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(prevoutHashHex)) {
    throw new Error('prevoutHashHex must be 32-byte txid hex (64 chars)');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('prevoutN must be a non-negative integer');
  }

  const outpointStr = `${prevoutHashHex}${String(prevoutN)}`;
  return calculatePaycodeSharedSecret(scanPrivBytes, senderPub33, outpointStr);
}

export function deriveRpaSessionKeys(sharedSecret: Uint8Array, txidHex = '', vout = 0): RpaSessionKeys {
  if (!(sharedSecret instanceof Uint8Array) || sharedSecret.length !== 32) {
    throw new Error('sharedSecret must be 32-byte Uint8Array');
  }
  if (typeof txidHex !== 'string') {
    throw new Error('txidHex must be a string');
  }
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error('vout must be a non-negative integer');
  }

  const ctx = new TextEncoder().encode(`${txidHex}:${vout}`);
  const base = sha256(concat(sharedSecret, ctx)); // session_key

  const amountKey = sha256(concat(base, new TextEncoder().encode('amount'))).slice(0, 16);
  const memoKey = sha256(concat(base, new TextEncoder().encode('memo'))).slice(0, 16);
  const zkSeed = sha256(concat(base, new TextEncoder().encode('zk-seed')));

  return { sessionKey: base, amountKey, memoKey, zkSeed };
}

// -------------------- lock intent --------------------

export function deriveRpaLockIntent(params: DeriveRpaLockIntentParams): RpaLockIntent {
  const {
    mode,
    senderPrivBytes,
    receiverScanPub33,
    receiverSpendPub33 = null,
    prevoutTxidHex,
    prevoutN,
    index = 0,
    extraCtx = new Uint8Array(0),
    paycodeId = null,
  } = params;

  assertMode(mode);

  if (!(senderPrivBytes instanceof Uint8Array) || senderPrivBytes.length !== 32) {
    throw new Error('deriveRpaLockIntent: senderPrivBytes must be 32-byte Uint8Array');
  }
  if (!(receiverScanPub33 instanceof Uint8Array) || receiverScanPub33.length !== 33) {
    throw new Error('deriveRpaLockIntent: receiverScanPub33 must be 33-byte compressed pubkey');
  }
  if (
    receiverSpendPub33 != null &&
    (!(receiverSpendPub33 instanceof Uint8Array) || receiverSpendPub33.length !== 33)
  ) {
    throw new Error('deriveRpaLockIntent: receiverSpendPub33 must be 33 bytes (or null)');
  }
  if (typeof prevoutTxidHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(prevoutTxidHex)) {
    throw new Error('deriveRpaLockIntent: prevoutTxidHex must be 64 hex chars');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('deriveRpaLockIntent: prevoutN must be non-negative integer');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('deriveRpaLockIntent: index must be non-negative integer');
  }
  if (!(extraCtx instanceof Uint8Array)) {
    throw new Error('deriveRpaLockIntent: extraCtx must be Uint8Array');
  }

  const senderPub33 = secp256k1.getPublicKey(senderPrivBytes, true);

  const scanQ = receiverScanPub33;
  const spendR = receiverSpendPub33 ?? deriveSpendPub33FromScanPub33(scanQ);

  const { address, childPubkey, childHash160, sharedSecret } = deriveRpaOneTimeAddressSender(
    senderPrivBytes,
    scanQ,
    spendR,
    prevoutTxidHex,
    prevoutN,
    index
  );

  const { amountKey, memoKey, zkSeed } = deriveRpaSessionKeys(sharedSecret, prevoutTxidHex, prevoutN);

  const context = buildRpaContext({
    paycodeId,
    senderPub33,
    prevoutTxidHex,
    prevoutN,
    index,
    mode,
  });

  return {
    mode,
    address,
    childPubkey,
    childHash160,
    sharedSecret,
    session: { amountKey, memoKey, zkSeed },
    extraCtx,
    context,
  };
}

// -------------------- legacy demo amount helpers (kept for compatibility) --------------------

export function encryptAmount(ephemPrivBytes: Uint8Array, receiverPubBytes: Uint8Array, amount: number): Uint8Array {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be positive number');
  }
  if (!(ephemPrivBytes instanceof Uint8Array) || ephemPrivBytes.length !== 32) {
    throw new Error('ephemPrivBytes must be 32-byte Uint8Array');
  }
  if (!(receiverPubBytes instanceof Uint8Array) || (receiverPubBytes.length !== 33 && receiverPubBytes.length !== 32)) {
    throw new Error('receiverPubBytes must be 32 or 33-byte Uint8Array');
  }

  const sharedSecret = secp256k1.getSharedSecret(ephemPrivBytes, receiverPubBytes);
  const aesKey = sha256(sharedSecret).slice(0, 16);
  const iv = randomBytesCompat(16);

  const amountData = `{"v":${amount}}`;
  const aesCtr = new aesjs.ModeOfOperation.ctr(aesKey, new aesjs.Counter(iv));
  const ciphertext = aesCtr.encrypt(new TextEncoder().encode(amountData));

  return concat(iv, ciphertext);
}

export function decryptAmount(privBytes: Uint8Array, senderEphemPubBytes: Uint8Array, encryptedAmount: Uint8Array): string {
  if (!(privBytes instanceof Uint8Array) || privBytes.length !== 32) {
    throw new Error('privBytes must be 32-byte Uint8Array');
  }
  if (!(senderEphemPubBytes instanceof Uint8Array) || (senderEphemPubBytes.length !== 33 && senderEphemPubBytes.length !== 32)) {
    throw new Error('senderEphemPubBytes must be 32 or 33-byte Uint8Array');
  }
  if (!(encryptedAmount instanceof Uint8Array) || encryptedAmount.length < 16) {
    throw new Error('encryptedAmount must be Uint8Array >= 16 bytes');
  }

  const sharedSecret = secp256k1.getSharedSecret(privBytes, senderEphemPubBytes);
  const aesKey = sha256(sharedSecret).slice(0, 16);

  const iv = encryptedAmount.slice(0, 16);
  const ciphertext = encryptedAmount.slice(16);

  const aesCtr = new aesjs.ModeOfOperation.ctr(aesKey, new aesjs.Counter(iv));
  const decryptedBytes = aesCtr.decrypt(ciphertext);

  return new TextDecoder().decode(decryptedBytes);
}