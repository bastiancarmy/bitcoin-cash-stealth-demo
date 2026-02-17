// packages/rpa-scan/src/scanRawTxForRpaOutputs.ts

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  bytesToHex,
  hexToBytes,
  reverseBytes,
  bytesToBigInt,
  decodeVarInt,
  hash160,
} from "@bch-stealth/utils";

import {
  deriveRpaOneTimePrivReceiver,
  deriveRpaSharedSecretReceiver,
} from "@bch-stealth/rpa-derive";

import type { RpaMatch, ScanRawTxForRpaOutputsParams } from "./types.js";

/**
 * Txid = reverseBytes(sha256(sha256(rawTxBytes))).
 */
function txidFromRawTxHex(rawTxHex: string): string {
  const raw = hexToBytes(rawTxHex);
  const h1 = sha256(raw);
  const h2 = sha256(h1);
  return bytesToHex(reverseBytes(h2));
}

/**
 * Raw tx stores input outpoint txid as little-endian bytes.
 * Normalize to standard (display) txid hex (big-endian display).
 */
function txidHexFromRawInputTxidLE(txidBytesLE: Uint8Array): string {
  if (!(txidBytesLE instanceof Uint8Array) || txidBytesLE.length !== 32) {
    throw new Error("scan: expected 32-byte input txid");
  }
  return bytesToHex(reverseBytes(txidBytesLE));
}

function readU32LE(bytes: Uint8Array, pos: number): number {
  return (
    bytes[pos] |
    (bytes[pos + 1] << 8) |
    (bytes[pos + 2] << 16) |
    (bytes[pos + 3] << 24)
  ) >>> 0;
}

type ParsedTxLike = {
  txid?: string; // optional convenience
  txidHex?: string; // legacy name, optional
  inputs: Array<{
    txid: string; // prevout txid (display hex, BE)
    vout: number; // prevout index
    scriptSig: Uint8Array;
  }>;
  outputs: Array<{
    value: string; // sats as string (matches current scanner expectations)
    scriptPubKey: Uint8Array;
  }>;
};

/**
 * Minimal raw tx parser sufficient for scanning:
 * - reads inputs (prevout txid, vout, scriptSig)
 * - reads outputs (value, scriptPubKey)
 * - tolerates typical tx format (no token/covenant special-casing needed here)
 */
function parseTx(rawTxHex: string): ParsedTxLike {
  const bytes = hexToBytes(rawTxHex);
  let pos = 0;

  // version (4)
  pos += 4;

  // inputs
  const inCount = decodeVarInt(bytes, pos);
  pos += inCount.length;

  const inputs: ParsedTxLike["inputs"] = [];
  for (let i = 0; i < inCount.value; i++) {
    const prevHashLE = bytes.slice(pos, pos + 32);
    pos += 32;

    const prevoutTxidHex = txidHexFromRawInputTxidLE(prevHashLE);

    const prevoutN = readU32LE(bytes, pos);
    pos += 4;

    const scrLen = decodeVarInt(bytes, pos);
    pos += scrLen.length;

    const scriptSig = bytes.slice(pos, pos + scrLen.value);
    pos += scrLen.value;

    // sequence (4)
    pos += 4;

    inputs.push({
      txid: prevoutTxidHex,
      vout: prevoutN,
      scriptSig,
    });
  }

  // outputs
  const outCount = decodeVarInt(bytes, pos);
  pos += outCount.length;

  const outputs: ParsedTxLike["outputs"] = [];
  for (let vout = 0; vout < outCount.value; vout++) {
    const valueLE = bytes.slice(pos, pos + 8);
    const valueSats = bytesToBigInt(reverseBytes(valueLE));
    pos += 8;

    const scrLen = decodeVarInt(bytes, pos);
    pos += scrLen.length;

    const scriptPubKey = bytes.slice(pos, pos + scrLen.value);
    pos += scrLen.value;

    outputs.push({
      value: valueSats.toString(),
      scriptPubKey,
    });
  }

  const txidHex = txidFromRawTxHex(rawTxHex);

  return {
    txid: txidHex,
    txidHex,
    inputs,
    outputs,
  };
}

/**
 * Extract the pubkey from a standard P2PKH scriptSig.
 * Typical form: <sigPush ...> <pubPush 33B>
 */
