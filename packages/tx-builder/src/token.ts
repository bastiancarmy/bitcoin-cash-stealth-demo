import { hexToBytes } from '@bch-stealth/utils';

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