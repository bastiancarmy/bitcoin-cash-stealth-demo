// src/utils.js
import { sha256 } from '@noble/hashes/sha2.js';
import { base58checkDecode } from './base58.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';
import { hmac } from '@noble/hashes/hmac.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { pow } from '@noble/curves/abstract/modular.js';

export { sha256 } from '@noble/hashes/sha2.js';
export { ripemd160 } from '@noble/hashes/legacy.js';

export function shuffleArray(array) {
  return array.sort(() => Math.random() - 0.5);
}

export function bytesToBigInt(bytes) {
  return bytesToNumberBE(bytes);
}

export function bigIntToBytes(big, len) {
  return numberToBytesBE(big, len);
}

export function hexToBytes(hex) {
  if (hex instanceof Uint8Array) return hex;           // accept bytes (Buffer too)
  if (Array.isArray(hex)) return Uint8Array.from(hex); // accept number[]
  if (typeof hex !== 'string') {
    throw new TypeError(`hexToBytes expected string/Uint8Array/number[], got ${typeof hex}`);
  }

  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('hexToBytes: hex length must be even');
  if (h.length === 0) return new Uint8Array();

  return Uint8Array.from(h.match(/.{2}/g).map(b => parseInt(b, 16)));
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function concat(...arrays) {
  // allow concat([a,b,c]) OR concat(a,b,c)
  if (arrays.length === 1 && Array.isArray(arrays[0])) arrays = arrays[0];

  let totalLen = 0;
  for (const a of arrays) {
    if (!(a instanceof Uint8Array)) {
      throw new TypeError('concat: all chunks must be Uint8Array');
    }
    totalLen += a.length;
  }

  const res = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    res.set(a, offset);
    offset += a.length;
  }
  return res;
}

export function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function _hash160(x) {
  return ripemd160(sha256(x));
}

export function reverseBytes(bytes) {
  const rev = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) rev[i] = bytes[bytes.length - 1 - i];
  return rev;
}

export function uint32le(num) {
  const buf = new Uint8Array(4);
  buf[0] = num & 0xff;
  buf[1] = (num >> 8) & 0xff;
  buf[2] = (num >> 16) & 0xff;
  buf[3] = (num >> 24) & 0xff;
  return buf;
}

export function uint64le(num) {
  const buf = new Uint8Array(8);
  let n = BigInt(num);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return buf;
}

export function minimalEncode(num) {
  if (typeof num === 'number') num = BigInt(num);
  if (num === 0n) return new Uint8Array([]);
  const isNegative = num < 0n;
  num = isNegative ? -num : num;
  const bytes = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  // If the top bit of the last byte is set, add a zero byte to indicate positive
  if (bytes[bytes.length - 1] & 0x80) {
    bytes.push(isNegative ? 0x80 : 0x00);
  } else if (isNegative) {
    bytes[bytes.length - 1] |= 0x80;
  }
  return new Uint8Array(bytes);
}

export function minimalScriptNumber(n) {
  let v = (typeof n === 'bigint') ? n : BigInt(n);
  if (v === 0n) return new Uint8Array([]);

  const negative = v < 0n;
  if (negative) v = -v;

  const out = [];
  while (v > 0n) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  // If highest bit set, append a sign byte.
  if (out[out.length - 1] & 0x80) {
    out.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    out[out.length - 1] |= 0x80;
  }
  return new Uint8Array(out);
}

export function varInt(val) {
  if (val < 0xfd) return new Uint8Array([val]);
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

export function decodeVarInt(u8, offset = 0) {
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
    const v =
      (u8[offset + 1]) |
      (u8[offset + 2] << 8) |
      (u8[offset + 3] << 16) |
      (u8[offset + 4] << 24);
    return { value: v >>> 0, size: 5, length: 5 };
  }

  // 0xff (8-byte) not needed for your tx parsing; reject
  throw new Error('Invalid or too large VarInt');
}