function extractP2pkhPubkeyFromScriptSig(scriptSig: Uint8Array | string): Uint8Array | null {
  const ss = scriptSig instanceof Uint8Array ? scriptSig : hexToBytes(scriptSig);
  if (ss.length < 35) return null;

  // For standard P2PKH: final push is pubkey (33 bytes)
  const pushLen = ss[ss.length - 34];
  if (pushLen !== 33) return null;

  const pub33 = ss.slice(ss.length - 33);
  if (pub33.length !== 33) return null;
  if (pub33[0] !== 0x02 && pub33[0] !== 0x03) return null;

  return pub33;
}

/** P2PKH scriptPubKey -> hash160 (20B) or null */
function parseP2pkhHash160(scriptPubKey: Uint8Array | string): Uint8Array | null {
  const spk = scriptPubKey instanceof Uint8Array ? scriptPubKey : hexToBytes(scriptPubKey);

  // OP_DUP OP_HASH160 PUSH20 <20B> OP_EQUALVERIFY OP_CHECKSIG
  if (
    spk.length === 25 &&
    spk[0] === 0x76 &&
    spk[1] === 0xa9 &&
    spk[2] === 0x14 &&
    spk[23] === 0x88 &&
    spk[24] === 0xac
  ) {
    return spk.slice(3, 23);
  }
  return null;
}

/**
 * Scan raw tx for RPA stealth P2PKH outputs spendable by (scanPrivBytes, spendPrivBytes).
 *
 * Additions:
 * - indexHints?: number[] (tried first)
 * - stopOnFirstMatch?: boolean (useful for --txid mode)
 * - off-by-one fix: scans indices [0..maxRoleIndex-1] by default
 *
 * Speedup:
 * - compute sharedSecret ONCE per vin and reuse across indices
 */
