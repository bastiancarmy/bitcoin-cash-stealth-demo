import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { pow } from '@noble/curves/abstract/modular.js';

export { sha256, ripemd160 };

export function shuffleArray<T>(array: T[]): T[] {
  return array.sort(() => Math.random() - 0.5);
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytesToNumberBE(bytes);
}

export function bigIntToBytes(big: bigint, len: number): Uint8Array {
  return numberToBytesBE(big, len) as unknown as Uint8Array;
}

export function hexToBytes(hex: string | Uint8Array | number[]): Uint8Array {
  if (hex instanceof Uint8Array) return hex;
  if (Array.isArray(hex)) return Uint8Array.from(hex);
  if (typeof hex !== 'string') {
    throw new TypeError(`hexToBytes expected string/Uint8Array/number[], got ${typeof hex}`);
  }

  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('hexToBytes: hex length must be even');
  if (h.length === 0) return new Uint8Array();

  const m = h.match(/.{2}/g);
  if (!m) return new Uint8Array();

  return Uint8Array.from(m.map((b) => parseInt(b, 16)));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function concat(...arrays: (Uint8Array | Uint8Array[])[]): Uint8Array {
  // allow concat([a,b,c]) OR concat(a,b,c)
  let parts: Uint8Array[];
  if (arrays.length === 1 && Array.isArray(arrays[0])) parts = arrays[0] as Uint8Array[];
  else parts = arrays as Uint8Array[];

  let totalLen = 0;
  for (const a of parts) {
    if (!(a instanceof Uint8Array)) throw new TypeError('concat: all chunks must be Uint8Array');
    totalLen += a.length;
  }

  const res = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of parts) {
    res.set(a, offset);
    offset += a.length;
  }
  return res;
}

export function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function _hash160(x: Uint8Array): Uint8Array {
  return ripemd160(sha256(x));
}

export function reverseBytes(bytes: Uint8Array): Uint8Array {
  const rev = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) rev[i] = bytes[bytes.length - 1 - i];
  return rev;
}

export function uint16le(num: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = num & 0xff;
  buf[1] = (num >> 8) & 0xff;
  return buf;
}

export function uint32le(num: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = num & 0xff;
  buf[1] = (num >> 8) & 0xff;
  buf[2] = (num >> 16) & 0xff;
  buf[3] = (num >> 24) & 0xff;
  return buf;
}

export function uint64le(num: number | bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let n = BigInt(num);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

export function minimalEncode(num: number | bigint): Uint8Array {
  let n = typeof num === 'number' ? BigInt(num) : num;
  if (n === 0n) return new Uint8Array([]);
  const isNegative = n < 0n;
  n = isNegative ? -n : n;

  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }

  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(isNegative ? 0x80 : 0x00);
  } else if (isNegative) {
    bytes[bytes.length - 1] |= 0x80;
  }
  return Uint8Array.from(bytes);
}

export function minimalScriptNumber(n: number | bigint): Uint8Array {
  let v = typeof n === 'bigint' ? n : BigInt(n);
  if (v === 0n) return new Uint8Array([]);

  const negative = v < 0n;
  if (negative) v = -v;

  const out: number[] = [];
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }

  if (out[out.length - 1] & 0x80) {
    out.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    out[out.length - 1] |= 0x80;
  }

  return Uint8Array.from(out);
}

export function varInt(val: number): Uint8Array {
  if (val < 0xfd) return Uint8Array.from([val]);
  if (val <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    new DataView(b.buffer).setUint16(1, val, true);
    return b;
  }
  if (val <= 0xffffffff) {
    const b = new Uint8Array(5);
    b[0] = 0xfe;
    new DataView(b.buffer).setUint32(1, val, true);
    return b;
  }
  const b = new Uint8Array(9);
  b[0] = 0xff;
  new DataView(b.buffer).setBigUint64(1, BigInt(val), true);
  return b;
}

