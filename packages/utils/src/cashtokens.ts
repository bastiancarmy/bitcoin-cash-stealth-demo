// packages/utils/src/cashtokens.ts
//
// CashTokens prefix decoding/splitting that works for ANY locking script,
// including token-prefix + bare covenant redeemScript bytecode.

export type CashTokensDecoded = {
  category: Uint8Array;           // 32 bytes
  bitfield: number;
  hasNft: boolean;
  hasAmount: boolean;
  hasCommitment: boolean;
  capability: number;             // 0..2
  commitment: Uint8Array | null;  // 1..40 bytes when present
  amount: bigint | null;          // when present
  prefixLen: number;              // total bytes of token prefix in script
};

function readVarInt(u8: Uint8Array, offset: number): { value: bigint; size: number } {
  if (offset >= u8.length) throw new Error("readVarInt: out of bounds");
  const first = u8[offset];

  if (first < 0xfd) return { value: BigInt(first), size: 1 };

  if (first === 0xfd) {
    if (offset + 3 > u8.length) throw new Error("readVarInt: truncated 0xfd");
    const v = u8[offset + 1] | (u8[offset + 2] << 8);
    return { value: BigInt(v), size: 3 };
  }

  if (first === 0xfe) {
    if (offset + 5 > u8.length) throw new Error("readVarInt: truncated 0xfe");
    const v =
      (u8[offset + 1]) |
      (u8[offset + 2] << 8) |
      (u8[offset + 3] << 16) |
      (u8[offset + 4] << 24);
    return { value: BigInt(v >>> 0), size: 5 };
  }

  // 0xff -> uint64le
  if (offset + 9 > u8.length) throw new Error("readVarInt: truncated 0xff");
  let acc = 0n;
  for (let i = 0; i < 8; i++) {
    acc |= BigInt(u8[offset + 1 + i]) << (8n * BigInt(i));
  }
  return { value: acc, size: 9 };
}

export function decodeCashTokensPrefix(raw: Uint8Array): CashTokensDecoded {
  if (!(raw instanceof Uint8Array)) throw new Error("decodeCashTokensPrefix: expected Uint8Array");
  if (raw.length < 1 + 32 + 1) throw new Error("decodeCashTokensPrefix: too short");
  if (raw[0] !== 0xef) throw new Error("decodeCashTokensPrefix: missing 0xef marker");

  let off = 1;

  const category = raw.slice(off, off + 32);
  off += 32;

  const bitfield = raw[off];
  off += 1;

  const hasCommitment = (bitfield & 0x40) !== 0;
  const hasNft = (bitfield & 0x20) !== 0;
  const hasAmount = (bitfield & 0x10) !== 0;
  const capability = bitfield & 0x0f;

  if (!hasNft && capability !== 0) throw new Error("decodeCashTokensPrefix: capability set without NFT");
  if (hasNft && capability > 2) throw new Error("decodeCashTokensPrefix: invalid capability");

  let commitment: Uint8Array | null = null;
  if (hasCommitment) {
    if (!hasNft) throw new Error("decodeCashTokensPrefix: commitment without NFT");
    const { value: lenBig, size } = readVarInt(raw, off);
    off += size;

    const len = Number(lenBig);
    if (!Number.isFinite(len) || len < 1 || len > 40) {
      throw new Error(`decodeCashTokensPrefix: invalid commitment length ${String(lenBig)}`);
    }
    if (off + len > raw.length) throw new Error("decodeCashTokensPrefix: truncated commitment");
    commitment = raw.slice(off, off + len);
    off += len;
  }

  let amount: bigint | null = null;
  if (hasAmount) {
    const { value: amt, size } = readVarInt(raw, off);
    off += size;
    if (amt < 1n) throw new Error("decodeCashTokensPrefix: amount must be >= 1");
    amount = amt;
  }

  return {
    category,
    bitfield,
    hasNft,
    hasAmount,
    hasCommitment,
    capability,
    commitment,
    amount,
    prefixLen: off,
  };
}

export function splitCashTokensPrefix(scriptPubKey: Uint8Array): { prefix: Uint8Array | null; locking: Uint8Array } {
  if (!(scriptPubKey instanceof Uint8Array)) scriptPubKey = new Uint8Array(scriptPubKey);
  if (scriptPubKey.length === 0 || scriptPubKey[0] !== 0xef) {
    return { prefix: null, locking: scriptPubKey };
  }

  // Decode directly from the full script; decoder stops at prefixLen.
  const decoded = decodeCashTokensPrefix(scriptPubKey);
  const prefix = scriptPubKey.slice(0, decoded.prefixLen);
  const locking = scriptPubKey.slice(decoded.prefixLen);
  return { prefix, locking };
}