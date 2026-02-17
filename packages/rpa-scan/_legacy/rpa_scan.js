// packages/rpa-scan/_legacy/rpa_scan.js
//
// RPA stealth output scanner for raw tx hex.
// LOCKED-IN policy:
// - prevoutHashHex used "as-is" (no endian reversal)

import { secp256k1 } from "@noble/curves/secp256k1.js";

import { parseTx } from "./electrum.js";
import {
  deriveRpaOneTimePrivReceiver,
  deriveRpaSharedSecretReceiver,
} from "./derivation.js";

import { _hash160, bytesToHex, hexToBytes, reverseBytes, sha256 } from "./utils.js";

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
 * Extract the pubkey from standard P2PKH scriptSig.
 * Typical form: <sigPush ...> <pubPush 33B>
 */
function extractP2pkhPubkeyFromScriptSig(scriptSig) {
  const ss = scriptSig instanceof Uint8Array ? scriptSig : hexToBytes(scriptSig);
  if (ss.length < 35) return null;

  const pushLen = ss[ss.length - 34];
  if (pushLen !== 33) return null;

  const pub33 = ss.slice(ss.length - 33);
  if (pub33.length !== 33) return null;
  if (pub33[0] !== 0x02 && pub33[0] !== 0x03) return null;

  return pub33;
}

/** Compute txid (hex) from raw tx hex */
function txidFromRawTxHex(rawTxHex) {
  const raw = hexToBytes(rawTxHex);
  const h1 = sha256(raw);
  const h2 = sha256(h1);
  return bytesToHex(reverseBytes(h2));
}

/**
 * Scan raw tx for RPA stealth P2PKH outputs.
 *
 * Additions:
 * - indexHints?: number[] (tried first)
 * - stopOnFirstMatch?: boolean
 * - off-by-one: scans [0..maxRoleIndex-1]
 *
 * Speedups:
 * - compute sharedSecret once per vin and reuse for all indices
 */
export function scanRawTxForRpaOutputs(params) {
  const {
    rawTxHex,
    scanPrivBytes,
    spendPrivBytes,
    maxRoleIndex = 2048,
    parsedTx = null,

    indexHints = null,
    stopOnFirstMatch = false,
    maxMatches = Infinity,
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

  const outputsByH160 = new Map();
  let totalP2pkhOutputs = 0;

  for (let vout = 0; vout < (tx.outputs?.length ?? 0); vout++) {
    const out = tx.outputs[vout];
    const h160 = parseP2pkhHash160(out.scriptPubKey);
    if (!h160) continue;

    totalP2pkhOutputs++;

    const key = bytesToHex(h160);
    const entry = {
      txid,
      vout,
      value: String(out.value),
      valueSats: String(out.value),
      hash160Hex: key,
    };

    const arr = outputsByH160.get(key) ?? [];
    arr.push(entry);
    outputsByH160.set(key, arr);
  }

  if (outputsByH160.size === 0) return [];

  const matches = [];
  const seen = new Set();

  const maxN = Math.max(0, Math.floor(Number(maxRoleIndex) || 0));
  const maxM = Number.isFinite(Number(maxMatches)) ? Math.max(0, Math.floor(Number(maxMatches))) : Infinity;

  let hintList = [];
  if (Array.isArray(indexHints) && indexHints.length > 0) {
    const s = new Set();
    for (const x of indexHints) {
      const n = Math.floor(Number(x));
      if (!Number.isFinite(n)) continue;
      if (n < 0 || n >= maxN) continue;
      s.add(n);
    }
    hintList = Array.from(s);
  }

  const maybeStop = () => {
    if (stopOnFirstMatch && matches.length > 0) return true;
    if (Number.isFinite(maxM) && matches.length >= maxM) return true;
    if (seen.size >= totalP2pkhOutputs && totalP2pkhOutputs > 0) return true;
    return false;
  };

  const tryIndex = ({
    vin,
    senderPub33,
    senderPub33Hex,
    prevoutHashHex,
    prevoutN,
    index,
    sharedSecret32,
    tried,
  }) => {
    if (index < 0 || index >= maxN) return false;
    if (tried.has(index)) return false;
    tried.add(index);

    let oneTimePriv;
    try {
      ({ oneTimePriv } = deriveRpaOneTimePrivReceiver(
        scanPrivBytes,
        spendPrivBytes,
        senderPub33,
        prevoutHashHex,
        prevoutN,
        index,
        sharedSecret32 // ✅ reuse precomputed secret
      ));
    } catch {
      return false;
    }

    const pub33 = secp256k1.getPublicKey(oneTimePriv, true);
    const h160Hex = bytesToHex(_hash160(pub33));

    const outs = outputsByH160.get(h160Hex);
    if (!outs) return false;

    for (const o of outs) {
      const key = `${o.txid}:${o.vout}`;
      if (seen.has(key)) continue;
      seen.add(key);

      matches.push({
        txid: o.txid,
        vout: o.vout,
        value: o.value,
        valueSats: o.valueSats,
        hash160Hex: o.hash160Hex,
        roleIndex: index,
        rpaContext: {
          senderPub33Hex,
          prevoutHashHex,
          prevoutN,
          index,
        },
        matchedInput: {
          vin,
          prevoutHashHex,
          prevoutN,
          senderPub33Hex,
        },
      });

      if (maybeStop()) return true;
    }

    return false;
  };

  for (let vin = 0; vin < (tx.inputs?.length ?? 0); vin++) {
    const inp = tx.inputs[vin];

    const senderPub33 = extractP2pkhPubkeyFromScriptSig(inp.scriptSig);
    if (!senderPub33) continue;

    const senderPub33Hex = bytesToHex(senderPub33);
    const prevoutHashHex = inp.txid; // as-is
    const prevoutN = inp.vout;

    if (typeof prevoutHashHex !== "string" || prevoutHashHex.length !== 64) continue;
    if (!Number.isFinite(prevoutN)) continue;

    // ✅ compute shared secret ONCE per vin
    let sharedSecret32;
    try {
      sharedSecret32 = deriveRpaSharedSecretReceiver(scanPrivBytes, senderPub33, prevoutHashHex, prevoutN);
    } catch {
      continue;
    }

    const tried = new Set();

    // hints first
    for (let i = 0; i < hintList.length; i++) {
      const index = hintList[i];
      const didStop = tryIndex({
        vin,
        senderPub33,
        senderPub33Hex,
        prevoutHashHex,
        prevoutN,
        index,
        sharedSecret32,
        tried,
      });
      if (didStop) return matches;
    }

    // full scan: [0..maxN-1]
    for (let index = 0; index < maxN; index++) {
      const didStop = tryIndex({
        vin,
        senderPub33,
        senderPub33Hex,
        prevoutHashHex,
        prevoutN,
        index,
        sharedSecret32,
        tried,
      });
      if (didStop) return matches;
    }
  }

  return matches;
}