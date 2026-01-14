import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { pow } from '@noble/curves/abstract/modular.js';

import { bytesToBigInt, bigIntToBytes, concat } from '@bch-stealth/utils';
import { rfc6979 } from './rfc6979.js';

const curve = secp256k1.Point.CURVE();
const p = curve.p;
const n = curve.n;
const G = secp256k1.Point.BASE;
const Point = secp256k1.Point;

// Efficient (p ≡ 3 mod 4) Jacobi(y) via Euler’s criterion
function jacobi(y: bigint): bigint {
  return pow(y % p, (p - 1n) / 2n, p);
}

/** BCH 2019 Schnorr sign: returns 64 bytes (r||s) */
export function bchSchnorrSign(sighash: Uint8Array, privBytes: Uint8Array, pubBytes: Uint8Array): Uint8Array {
  if (sighash.length !== 32 || pubBytes.length !== 33) throw new Error('Invalid inputs');

  const d = bytesToBigInt(privBytes) % n;
  if (d === 0n) throw new Error('Invalid priv');

  // RFC6979 nonce with domain separation
  let k = rfc6979(d, sighash);

  // Compute R = kG; flip k if Jacobi(y(R)) != 1
  let R = G.multiply(k);
  let { x: Rx, y: Ry } = R.toAffine();

  const j = jacobi(Ry);
  if (j === 0n) throw new Error('Invalid R Jacobi');

  if (j !== 1n) {
    k = n - k;
    R = G.multiply(k);
    ({ x: Rx, y: Ry } = R.toAffine());
  }

  // e = H( r || compressed_pubkey || m )
  const rBytes = bigIntToBytes(Rx, 32);
  const eBytes = sha256(concat(rBytes, pubBytes, sighash));
  const e = bytesToBigInt(eBytes) % n;

  const s = (k + e * d) % n;
  return concat(rBytes, bigIntToBytes(s, 32));
}

/** BCH 2019 Schnorr verify */
export function bchSchnorrVerify(sig: Uint8Array, sighash: Uint8Array, pubBytes: Uint8Array): boolean {
  if (sighash.length !== 32 || pubBytes.length !== 33) return false;

  let sig64: Uint8Array;
  if (sig.length === 65) sig64 = sig.slice(0, 64);
  else if (sig.length === 64) sig64 = sig;
  else return false;

  const rx = bytesToBigInt(sig64.slice(0, 32));
  const s = bytesToBigInt(sig64.slice(32));
  if (rx >= p || s >= n) return false;

  let P;
  try {
    P = Point.fromBytes(pubBytes);
  } catch {
    return false;
  }
  if (P.equals(Point.ZERO)) return false;

  const eBytes = sha256(concat(bigIntToBytes(rx, 32), pubBytes, sighash));
  const e = bytesToBigInt(eBytes) % n;

  const Rprime = G.multiply(s).subtract(P.multiply(e));
  if (Rprime.equals(Point.ZERO)) return false;

  const { x: Rpx, y: Rpy } = Rprime.toAffine();
  if (Rpx !== rx) return false;

  const j = jacobi(Rpy);
  if (j === 0n || j !== 1n) return false;

  return true;
}