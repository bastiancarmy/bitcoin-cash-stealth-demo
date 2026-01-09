// src/rpa_scan.js
//
// RPA stealth output scanner for *raw transactions you already have* (Phase 2)
// and for future Phase 3 usage (same “birthday + bounded scan window” concept,
// just with more data sources).
//
// What it does:
// - Parses raw tx hex
// - For each P2PKH input, extracts the spending pubkey (senderPub33) + prevout (txid:vout)
// - For each roleIndex in [0..maxRoleIndex], derives receiver one-time privkey
// - Hash160(one-time pubkey) is compared to each P2PKH output hash160
// - Returns matched outpoints + the rpaContext required to spend later
//
// Important: This matches your “LOCKED-IN” policy:
// - prevoutHashHex is used "as-is" (no endian reversal)
// - no evenY normalization

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { parseTx } from "./electrum.js";
import { deriveRpaOneTimePrivReceiver } from "./derivation.js";

import {
  _hash160,
  bytesToHex,
  hexToBytes,
  reverseBytes,
  sha256,
} from "./utils.js";

/** P2PKH scriptPubKey -> hash160 (20B) or null */
function parseP2pkhHash160(scriptPubKey) {
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
 * Extract the pubkey from a standard P2PKH scriptSig.
 * Typical form: <sigPush ...> <pubPush 33B>
 */
function extractP2pkhPubkeyFromScriptSig(scriptSig) {
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

/** Compute txid (hex, big-endian display) from raw tx hex */
function txidFromRawTxHex(rawTxHex) {
  const raw = hexToBytes(rawTxHex);
  const h1 = sha256(raw);
  const h2 = sha256(h1);
  // txid is little-endian hash displayed as big-endian hex
  return bytesToHex(reverseBytes(h2));
}

/**
 * Scan raw tx for RPA stealth P2PKH outputs spendable by (scanPrivBytes, spendPrivBytes).
 *
 * @param {{
 *   rawTxHex: string,
 *   scanPrivBytes: Uint8Array,
 *   spendPrivBytes: Uint8Array,
 *   maxRoleIndex?: number,
 *   parsedTx?: any,
 * }} params
 * @returns {Array<{
 *   txid: string,
 *   vout: number,
 *   value: string,
 *   hash160Hex: string,
 *   rpaContext: { senderPub33Hex: string, prevoutHashHex: string, prevoutN: number, index: number },
 *   matchedInput: { vin: number, prevoutHashHex: string, prevoutN: number, senderPub33Hex: string },
 * }>}
 */
export function scanRawTxForRpaOutputs(params) {
  const {
    rawTxHex,
    scanPrivBytes,
    spendPrivBytes,
    maxRoleIndex = 2,
    parsedTx = null,
  } = params ?? {};

  if (typeof rawTxHex !== "string" || rawTxHex.length < 20) {
    throw new Error("scanRawTxForRpaOutputs: rawTxHex required");
  }
  if (!(scanPrivBytes instanceof Uint8Array) || scanPrivBytes.length !== 32) {
    throw new Error("scanRawTxForRpaOutputs: scanPrivBytes must be 32 bytes");
  }
  if (!(spendPrivBytes instanceof Uint8Array) || spendPrivBytes.length !== 32) {
    throw new Error("scanRawTxForRpaOutputs: spendPrivBytes must be 32 bytes");
  }

  const tx = parsedTx ?? parseTx(rawTxHex);
  const txid = tx?.txid ?? txidFromRawTxHex(rawTxHex);

  // Map of output hash160Hex -> list of outputs (rare but possible)
  const outputsByH160 = new Map();
  for (let vout = 0; vout < (tx.outputs?.length ?? 0); vout++) {
    const out = tx.outputs[vout];
    const h160 = parseP2pkhHash160(out.scriptPubKey);
    if (!h160) continue;

    const key = bytesToHex(h160);
    const entry = {
      txid,
      vout,
      value: String(out.value),
      hash160Hex: key,
    };

    const arr = outputsByH160.get(key) ?? [];
    arr.push(entry);
    outputsByH160.set(key, arr);
  }

  if (outputsByH160.size === 0) return [];

  const matches = [];
  const seen = new Set(); // "txid:vout" dedupe

  for (let vin = 0; vin < (tx.inputs?.length ?? 0); vin++) {
    const inp = tx.inputs[vin];

    // We can only scan RPA contexts from standard P2PKH inputs (needs pubkey in scriptSig)
    const senderPub33 = extractP2pkhPubkeyFromScriptSig(inp.scriptSig);
    if (!senderPub33) continue;

    const prevoutHashHex = inp.txid; // IMPORTANT: use "as-is" (your locked-in policy)
    const prevoutN = inp.vout;

    if (typeof prevoutHashHex !== "string" || prevoutHashHex.length !== 64) continue;
    if (!Number.isFinite(prevoutN)) continue;

    // Try role indices
    for (let index = 0; index <= maxRoleIndex; index++) {
      let oneTimePriv;
      try {
        ({ oneTimePriv } = deriveRpaOneTimePrivReceiver(
          scanPrivBytes,
          spendPrivBytes,
          senderPub33,
          prevoutHashHex,
          prevoutN,
          index
        ));
      } catch {
        continue;
      }

      // hash160(one-time pub)
      const pub33 = secp256k1.getPublicKey(oneTimePriv, true);
      const h160 = _hash160(pub33);
      const h160Hex = bytesToHex(h160);

      const outs = outputsByH160.get(h160Hex);
      if (!outs) continue;

      for (const o of outs) {
        const key = `${o.txid}:${o.vout}`;
        if (seen.has(key)) continue;
        seen.add(key);

        matches.push({
          txid: o.txid,
          vout: o.vout,
          value: o.value,
          hash160Hex: o.hash160Hex,
          rpaContext: {
            senderPub33Hex: bytesToHex(senderPub33),
            prevoutHashHex,
            prevoutN,
            index,
          },
          matchedInput: {
            vin,
            prevoutHashHex,
            prevoutN,
            senderPub33Hex: bytesToHex(senderPub33),
          },
        });
      }
    }
  }

  return matches;
}