export function decodeVarInt(u8: Uint8Array, offset = 0): { value: number; size: number; length: number } {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('u8 must be Uint8Array');
  if (!Number.isInteger(offset) || offset < 0 || offset >= u8.length) {
    throw new Error('Invalid or too large VarInt');
  }

  const fb = u8[offset];

  if (fb < 0xfd) return { value: fb, size: 1, length: 1 };

  if (fb === 0xfd) {
    if (offset + 3 > u8.length) throw new Error('Invalid or too large VarInt');
    const v = u8[offset + 1] | (u8[offset + 2] << 8);
    return { value: v, size: 3, length: 3 };
  }

  if (fb === 0xfe) {
    if (offset + 5 > u8.length) throw new Error('Invalid or too large VarInt');
    const v = u8[offset + 1] | (u8[offset + 2] << 8) | (u8[offset + 3] << 16) | (u8[offset + 4] << 24);
    return { value: v >>> 0, size: 5, length: 5 };
  }

  throw new Error('Invalid or too large VarInt');
}

export function debugLog(...args: unknown[]): void {
  if (process.env.DEBUG) console.log(...args);
}

// HMAC-SHA256 helper (typed to satisfy noble + TS typed-array generics)
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  // noble returns Uint8Array<ArrayBufferLike>; we expose as plain Uint8Array to avoid generic incompatibilities
  return hmac(sha256, key, msg) as unknown as Uint8Array;
}

// RFC6979 with 16-byte “Schnorr+SHA256␣␣” additional data
export function rfc6979(d: bigint, h1: Uint8Array): bigint {
  const additional = utf8ToBytes('Schnorr+SHA256  ');
  h1 = concat(h1, additional);

  const curve = secp256k1.Point.CURVE();
  const n = curve.n;

  const hlen = 32;

  // IMPORTANT: explicitly widen to Uint8Array (ArrayBufferLike) so assignments from noble hash outputs type-check
  let V: Uint8Array = new Uint8Array(hlen).fill(0x01);
  let K: Uint8Array = new Uint8Array(hlen).fill(0x00);

  const x = bigIntToBytes(d, 32);
  h1 = bigIntToBytes(bytesToBigInt(h1) % n, 32);

  K = hmacSha256(K, concat(V, Uint8Array.from([0x00]), x, h1));
  V = hmacSha256(K, V);
  K = hmacSha256(K, concat(V, Uint8Array.from([0x01]), x, h1));
  V = hmacSha256(K, V);

  while (true) {
    let T: Uint8Array = new Uint8Array(0);
    while (T.length < hlen) {
      V = hmacSha256(K, V);
      T = concat(T, V);
    }
    const k = bytesToBigInt(T) % n;
    if (k > 0n) return k;
    K = hmacSha256(K, concat(V, Uint8Array.from([0x00])));
    V = hmacSha256(K, V);
  }
}

// Field/order and base point
const curve = secp256k1.Point.CURVE();
const p = curve.p;
const n = curve.n;
const G = secp256k1.Point.BASE;
const Point = secp256k1.Point;

// Efficient (p ≡ 3 mod 4) Jacobi(y) via Euler’s criterion
function jacobi(y: bigint): bigint {
  // Returns 1 for quadratic residues, p-1 for non-residues, 0 only if y ≡ 0 (not our case).
  return pow(y % p, (p - 1n) / 2n, p);
}

/** BCH 2019 Schnorr sign: returns 64 bytes (r||s) */
export function bchSchnorrSign(sighash: Uint8Array, privBytes: Uint8Array, pubBytes: Uint8Array): Uint8Array {
  if (sighash.length !== 32 || pubBytes.length !== 33) throw new Error('Invalid inputs');
  const d = bytesToBigInt(privBytes) % n;
  if (d === 0n) throw new Error('Invalid priv');

  let k = rfc6979(d, sighash);

  let R = G.multiply(k);
  let { x: Rx, y: Ry } = R.toAffine();
  const jac = jacobi(Ry);
  if (jac === 0n) throw new Error('Invalid R Jacobi');
  if (jac !== 1n) {
    k = n - k;
    R = G.multiply(k);
    ({ x: Rx, y: Ry } = R.toAffine());
  }

  const rBytes = numberToBytesBE(Rx, 32) as unknown as Uint8Array;

  const eBytes = sha256(concat(rBytes, pubBytes, sighash));
  const e = bytesToBigInt(eBytes) % n;

  const s = (k + e * d) % n;
  const sBytes = numberToBytesBE(s, 32) as unknown as Uint8Array;

  return concat(rBytes, sBytes);
}

