// packages/utils/src/script.ts
import { concat } from './bytes.js';

export function pushDataPrefix(len: number): Uint8Array {
  if (!Number.isInteger(len) || len < 0) throw new Error('pushDataPrefix: len must be a non-negative integer');

  if (len < 0x4c) {
    return new Uint8Array([len]);
  } else if (len <= 0xff) {
    return concat(new Uint8Array([0x4c]), new Uint8Array([len]));
  } else if (len <= 0xffff) {
    const le = new Uint8Array(2);
    le[0] = len & 0xff;
    le[1] = (len >> 8) & 0xff;
    return concat(new Uint8Array([0x4d]), le);
  } else if (len <= 0xffffffff) {
    const le = new Uint8Array(4);
    le[0] = len & 0xff;
    le[1] = (len >> 8) & 0xff;
    le[2] = (len >> 16) & 0xff;
    le[3] = (len >> 24) & 0xff;
    return concat(new Uint8Array([0x4e]), le);
  } else {
    throw new Error('Push data too large');
  }
}