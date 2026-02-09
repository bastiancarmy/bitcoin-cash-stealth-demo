// packages/src/scanRawTxForRpaOutputs.ts

import type { RpaMatch, ScanRawTxForRpaOutputsParams } from "./types.js";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

import {
  bytesToHex,
  hexToBytes,
  reverseBytes,
  bytesToBigInt,
  decodeVarInt,
} from "@bch-stealth/utils";

import { deriveRpaOneTimePrivReceiver } from "@bch-stealth/rpa-derive";

/**
 * Minimal hash160 helper (sha256 -> ripemd160).
 */
function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

/**
 * Raw tx stores input outpoint txid as little-endian bytes.
 * Normalize to standard (display) txid hex.
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

/**
 * Txid = reverseBytes(sha256(sha256(rawTxBytes))).
 */
function txidFromRawTxHex(rawTxHex: string): string {
  const raw = hexToBytes(rawTxHex);
  const h1 = sha256(raw);
  const h2 = sha256(h1);
  return bytesToHex(reverseBytes(h2));
}

type ParsedTx = {
  txidHex: string;
  inputs: Array<{
    prevoutTxidHex: string;         // BE display txid hex
    prevoutTxidBytesLE: Uint8Array; // raw LE bytes as encoded in tx
    prevoutN: number;
    scriptSig: Uint8Array;
  }>;
  outputs: Array<{
    vout: number;
    valueSats: bigint;
    scriptPubKey: Uint8Array;
  }>;
};

function parseTx(rawTxHex: string): ParsedTx {
  const bytes = hexToBytes(rawTxHex);
  let pos = 0;

  // version
  pos += 4;

  // inputs
  const inCount = decodeVarInt(bytes, pos);
  pos += inCount.length;

  const inputs: ParsedTx["inputs"] = [];
  for (let i = 0; i < inCount.value; i++) {
    const prevHashLE = bytes.slice(pos, pos + 32);
    pos += 32;

    const prevoutTxidHex = txidHexFromRawInputTxidLE(prevHashLE);
    const prevoutTxidBytesLE = prevHashLE;

    const prevoutN = readU32LE(bytes, pos);
    pos += 4;

    const scrLen = decodeVarInt(bytes, pos);
    pos += scrLen.length;

    const scriptSig = bytes.slice(pos, pos + scrLen.value);
    pos += scrLen.value;

    // sequence
    pos += 4;

    inputs.push({ prevoutTxidHex, prevoutTxidBytesLE, prevoutN, scriptSig });
  }

  // outputs
  const outCount = decodeVarInt(bytes, pos);
  pos += outCount.length;

  const outputs: ParsedTx["outputs"] = [];
  for (let vout = 0; vout < outCount.value; vout++) {
    const valueLE = bytes.slice(pos, pos + 8);
    const valueSats = bytesToBigInt(reverseBytes(valueLE));
    pos += 8;

    const scrLen = decodeVarInt(bytes, pos);
    pos += scrLen.length;

    const scriptPubKey = bytes.slice(pos, pos + scrLen.value);
    pos += scrLen.value;

    outputs.push({ vout, valueSats, scriptPubKey });
  }

  return {
    txidHex: txidFromRawTxHex(rawTxHex),
    inputs,
    outputs,
  };
}

/**
 * Parse script pushes (enough for P2PKH scriptSig).
 */
function parseScriptPushes(script: Uint8Array): Uint8Array[] {
  const pushes: Uint8Array[] = [];
  let i = 0;

  while (i < script.length) {
    const op = script[i++];

    if (op >= 1 && op <= 75) {
      const n = op;
      pushes.push(script.slice(i, i + n));
      i += n;
      continue;
    }

    if (op === 0x4c) {
      if (i + 1 > script.length) break;
      const n = script[i++];
      pushes.push(script.slice(i, i + n));
      i += n;
      continue;
    }

    if (op === 0x4d) {
      if (i + 2 > script.length) break;
      const n = script[i] | (script[i + 1] << 8);
      i += 2;
      pushes.push(script.slice(i, i + n));
      i += n;
      continue;
    }

    if (op === 0x4e) {
      if (i + 4 > script.length) break;
      const n =
        script[i] |
        (script[i + 1] << 8) |
        (script[i + 2] << 16) |
        (script[i + 3] << 24);
      i += 4;
      pushes.push(script.slice(i, i + n));
      i += n;
      continue;
    }

    break;
  }

  return pushes;
}

