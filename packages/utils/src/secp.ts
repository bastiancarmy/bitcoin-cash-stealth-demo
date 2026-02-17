// packages/utils/src/secp.ts
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE, numberToBytesBE } from '@noble/curves/utils.js';

const Point = secp256k1.Point;
const n = Point.CURVE().n;

function asU8(x: Uint8Array | ArrayBufferView): Uint8Array {
  // Normalize whatever noble gives us into a plain Uint8Array
  return x instanceof Uint8Array ? x : new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
}

/**
 * Get 32-byte x-only pubkey (drop parity byte if compressed).
 */
export function getXOnlyPub(pubBytes: Uint8Array): Uint8Array {
  if (pubBytes.length === 32) return pubBytes;

  if (
    pubBytes.length !== 33 ||
    (pubBytes[0] !== 0x02 && pubBytes[0] !== 0x03)
  ) {
    throw new Error('getXOnlyPub: invalid pubkey');
  }

  return pubBytes.slice(1);
}

/**
 * Negate privkey if pubkey has odd y-parity (for even y in Schnorr).
 *
 * This is useful for key normalization when using an "even-y" convention.
 */
export function ensureEvenYPriv(privBytes: Uint8Array): Uint8Array {
  if (!(privBytes instanceof Uint8Array) || privBytes.length !== 32) {
    throw new Error('ensureEvenYPriv: privBytes must be 32-byte Uint8Array');
  }

  // Derive compressed pubkey from priv
  let pubBytes = asU8(secp256k1.getPublicKey(privBytes, true));
  let pubPoint = Point.fromBytes(pubBytes);
  let { y } = pubPoint.toAffine();

  // If y is odd, negate priv: d' = n - d
  if ((y & 1n) === 1n) {
    let d = bytesToNumberBE(privBytes) % n;
    if (d === 0n) throw new Error('ensureEvenYPriv: invalid privkey (0)');

    d = (n - d) % n;
    const next = numberToBytesBE(d, 32) as unknown as Uint8Array;

    // Confirm parity flipped
    pubBytes = asU8(secp256k1.getPublicKey(next, true));
    pubPoint = Point.fromBytes(pubBytes);
    ({ y } = pubPoint.toAffine());

    if ((y & 1n) === 1n) {
      throw new Error('ensureEvenYPriv: parity enforcement failed');
    }

    return next;
  }

  return privBytes;
}