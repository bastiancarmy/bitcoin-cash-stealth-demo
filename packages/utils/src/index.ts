// packages/utils/src/index.ts
export * from './bytes.js';
export * from './hash.js';
export * from './varint.js';
export * from './base58.js';
export * from './script.js';

// Keep the subpath export ("./cashaddr") as-is, but also re-export the common helpers
// from the root so consumers don't need path hacks.
export { encodeCashAddr, decodeCashAddress } from './cashaddr.js';

// Key normalization helpers used by demo-cli
export { ensureEvenYPriv, getXOnlyPub } from './secp.js';