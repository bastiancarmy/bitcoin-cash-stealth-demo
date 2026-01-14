// src/cashaddr.ts
// CashAddr encoding/decoding helpers (standalone, no external deps)
//
// Spec notes (CashAddr, not generic Bech32):
// - HRP expansion = lower 5 bits of each char + 0
// - polymod(...) returns c ^ 1
// - Valid address iff polymod(hrpExpand(prefix) || payload+checksum) === 0

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR: readonly bigint[] = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

// -----------------------------------------------------------------------------
// HRP expand & polymod
// -----------------------------------------------------------------------------

export function cashHrpExpand(hrp: string): number[] {
  const expanded: number[] = [];
  for (const ch of hrp) {
    // lower 5 bits of ASCII code; for letters this is 1..26
    expanded.push(ch.charCodeAt(0) & 31);
  }
  expanded.push(0);
  return expanded;
}

function polymod(values: readonly number[]): bigint {
  let chk = 1n;
  for (const v of values) {
    const d = BigInt(v);
    const top = chk >> 35n;
    chk = ((chk & 0x07ffffffffn) << 5n) ^ d;
    for (let i = 0; i < 5; i++) {
      if (((top >> BigInt(i)) & 1n) === 1n) {
        chk ^= GENERATOR[i];
      }
    }
  }
  // CashAddr spec: return c ^ 1
  return chk ^ 1n;
}

export function cashCreateChecksum(hrp: string, data: Uint8Array | number[]): number[] {
  const values: number[] = [...cashHrpExpand(hrp), ...Array.from(data)];
  // Append 8 zero "template" words, then run polymod
  const mod = polymod([...values, 0, 0, 0, 0, 0, 0, 0, 0]);
  const checksum: number[] = [];
  for (let i = 0; i < 8; i++) {
    checksum.push(Number((mod >> (5n * BigInt(7 - i))) & 31n));
  }
  return checksum;
}

export function cashVerifyChecksum(hrp: string, data: Uint8Array | number[]): boolean {
  // Full data (payload + checksum) must produce polymod(...) === 0
  return polymod([...cashHrpExpand(hrp), ...Array.from(data)]) === 0n;
}

// -----------------------------------------------------------------------------
// 5-bit / 8-bit conversion
// -----------------------------------------------------------------------------

export function convertbits(
  data: Uint8Array | number[],
  frombits: number,
  tobits: number,
  pad = true
): Uint8Array {
  let acc = 0n;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1n << BigInt(tobits)) - 1n;
  const maxAcc = (1n << BigInt(frombits + tobits - 1)) - 1n;

  for (let value of Array.from(data)) {
    const v = BigInt(value);
    if (v < 0n || (v >> BigInt(frombits)) !== 0n) {
      throw new Error('Invalid value in convertbits');
    }
    acc = ((acc << BigInt(frombits)) | v) & maxAcc;
    bits += frombits;
    while (bits >= tobits) {
      bits -= tobits;
      ret.push(Number((acc >> BigInt(bits)) & maxv));
    }
  }

  if (pad) {
    if (bits > 0) {
      ret.push(Number((acc << BigInt(tobits - bits)) & maxv));
    }
  } else if (bits >= frombits || ((acc << BigInt(tobits - bits)) & maxv) !== 0n) {
    throw new Error('Invalid padding in convertbits');
  }

  return Uint8Array.from(ret);
}

// -----------------------------------------------------------------------------
// Encoding / decoding
// -----------------------------------------------------------------------------

/**
 * Map "P2PKH"/"P2SH" or numeric to type bits.
 */
function normalizeTypeBits(type: string | number): number {
  if (typeof type === 'string') {
    const t = type.toUpperCase();
    if (t === 'P2PKH') return 0; // spec: type 0
    if (t === 'P2SH') return 1;  // spec: type 1
    throw new Error(`Unknown CashAddr type string: ${type}`);
  }
  const n = Number(type);
  if (!Number.isInteger(n) || n < 0 || n > 15) {
    throw new Error(`Invalid CashAddr type bits: ${type}`);
  }
  return n;
}

