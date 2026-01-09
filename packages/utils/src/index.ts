export function hexToBytes(hex: string | Uint8Array | number[]): Uint8Array {
  if (hex instanceof Uint8Array) return hex;
  if (Array.isArray(hex)) return Uint8Array.from(hex);
  if (typeof hex !== "string") throw new TypeError(`hexToBytes expected string/Uint8Array/number[], got ${typeof hex}`);

  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("hexToBytes: hex length must be even");
  if (h.length === 0) return new Uint8Array();

  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) {
    if (!(a instanceof Uint8Array)) throw new TypeError("concat: all chunks must be Uint8Array");
    total += a.length;
  }
  const res = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    res.set(a, off);
    off += a.length;
  }
  return res;
}
