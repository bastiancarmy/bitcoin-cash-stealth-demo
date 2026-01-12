// src/base58.js
// Base58 encoding/decoding helpers
// Depends on: utils.js (bytesToBigInt, bigIntToBytes, concat, sha256, arraysEqual)

import { bytesToBigInt, bigIntToBytes, concat, sha256, arraysEqual } from './utils.js';

export const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58encode(data) {
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

export function base58checkEncode(version, payload) {
  const data = concat(new Uint8Array([version]), payload);
  const checksum = sha256(sha256(data)).slice(0, 4);
  return base58encode(concat(data, checksum));
}

export function base58checkDecode(str) {
  let num = 0n;
  for (let char of str) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) throw new Error('Invalid base58');
    num = num * 58n + BigInt(idx);
  }
  const byteLen = Math.ceil(str.length * Math.log(58) / Math.log(256));
  let bytes = bigIntToBytes(num, byteLen);
  let zeroCount = str.match(/^1*/)[0].length;
  bytes = concat(new Uint8Array(zeroCount), bytes);
  const data = bytes.slice(0, -4);
  const checksum = bytes.slice(-4);
  const computed = sha256(sha256(data)).slice(0, 4);
  if (!arraysEqual(checksum, computed)) throw new Error('Checksum mismatch');
  return { version: data[0], payload: data.slice(1) };
}