/**
 * Map payload length in bytes to size bits (last 3 bits of version).
 */
function sizeBitsForHashLen(len: number): number {
  switch (len) {
    case 20: return 0;
    case 24: return 1;
    case 28: return 2;
    case 32: return 3;
    case 40: return 4;
    case 48: return 5;
    case 56: return 6;
    case 64: return 7;
    default:
      throw new Error(`Unsupported hash length for CashAddr: ${len}`);
  }
}

/**
 * Encode a CashAddr string.
 *
 * @param prefix  e.g. "bitcoincash", "bchtest"
 * @param type    "P2PKH" | "P2SH" or numeric type bits
 * @param payload hash160 / script hash bytes
 */
export function encodeCashAddr(prefix: string, type: string | number, payload: Uint8Array): string {
  const typeBits = normalizeTypeBits(type);
  const sizeBits = sizeBitsForHashLen(payload.length);
  const version = (typeBits << 3) | sizeBits; // 5-bit version field

  const dataBytes = new Uint8Array(1 + payload.length);
  dataBytes[0] = version;
  dataBytes.set(payload, 1);

  const converted = convertbits(dataBytes, 8, 5, true);
  const checksum = cashCreateChecksum(prefix, converted);

  let encoded = prefix + ':';
  for (const b of converted) encoded += CHARSET[b];
  for (const b of checksum) encoded += CHARSET[b];

  return encoded;
}

/**
 * Decode a CashAddr string into { prefix, type, hash }.
 * Requires the explicit prefix (we don't guess "bitcoincash"/"bchtest").
 */
export function decodeCashAddress(addr: string): { prefix: string; type: 'P2PKH' | 'P2SH'; hash: Uint8Array } {
  if (addr.toLowerCase() !== addr && addr.toUpperCase() !== addr) {
    throw new Error('Mixed case CashAddr');
  }
  addr = addr.toLowerCase();
  const parts = addr.split(':');
  if (parts.length !== 2) throw new Error('Invalid CashAddr: missing prefix separator ":"');

  const prefix = parts[0];
  const payloadStr = parts[1];

  const payload: number[] = [];
  for (const ch of payloadStr) {
    const v = CHARSET.indexOf(ch);
    if (v === -1) throw new Error('Invalid character in CashAddr payload');
    payload.push(v);
  }

  // Verify checksum over full payload (data + checksum)
  if (!cashVerifyChecksum(prefix, payload)) {
    throw new Error('Invalid CashAddr checksum');
  }

  // Strip checksum (last 8 symbols), convert 5-bit groups back to bytes
  const data = payload.slice(0, -8);

  let acc = 0n;
  let bitCount = 0;
  const bytes: number[] = [];
  for (const v of data) {
    acc = (acc << 5n) | BigInt(v);
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push(Number((acc >> BigInt(bitCount)) & 0xffn));
    }
  }
  if (bitCount > 0 && Number(acc & ((1n << BigInt(bitCount)) - 1n)) !== 0) {
    throw new Error('Invalid padding in CashAddr payload');
  }

  const payloadBytes = Uint8Array.from(bytes);
  if (payloadBytes.length < 1) throw new Error('Missing version byte in CashAddr payload');

  const version = payloadBytes[0];
  const hash = payloadBytes.slice(1);

  const typeBits = (version & 0x78) >> 3;   // upper bits (0=P2PKH, 1=P2SH)
  const sizeBits = version & 0x07;          // lower 3 bits

  const sizeTable = [20, 24, 28, 32, 40, 48, 56, 64] as const;
  const expectedLen = sizeTable[sizeBits];
  if (hash.length !== expectedLen) {
    throw new Error('Invalid hash size in CashAddr payload');
  }

  const type = typeBits === 0 ? 'P2PKH' : 'P2SH';
  return { prefix, type, hash };
}