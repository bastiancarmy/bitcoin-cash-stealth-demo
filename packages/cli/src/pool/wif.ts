// packages/cli/src/pool/wif.ts

import { sha256, ensureEvenYPriv, bytesToHex, hexToBytes } from '@bch-stealth/utils';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP: Record<string, number> = Object.create(null);
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = i;

function sha256d(x: Uint8Array): Uint8Array {
  return sha256(sha256(x));
}

function base58Decode(s: string): Uint8Array {
  const str = s.trim();
  if (!str) throw new Error('base58Decode: empty string');

  // Count leading zeros
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;

  // Convert base58 digits to bigint-ish byte array
  const bytes: number[] = [0];
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const val = ALPHABET_MAP[ch];
    if (val === undefined) throw new Error(`base58Decode: invalid base58 char '${ch}'`);

    let carry = val;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Add leading zero bytes
  for (let i = 0; i < zeros; i++) bytes.push(0);

  bytes.reverse();
  return Uint8Array.from(bytes);
}

function base58CheckDecode(s: string): Uint8Array {
  const raw = base58Decode(s);
  if (raw.length < 5) throw new Error('base58CheckDecode: too short');

  const payload = raw.slice(0, raw.length - 4);
  const checksum = raw.slice(raw.length - 4);

  const check = sha256d(payload).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== check[i]) throw new Error('base58CheckDecode: bad checksum');
  }

  return payload;
}

export type DecodedWif = {
  version: number; // 0x80 mainnet, 0xef testnet/chipnet (commonly)
  privBytes: Uint8Array; // 32 bytes
  compressed: boolean;
};

/**
 * Decode WIF to 32-byte private key bytes.
 * Accepts both mainnet (0x80) and testnet-like (0xef) versions.
 * Applies ensureEvenYPriv to align with repo wallet expectations.
 */
export function decodeWifToPrivBytes(wif: string): DecodedWif {
  const payload = base58CheckDecode(wif);

  const version = payload[0];
  const body = payload.slice(1);

  if (body.length !== 32 && body.length !== 33) {
    throw new Error(`WIF payload length unexpected: ${body.length} (expected 32 or 33)`);
  }

  const compressed = body.length === 33;
  if (compressed && body[32] !== 0x01) throw new Error('WIF compressed flag byte missing/invalid');

  const privRaw = body.slice(0, 32);

  // align with your repo's key handling (createWallet uses ensureEvenYPriv)
  const privBytes = ensureEvenYPriv(privRaw);

  return { version, privBytes, compressed };
}

/**
 * Parse a private key from either:
 * - WIF (preferred)
 * - raw hex (32 bytes)
 */
export function parsePrivKeyInput(args: { wif?: string | null; privHex?: string | null }): Uint8Array | null {
  const wif = args.wif?.trim() ?? '';
  const privHex = args.privHex?.trim() ?? '';

  if (wif) return decodeWifToPrivBytes(wif).privBytes;

  if (privHex) {
    const b = hexToBytes(privHex);
    if (b.length !== 32) throw new Error(`--deposit-privhex must be 32 bytes (got ${b.length})`);
    return ensureEvenYPriv(b);
  }

  return null;
}

export function wifVersionHint(version: number): string {
  if (version === 0x80) return '0x80 (mainnet-style)';
  if (version === 0xef) return '0xef (testnet/chipnet-style)';
  return `0x${version.toString(16).padStart(2, '0')}`;
}