function extractP2pkhPubkeyFromScriptSig(scriptSig: Uint8Array): Uint8Array | null {
  const pushes = parseScriptPushes(scriptSig);
  if (pushes.length < 2) return null;

  // Standard P2PKH: <sig> <pubkey33>
  const pub = pushes[1];
  if (!(pub instanceof Uint8Array) || pub.length !== 33) return null;
  if (pub[0] !== 0x02 && pub[0] !== 0x03) return null;

  return pub;
}

/**
 * Find a P2PKH pattern *anywhere* inside scriptPubKey.
 * Pattern: 76 a9 14 <20> 88 ac
 */
function findP2pkhHash160(scriptPubKey: Uint8Array): Uint8Array | null {
  for (let i = 0; i + 25 <= scriptPubKey.length; i++) {
    if (
      scriptPubKey[i] === 0x76 &&
      scriptPubKey[i + 1] === 0xa9 &&
      scriptPubKey[i + 2] === 0x14 &&
      scriptPubKey[i + 23] === 0x88 &&
      scriptPubKey[i + 24] === 0xac
    ) {
      return scriptPubKey.slice(i + 3, i + 23);
    }
  }
  return null;
}

function getDebugLevel(): 0 | 1 | 2 {
  const raw = String(process.env.BCH_STEALTH_DEBUG_SCAN ?? "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false") return 0;
  if (raw === "2") return 2;
  return 1;
}

