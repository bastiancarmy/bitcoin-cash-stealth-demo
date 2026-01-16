// packages/utils/src/hash.ts
import { sha256 as _sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 as _ripemd160 } from '@noble/hashes/legacy.js';

export { sha256 } from '@noble/hashes/sha2.js';
export { ripemd160 } from '@noble/hashes/legacy.js';

/** hash160(x) = RIPEMD160(SHA256(x)) */
export function hash160(x: Uint8Array): Uint8Array {
  return _ripemd160(_sha256(x));
}

// Back-compat alias for older callsites (cli currently imports `_hash160`)
export const _hash160 = hash160;