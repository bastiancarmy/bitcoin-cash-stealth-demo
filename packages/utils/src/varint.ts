// packages/utils/src/varint.ts

export type DecodedVarInt = { value: number; size: number; length: number };

export function varInt(val: number): Uint8Array {
  if (!Number.isInteger(val) || val < 0) throw new Error('varInt: val must be a non-negative integer');

  if (val < 0xfd) return new Uint8Array([val]);

  if (val <= 0xffff) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    new DataView(b.buffer).setUint16(1, val, true);
    return b;
  }

  if (val <= 0xffffffff) {
    const b = new Uint8Array(5);
    b[0] = 0xfe;
    new DataView(b.buffer).setUint32(1, val, true);
    return b;
  }

  const b = new Uint8Array(9);
  b[0] = 0xff;
  new DataView(b.buffer).setBigUint64(1, BigInt(val), true);
  return b;
}

export function decodeVarInt(u8: Uint8Array, offset = 0): DecodedVarInt {
  if (!(u8 instanceof Uint8Array)) throw new TypeError('u8 must be Uint8Array');
  if (!Number.isInteger(offset) || offset < 0 || offset >= u8.length) {
    throw new Error('Invalid or too large VarInt');
  }

  const fb = u8[offset];

  if (fb < 0xfd) return { value: fb, size: 1, length: 1 };

  if (fb === 0xfd) {
    if (offset + 3 > u8.length) throw new Error('Invalid or too large VarInt');
    const v = u8[offset + 1] | (u8[offset + 2] << 8);
    return { value: v, size: 3, length: 3 };
  }

  if (fb === 0xfe) {
    if (offset + 5 > u8.length) throw new Error('Invalid or too large VarInt');
    const v =
      u8[offset + 1] |
      (u8[offset + 2] << 8) |
      (u8[offset + 3] << 16) |
      (u8[offset + 4] << 24);
    return { value: v >>> 0, size: 5, length: 5 };
  }

  // 0xff (8-byte) not needed for your tx parsing; reject
  throw new Error('Invalid or too large VarInt');
}