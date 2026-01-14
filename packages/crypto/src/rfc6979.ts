// packages/crypto/src/rfc6979.ts
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { bigIntToBytes, bytesToBigInt, concat } from '@bch-stealth/utils';

const n = secp256k1.Point.CURVE().n;

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  // noble types sometimes surface Uint8Array<ArrayBufferLike>
  return hmac(sha256, key, msg) as unknown as Uint8Array;
}

// RFC6979 with 16-byte “Schnorr+SHA256␣␣” additional data
export function rfc6979(d: bigint, h1: Uint8Array): bigint {
  const additional = utf8ToBytes('Schnorr+SHA256  ');
  const msg = concat(h1, additional);

  const hlen = 32;

  // IMPORTANT: keep these as plain Uint8Array to avoid ArrayBufferLike generic mismatch
  let V: Uint8Array = new Uint8Array(hlen).fill(0x01);
  let K: Uint8Array = new Uint8Array(hlen).fill(0x00);

  const x = bigIntToBytes(d, 32);
  const h1mod = bigIntToBytes(bytesToBigInt(msg) % n, 32);

  K = hmacSha256(K, concat(V, new Uint8Array([0x00]), x, h1mod));
  V = hmacSha256(K, V);
  K = hmacSha256(K, concat(V, new Uint8Array([0x01]), x, h1mod));
  V = hmacSha256(K, V);

  while (true) {
    let T: Uint8Array = new Uint8Array(0);
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