// DROP-IN REPLACEMENT for: export function scanRawTxForRpaOutputs(...)
export function scanRawTxForRpaOutputs(params: ScanRawTxForRpaOutputsParams): RpaMatch[] {
  const {
    rawTxHex,
    scanPrivBytes,
    spendPrivBytes,
    maxRoleIndex = 8,
    maxMatches = 64,
  } = params as any;

  const dbg = getDebugLevel();
  const tx = parseTx(rawTxHex);

  // Only consider outputs that contain a P2PKH pattern (tolerates token prefix)
  const outs: Array<{
    vout: number;
    valueSats: bigint;
    scriptPubKey: Uint8Array;
    hash160Hex: string;
  }> = [];

  for (const o of tx.outputs) {
    const h160 = findP2pkhHash160(o.scriptPubKey);
    if (!h160) continue;

    outs.push({
      vout: o.vout,
      valueSats: o.valueSats,
      scriptPubKey: o.scriptPubKey,
      hash160Hex: bytesToHex(h160),
    });
  }

  if (outs.length === 0) return [];

  // Dedupe guarantee: only one match per outpoint (txid:vout)
  const matchedOutpoints = new Set<string>();

  const matches: RpaMatch[] = [];

  if (dbg >= 1) {
    // eslint-disable-next-line no-console
    console.log("🔎 scanRawTxForRpaOutputs v4: dedupe+stop-on-match", {
      txid: tx.txidHex,
      inputs: tx.inputs.length,
      outs: outs.length,
      maxRoleIndex,
    });
  }

  // Prefer vout-first index probing (because your builder uses index=0 payment, index=1 change)
  // but still allow 0..maxRoleIndex to be searched for non-vout-aligned builders.
  const buildIndexCandidates = (vout: number): number[] => {
    const set = new Set<number>();
    if (vout >= 0 && vout <= maxRoleIndex) set.add(vout);
    for (let i = 0; i <= maxRoleIndex; i++) set.add(i);
    return Array.from(set.values());
  };

  for (let inIdx = 0; inIdx < tx.inputs.length; inIdx++) {
    const inp = tx.inputs[inIdx];

    const senderPubFromSig = extractP2pkhPubkeyFromScriptSig(inp.scriptSig);

    const senderPubCandidates: Uint8Array[] = [];
    if (senderPubFromSig) senderPubCandidates.push(senderPubFromSig);

    const extra = String(process.env.BCH_STEALTH_SENDER_PUB33_HEXES ?? "").trim();
    if (extra) {
      for (const h of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
        try {
          const b = hexToBytes(h);
          if (b.length === 33 && (b[0] === 0x02 || b[0] === 0x03)) senderPubCandidates.push(b);
        } catch {
          // ignore
        }
      }
    }

    if (senderPubCandidates.length === 0) {
      if (dbg >= 2) {
        // eslint-disable-next-line no-console
        console.log("🔎 scan skip input (no sender pubkey)", {
          txid: tx.txidHex,
          inputIndex: inIdx,
          prevout: `${inp.prevoutTxidHex}:${inp.prevoutN}`,
          scriptSigLen: inp.scriptSig?.length ?? 0,
        });
      }
      continue;
    }

    // Try both txid interpretations (BE display vs LE raw) because earlier codepaths differed.
    const prevoutTxidHexBE = inp.prevoutTxidHex;
    const prevoutTxidHexLE = bytesToHex(inp.prevoutTxidBytesLE);
    const prevoutVariants = [prevoutTxidHexBE, prevoutTxidHexLE];

    for (const senderPub33 of senderPubCandidates) {
      const senderPub33Hex = bytesToHex(senderPub33);

      for (const out of outs) {
        const outpointKey = `${tx.txidHex}:${out.vout}`;
        if (matchedOutpoints.has(outpointKey)) continue; // ✅ dedupe + stop scanning this outpoint

        const indexCandidates = buildIndexCandidates(out.vout);

        let matched: {
          oneTimePriv: Uint8Array;
          sharedSecret: Uint8Array;
          usedPrevoutTxidHex: string;
          usedIndex: number;
          oneTimeHash160Hex: string;
        } | null = null;

        outer: for (const prevoutTxidHex of prevoutVariants) {
          for (const idx of indexCandidates) {
            let r: any;
            try {
              r = deriveRpaOneTimePrivReceiver(
                scanPrivBytes,
                spendPrivBytes,
                senderPub33,
                prevoutTxidHex,
                inp.prevoutN,
                idx
              );
            } catch {
              continue;
            }

            const oneTimePriv = r.oneTimePriv as Uint8Array;
            const sharedSecret = r.sharedSecret as Uint8Array;

            const oneTimePub33 = secp256k1.getPublicKey(oneTimePriv, true);
            const oneTimeHash160Hex = bytesToHex(hash160(oneTimePub33));

            if (dbg >= 2) {
              // eslint-disable-next-line no-console
              console.log("🔎 probe", {
                txid: tx.txidHex,
                inputIndex: inIdx,
                vout: out.vout,
                want: out.hash160Hex,
                got: oneTimeHash160Hex,
                prevoutTxidHex,
                prevoutN: inp.prevoutN,
                idx,
                senderPub33Hex,
              });
            }

            if (oneTimeHash160Hex !== out.hash160Hex) continue;

            matched = {
              oneTimePriv,
              sharedSecret,
              usedPrevoutTxidHex: prevoutTxidHex,
              usedIndex: idx,
              oneTimeHash160Hex,
            };
            break outer;
          }
        }

        if (!matched) continue;

        // ✅ Mark as matched so we never emit duplicates for this outpoint.
        matchedOutpoints.add(outpointKey);

        if (dbg >= 1) {
          // eslint-disable-next-line no-console
          console.log("🔎 match", {
            outpoint: outpointKey,
            valueSats: String(out.valueSats),
            senderPub33Hex,
            prevoutTxidHex: matched.usedPrevoutTxidHex,
            prevoutN: inp.prevoutN,
            index: matched.usedIndex,
          });
        }

        matches.push({
          txid: tx.txidHex,
          vout: out.vout,
          valueSats: out.valueSats,
          lockingBytecodeHex: bytesToHex(out.scriptPubKey),
          hash160Hex: matched.oneTimeHash160Hex,
          roleIndex: matched.usedIndex,

          matchedInput: {
            prevoutTxidHex: inp.prevoutTxidHex,
            prevoutN: inp.prevoutN,
            senderPub33Hex,
          },

          rpaContext: {
            senderPub33Hex,
            prevoutTxidHex: matched.usedPrevoutTxidHex,
            prevoutHashHex: matched.usedPrevoutTxidHex,
            prevoutN: inp.prevoutN,
            index: matched.usedIndex,
            sharedSecretHex: bytesToHex(matched.sharedSecret),
          },
        } as any);

        if (matches.length >= maxMatches) return matches;
      }
    }
  }

  return matches;
}