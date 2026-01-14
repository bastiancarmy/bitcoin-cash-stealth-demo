import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToBigInt, bigIntToBytes } from '@bch-stealth/utils';

const n = secp256k1.Point.CURVE().n;
const Point = secp256k1.Point;

/** Get 32-byte x-only pubkey (drop parity byte if compressed) */
export function getXOnlyPub(pubBytes: Uint8Array): Uint8Array {
  if (pubBytes.length === 32) return pubBytes;
  if (pubBytes.length !== 33 || (pubBytes[0] !== 0x02 && pubBytes[0] !== 0x03)) {
    throw new Error('Invalid pubkey for x-only');
  }
  return pubBytes.slice(1);
}

/** Negate privkey if pubkey has odd y-parity (for even y in Schnorr) */
export function ensureEvenYPriv(privBytes: Uint8Array): Uint8Array {
  let pubBytes = secp256k1.getPublicKey(privBytes, true);
  let pubPoint = Point.fromBytes(pubBytes);

  const affine = pubPoint.toAffine();
  if ((affine.y & 1n) === 1n) {
    let privBig = bytesToBigInt(privBytes);
    privBig = n - privBig;
    privBytes = bigIntToBytes(privBig, 32);

    // Recompute to confirm
    pubBytes = secp256k1.getPublicKey(privBytes, true);
    pubPoint = Point.fromBytes(pubBytes);
    const affineConfirm = pubPoint.toAffine();
    if ((affineConfirm.y & 1n) === 1n) throw new Error('Parity enforcement failed');
  }
  return privBytes;
}