export function modInverse(a, m) {
  a = (a % m + m) % m;
  let m0 = m;
  let y = 0n, x = 1n;
  if (m === 1n) return 0n;
  while (a > 1n) {
    const q = a / m;
    let t = m;
    m = a % m;
    a = t;
    t = BigInt(y);
    y = x - q * BigInt(y);
    x = t;
  }
  if (x < 0n) x += m0;
  return x;
}

export function uint16le(num) {
  const buf = new Uint8Array(2);
  buf[0] = num & 0xff;
  buf[1] = (num >> 8) & 0xff;
  return buf;
}

export function debugLog(...args) {
  if (process.env.DEBUG) console.log(...args);
}

// HMAC-SHA256 helper
export function hmacSha256(key, msg) {
  return hmac(sha256, key, msg);
}

// RFC6979 with 16-byte “Schnorr+SHA256␣␣” additional data
export function rfc6979(d, h1) {
  const additional = utf8ToBytes('Schnorr+SHA256  ');
  h1 = concat(h1, additional);
  const hlen = 32;
  let V = new Uint8Array(hlen).fill(0x01);
  let K = new Uint8Array(hlen).fill(0x00);
  const x = bigIntToBytes(d, 32);
  h1 = bigIntToBytes(bytesToBigInt(h1) % n, 32);
  K = hmacSha256(K, concat(V, new Uint8Array([0x00]), x, h1));
  V = hmacSha256(K, V);
  K = hmacSha256(K, concat(V, new Uint8Array([0x01]), x, h1));
  V = hmacSha256(K, V);
  while (true) {
    let T = new Uint8Array(0);
    while (T.length < hlen) {
      V = hmacSha256(K, V);
      T = concat(T, V);
    }
    const k = bytesToBigInt(T) % n;
    if (k > 0n) return k;
    K = hmacSha256(K, concat(V, new Uint8Array([0x00])));
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
function jacobi(y) {
  // Returns 1 for quadratic residues, p-1 for non-residues, 0 only if y ≡ 0 (not our case).
  return pow(y % p, (p - 1n) / 2n, p);
}

/** BCH 2019 Schnorr sign: returns 64 bytes (r||s) */
export function bchSchnorrSign(sighash, privBytes, pubBytes) {
  if (sighash.length !== 32 || pubBytes.length !== 33) throw new Error('Invalid inputs');
  const d = bytesToBigInt(privBytes) % n;
  if (d === 0n) throw new Error('Invalid priv');

  // RFC6979 nonce with domain separation
  let k = rfc6979(d, sighash);

  // Compute R = kG; flip k if Jacobi(y(R)) != 1
  let R = G.multiply(k);
  let { x: Rx, y: Ry } = R.toAffine();
  let jac = jacobi(Ry);
  if (jac === 0n) throw new Error('Invalid R Jacobi');
  if (jac !== 1n) {
    k = n - k;
    R = G.multiply(k);
    ({ x: Rx, y: Ry } = R.toAffine());
  }

  // e = H( r || compressed_pubkey || m )
  const rBytes = numberToBytesBE(Rx, 32);
  const eBytes = sha256(concat(rBytes, pubBytes, sighash));
  const e = bytesToBigInt(eBytes) % n;

  const s = (k + e * d) % n;
  return concat(rBytes, numberToBytesBE(s, 32));
}

/** BCH 2019 Schnorr verify: checks r < p, s < n, x(R') == r, and Jacobi(y(R')) == 1 */
export function bchSchnorrVerify(sig, sighash, pubBytes) {
  if (sighash.length !== 32 || pubBytes.length !== 33) return false;

  let sig64;
  if (sig.length === 65) {
    // For OP_CHECKSIG Schnorr signatures (65 bytes: r+s+hashtype), ignore hashtype and slice to r+s
    sig64 = sig.slice(0, 64);
  } else if (sig.length === 64) {
    sig64 = sig; // Backward compatibility for 64-byte sigs or OP_CHECKDATASIG
  } else {
    return false; // Invalid length
  }

  const rx = bytesToBigInt(sig64.slice(0, 32));
  const s  = bytesToBigInt(sig64.slice(32));
  if (rx >= p || s >= n) return false;

  let P;
  try {
    P = Point.fromBytes(pubBytes); // Validates on curve, not infinity
  } catch {
    return false;
  }
  if (P.equals(Point.ZERO)) return false;

  const eBytes = sha256(concat(numberToBytesBE(rx, 32), pubBytes, sighash));
  const e = bytesToBigInt(eBytes) % n;

  // R' = sG - eP  ==  (-e)P + sG
  const Rprime = G.multiply(s).subtract(P.multiply(e));
  if (Rprime.equals(Point.ZERO)) return false;

  const { x: Rpx, y: Rpy } = Rprime.toAffine();
  if (Rpx !== rx) return false;

  const j = jacobi(Rpy);
  if (j === 0n || j !== 1n) return false;

  return true;
}

export function pushDataPrefix(len) {
  if (len < 0x4c) {
    return new Uint8Array([len]);
  } else if (len <= 0xff) {
    return concat(new Uint8Array([0x4c]), new Uint8Array([len]));
  } else if (len <= 0xffff) {
    const le = new Uint8Array(2);
    le[0] = len & 0xff;
    le[1] = (len >> 8) & 0xff;
    return concat(new Uint8Array([0x4d]), le);
  } else if (len <= 0xffffffff) {
    const le = new Uint8Array(4);
    le[0] = len & 0xff;
    le[1] = (len >> 8) & 0xff;
    le[2] = (len >> 16) & 0xff;
    le[3] = (len >> 24) & 0xff;
    return concat(new Uint8Array([0x4e]), le);
  } else {
    throw new Error('Push data too large');
  }
}

export function extractPubKeyFromPaycode(paycode) {
  if (typeof paycode !== 'string' || !paycode.startsWith('PM')) {
    throw new Error('Invalid paycode format (must start with "PM" for BCH paycodes)');
  }
  const { version: decodedVersion, payload } = base58checkDecode(paycode);
  if (decodedVersion !== 0x47) {
    throw new Error('Unsupported paycode version');
  }
  if (payload.length < 79) { // 1(int_ver) +1(flags) +33(pub) +32(chain) +13(pad)=80, but pad flexible?
    throw new Error('Payload too short');
  }
  const pubKey = payload.slice(2, 35); // Correct: skip [0]=01, [1]=00, take [2:35]=33 bytes pub
  if (pubKey.length !== 33) {
    throw new Error(`Invalid public key length: got ${pubKey.length}, expected 33 (compressed)`);
  }
  try {
    Point.fromBytes(pubKey); // v2: Validates on curve
    console.log('✅ Valid secp256k1 point extracted from paycode');
  } catch (e) {
    console.error('Invalid public key bytes (hex):', bytesToHex(pubKey));
    throw new Error(`Invalid public key in paycode (not on secp256k1 curve): ${e.message}`);
  }
  return pubKey;
}

// Get 32-byte x-only pubkey (drop parity byte if compressed)
export function getXOnlyPub(pubBytes) {
  if (pubBytes.length === 32) return pubBytes;
  if (pubBytes.length !== 33 || (pubBytes[0] !== 0x02 && pubBytes[0] !== 0x03)) {
    throw new Error('Invalid pubkey for x-only');
  }
  return pubBytes.slice(1);
}

// Negate privkey if pubkey has odd y-parity (for even y in Schnorr)
export function ensureEvenYPriv(privBytes) {
  let pubBytes = secp256k1.getPublicKey(privBytes, true); // Use bytes
  let pubPoint = Point.fromBytes(pubBytes);
  const affine = pubPoint.toAffine();
  if ((affine.y & 1n) === 1n) { // Odd Y
    let privBig = bytesToNumberBE(privBytes); // Returns bigint
    privBig = n - privBig;
    privBytes = numberToBytesBE(privBig, 32);
    // Recompute to confirm
    pubBytes = secp256k1.getPublicKey(privBytes, true);
    pubPoint = Point.fromBytes(pubBytes);
    const affineConfirm = pubPoint.toAffine();
    if ((affineConfirm.y & 1n) === 1n) throw new Error('Parity enforcement failed');
  }
  return privBytes;
}

export function normalizeCategory32(cat) {
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