// packages/utils/src/bytes.ts
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';

/** Random shuffle (not cryptographically secure). */
export function shuffleArray<T>(array: T[]): T[] {
  return array.sort(() => Math.random() - 0.5);
}

/** Convert bytes to bigint (big-endian). */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytesToNumberBE(bytes);
}

/** Convert bigint to fixed-length bytes (big-endian). */
export function bigIntToBytes(big: bigint, len: number): Uint8Array {
  return numberToBytesBE(big, len);
}

/** Accept hex string, Uint8Array, or number[] and return Uint8Array. */
export function hexToBytes(hex: string | Uint8Array | number[]): Uint8Array {
  if (hex instanceof Uint8Array) return hex; // accept bytes (Buffer too)
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
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Concatenate Uint8Array chunks. Allows concat(a,b,c) or concat([a,b,c]). */
export function concat(...arrays: (Uint8Array | Uint8Array[])[]): Uint8Array {
  // allow concat([a,b,c]) OR concat(a,b,c)
  if (arrays.length === 1 && Array.isArray(arrays[0])) arrays = arrays[0] as any;

  let totalLen = 0;
  for (const a of arrays as Uint8Array[]) {
    if (!(a instanceof Uint8Array)) {
      throw new TypeError('concat: all chunks must be Uint8Array');
    }
    totalLen += a.length;
  }

  const res = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays as Uint8Array[]) {
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

/** Minimal-encode signed integer to bitcoin script number format. */
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

  // If the top bit of the last byte is set, add a sign byte.
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(isNegative ? 0x80 : 0x00);
  } else if (isNegative) {
    bytes[bytes.length - 1] |= 0x80;
  }

  return new Uint8Array(bytes);
}

/** Minimal script number encoding (same behavior as your minimalScriptNumber). */
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

  return new Uint8Array(out);
}

export function debugLog(...args: unknown[]): void {
  if (process.env.DEBUG) console.log(...args);
}

/** Token category normalizer used in token_data handling. */
export function normalizeCategory32(cat: unknown): Uint8Array | null {
  if (cat == null) return null;

  // Buffer is a Uint8Array subclass, so this covers Buffer too
  if (cat instanceof Uint8Array) {
    if (cat.length !== 32) throw new Error(`token category must be 32 bytes, got ${cat.length}`);
    return cat;
  }

  // Some parsers return number[]
  if (Array.isArray(cat)) {
    const u8 = Uint8Array.from(cat);
    if (u8.length !== 32) throw new Error(`token category must be 32 bytes, got ${u8.length}`);
    return u8;
  }

  if (typeof cat === 'string') {
    const hex = cat.startsWith('0x') ? cat.slice(2) : cat;
    const u8 = hexToBytes(hex);
    if (u8.length !== 32) throw new Error(`token category must be 32 bytes, got ${u8.length}`);
    return u8;
  }

  throw new TypeError(`unexpected token_data.category type: ${typeof cat}`);
}