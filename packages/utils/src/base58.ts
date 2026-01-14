// packages/utils/src/base58.ts
// Base58 encoding/decoding helpers
// Depends on: bytes.ts (bytesToBigInt, bigIntToBytes, concat, arraysEqual) and hash.ts (sha256)

import { sha256 } from '@noble/hashes/sha2.js';
import { arraysEqual, bigIntToBytes, bytesToBigInt, concat } from './bytes.js';

export const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58encode(data: Uint8Array): string {
  let num = bytesToBigInt(data);
  let result = '';
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    result = alphabet[rem] + result;
  }
  let zeroCount = 0;
  while (zeroCount < data.length && data[zeroCount] === 0) zeroCount++;
  return '1'.repeat(zeroCount) + result;
}

export function base58checkEncode(version: number, payload: Uint8Array): string {
  const data = concat(new Uint8Array([version]), payload);
  const checksum = sha256(sha256(data)).slice(0, 4);
  return base58encode(concat(data, checksum));
}

export function base58checkDecode(str: string): { version: number; payload: Uint8Array } {
  let num = 0n;
  for (const char of str) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error('Invalid base58');
    num = num * 58n + BigInt(idx);
  }

  // Approximate byte length
  const byteLen = Math.ceil((str.length * Math.log(58)) / Math.log(256));
  let bytes = bigIntToBytes(num, byteLen);

  const zeroCount = (str.match(/^1*/)?.[0].length ?? 0);
  bytes = concat(new Uint8Array(zeroCount), bytes);

  const data = bytes.slice(0, -4);
  const checksum = bytes.slice(-4);
  const computed = sha256(sha256(data)).slice(0, 4);
  if (!arraysEqual(checksum, computed)) throw new Error('Checksum mismatch');

  return { version: data[0], payload: data.slice(1) };
}