export function scanRawTxForRpaOutputs(params: ScanRawTxForRpaOutputsParams): RpaMatch[] {
  const {
    rawTxHex,
    scanPrivBytes,
    spendPrivBytes,
    maxRoleIndex = 2048,
    parsedTx = null,

    indexHints = null,
    stopOnFirstMatch = false,
    maxMatches = Infinity,
  } = params ?? ({} as any);

  if (typeof rawTxHex !== "string" || rawTxHex.length < 20) {
    throw new Error("scanRawTxForRpaOutputs: rawTxHex required");
  }
  if (!(scanPrivBytes instanceof Uint8Array) || scanPrivBytes.length !== 32) {
    throw new Error("scanRawTxForRpaOutputs: scanPrivBytes must be 32 bytes");
  }
  if (!(spendPrivBytes instanceof Uint8Array) || spendPrivBytes.length !== 32) {
    throw new Error("scanRawTxForRpaOutputs: spendPrivBytes must be 32 bytes");
  }

  // ✅ Use provided parsedTx if caller has it; otherwise use our minimal parser.
  const tx: any = parsedTx ?? parseTx(rawTxHex);

  // Prefer tx.txid if present; else compute from raw.
  const txid: string = (tx as any)?.txid ?? (tx as any)?.txidHex ?? txidFromRawTxHex(rawTxHex);

  // Map output hash160Hex -> outputs
  const outputsByH160 = new Map<
    string,
    Array<{ txid: string; vout: number; valueSats: string; hash160Hex: string; lockingBytecodeHex: string }>
  >();

  let totalP2pkhOutputs = 0;

  for (let vout = 0; vout < (tx.outputs?.length ?? 0); vout++) {
    const out = tx.outputs[vout];
    const h160 = parseP2pkhHash160(out.scriptPubKey);
    if (!h160) continue;

    totalP2pkhOutputs++;

    const hash160Hex = bytesToHex(h160);
    const lockingBytecodeHex =
      typeof out.scriptPubKey === "string" ? out.scriptPubKey : bytesToHex(out.scriptPubKey);

    const entry = {
      txid,
      vout,
      valueSats: String(out.value),
      hash160Hex,
      lockingBytecodeHex,
    };

    const arr = outputsByH160.get(hash160Hex) ?? [];
    arr.push(entry);
    outputsByH160.set(hash160Hex, arr);
  }

  if (outputsByH160.size === 0) return [];

  const matches: RpaMatch[] = [];
  const seen = new Set<string>(); // txid:vout

  const maxN = Math.max(0, Math.floor(Number(maxRoleIndex) || 0));
  const maxM = Number.isFinite(Number(maxMatches))
    ? Math.max(0, Math.floor(Number(maxMatches)))
    : Infinity;

  // prepare hints: dedupe + clamp
  let hintList: number[] = [];
  if (Array.isArray(indexHints) && indexHints.length > 0) {
    const s = new Set<number>();
    for (const x of indexHints) {
      const n = Math.floor(Number(x));
      if (!Number.isFinite(n)) continue;
      if (n < 0 || n >= maxN) continue;
      s.add(n);
    }
    hintList = Array.from(s);
  }

  const maybeStop = (): boolean => {
    if (stopOnFirstMatch && matches.length > 0) return true;
    if (Number.isFinite(maxM) && matches.length >= maxM) return true;
    if (seen.size >= totalP2pkhOutputs && totalP2pkhOutputs > 0) return true;
    return false;
  };

  for (let vin = 0; vin < (tx.inputs?.length ?? 0); vin++) {
    const inp = tx.inputs[vin];

    // only scan standard P2PKH inputs (needs pubkey)
    const senderPub33 = extractP2pkhPubkeyFromScriptSig(inp.scriptSig);
    if (!senderPub33) continue;

    const senderPub33Hex = bytesToHex(senderPub33);

    // ✅ locked-in policy: use display txid hex "as-is"
    // With our local parseTx, inp.txid is the BE display txid.
    const prevoutHashHex = inp.txid;
    const prevoutTxidHex = inp.txid; // compatibility
    const prevoutN = inp.vout;

    if (typeof prevoutHashHex !== "string" || prevoutHashHex.length !== 64) continue;
    if (!Number.isFinite(prevoutN)) continue;

    // ✅ compute shared secret ONCE per vin
    let sharedSecret32: Uint8Array;
    try {
      sharedSecret32 = deriveRpaSharedSecretReceiver(
        scanPrivBytes,
        senderPub33,
        prevoutHashHex,
        prevoutN
      );
    } catch {
      continue;
    }
    const sharedSecretHex = bytesToHex(sharedSecret32);

    const tried = new Set<number>();

    const tryIndex = (index: number): boolean => {
      if (index < 0 || index >= maxN) return false;
      if (tried.has(index)) return false;
      tried.add(index);

      let oneTimePriv: Uint8Array;
      try {
        // IMPORTANT: rpa-derive must expose the new optional param in its published types.
        // After rebuilding rpa-derive, this call compiles and runs.
        ({ oneTimePriv } = deriveRpaOneTimePrivReceiver(
          scanPrivBytes,
          spendPrivBytes,
          senderPub33,
          prevoutHashHex,
          prevoutN,
          index,
          sharedSecret32 // ✅ reuse
        ) as any);
      } catch {
        return false;
      }

      const pub33 = secp256k1.getPublicKey(oneTimePriv, true);
      const h160Hex = bytesToHex(hash160(pub33));

      const outs = outputsByH160.get(h160Hex);
      if (!outs) return false;

      for (const o of outs) {
        const key = `${o.txid}:${o.vout}`;
        if (seen.has(key)) continue;
        seen.add(key);

        matches.push({
          txid: o.txid,
          vout: o.vout,

          // keep both
          valueSats: o.valueSats,
          value: o.valueSats,

          lockingBytecodeHex: o.lockingBytecodeHex,
          hash160Hex: o.hash160Hex,

          roleIndex: index,

          rpaContext: {
            senderPub33Hex,
            prevoutTxidHex,
            prevoutHashHex,
            prevoutN,
            index,
            sharedSecretHex,
          },
          matchedInput: {
            vin,
            prevoutTxidHex,
            prevoutHashHex,
            prevoutN,
            senderPub33Hex,
          },
        } as any);

        if (maybeStop()) return true;
      }

      return false;
    };

    // 1) hints first
    for (let i = 0; i < hintList.length; i++) {
      if (tryIndex(hintList[i]!)) return matches;
    }

    // 2) full scan: OFF-BY-ONE FIX: [0 .. maxN-1]
    for (let index = 0; index < maxN; index++) {
      if (tryIndex(index)) return matches;
    }
  }

  return matches;
}