/** BCH 2019 Schnorr verify */
export function bchSchnorrVerify(sig: Uint8Array, sighash: Uint8Array, pubBytes: Uint8Array): boolean {
  if (sighash.length !== 32 || pubBytes.length !== 33) return false;

  const sig64 = sig.length === 65 ? sig.slice(0, 64) : sig;
  if (sig64.length !== 64) return false;

  const rx = bytesToBigInt(sig64.slice(0, 32));
  const s = bytesToBigInt(sig64.slice(32));
  if (rx >= p || s >= n) return false;

  type PointInstance = typeof Point.BASE;

  let P: PointInstance;
  try {
    P = Point.fromBytes(pubBytes);
  } catch {
    return false;
  }
  if (P.equals(Point.ZERO)) return false;

  const rxBytes = numberToBytesBE(rx, 32) as unknown as Uint8Array;

  const eBytes = sha256(concat(rxBytes, pubBytes, sighash));
  const e = bytesToBigInt(eBytes) % n;

  const Rprime: PointInstance = G.multiply(s).subtract(P.multiply(e));
  if (Rprime.equals(Point.ZERO)) return false;

  const { x: Rpx, y: Rpy } = Rprime.toAffine();
  if (Rpx !== rx) return false;

  return jacobi(Rpy) === 1n;
}

// Get 32-byte x-only pubkey (drop parity byte if compressed)
export function getXOnlyPub(pubBytes: Uint8Array): Uint8Array {
  if (pubBytes.length === 32) return pubBytes;
  if (pubBytes.length !== 33 || (pubBytes[0] !== 0x02 && pubBytes[0] !== 0x03)) {
    throw new Error('Invalid pubkey for x-only');
  }
  return pubBytes.slice(1);
}

// Negate privkey if pubkey has odd y-parity (for even y in Schnorr)
export function ensureEvenYPriv(privBytes: Uint8Array): Uint8Array {
  let pubBytes = secp256k1.getPublicKey(privBytes, true);
  let pubPoint = Point.fromBytes(pubBytes);
  const affine = pubPoint.toAffine();

  if ((affine.y & 1n) === 1n) {
    let privBig = bytesToNumberBE(privBytes) % n;
    privBig = n - privBig;
    privBytes = numberToBytesBE(privBig, 32) as unknown as Uint8Array;

    pubBytes = secp256k1.getPublicKey(privBytes, true);
    pubPoint = Point.fromBytes(pubBytes);
    const affineConfirm = pubPoint.toAffine();
    if ((affineConfirm.y & 1n) === 1n) throw new Error('Parity enforcement failed');
  }
  return privBytes;
}

import type { WalletId } from './pool/wallet_ids.js';
import { WALLET_A, WALLET_B } from './pool/wallet_ids.js';

function canonicalizeOwnerId(owner: unknown): WalletId | null {
  const s = String(owner ?? '').toLowerCase().trim();

  // canonical
  if (s === WALLET_A.id) return WALLET_A.id;
  if (s === WALLET_B.id) return WALLET_B.id;

  // legacy aliases
  if (s === 'alice' || s === 'actor_a' || s === 'a') return WALLET_A.id;
  if (s === 'bob' || s === 'actor_b' || s === 'b') return WALLET_B.id;

  return null;
}

function normalizeOwnersInState(st: any): void {
  if (!st || typeof st !== 'object') return;
  if (!Array.isArray(st.stealthUtxos)) return;

  for (const r of st.stealthUtxos) {
    if (!r || typeof r !== 'object') continue;
    const canon = canonicalizeOwnerId((r as any).owner);
    if (canon) (r as any).owner = canon;
  }
}