This file is a merged representation of a subset of the codebase, containing files not matching ignore patterns, combined into a single document by Repomix.

# File Summary

## Purpose
This file contains a packed representation of a subset of the repository's contents that is considered the most important context.
It is designed to be easily consumable by AI systems for analysis, code review,
or other automated processes.

## File Format
The content is organized as follows:
1. This summary section
2. Repository information
3. Directory structure
4. Repository files (if enabled)
5. Multiple file entries, each consisting of:
  a. A header with the file path (## File: path/to/file)
  b. The full contents of the file in a code block

## Usage Guidelines
- This file should be treated as read-only. Any changes should be made to the
  original repository files, not this packed version.
- When processing this file, use the file path to distinguish
  between different files in the repository.
- Be aware that this file may contain sensitive information. Handle it with
  the same level of security as you would the original repository.

## Notes
- Some files may have been excluded based on .gitignore rules and Repomix's configuration
- Binary files are not included in this packed representation. Please refer to the Repository Structure section for a complete list of file paths, including binary files
- Files matching these patterns are excluded: node_modules/, dist/, doc, repomix-output.md, README.confidential-assets.md
- Files matching patterns in .gitignore are excluded
- Files matching default ignore patterns are excluded
- Files are sorted by Git change count (files with more changes are at the bottom)

# Directory Structure
```
src/
  index.ts
  scanChainWindow.ts
  scanRawTxForRpaOutputs.ts
  types.ts
package.json
rpa_scan.js
tsconfig.json
```

# Files

## File: src/index.ts
```typescript
export * from "./types.js";
export * from "./scanRawTxForRpaOutputs.js";
export * from "./scanChainWindow.js";
```

## File: src/scanChainWindow.ts
```typescript
import type { RpaMatch, ScanChainWindowParams } from "./types.js";
import { scanRawTxForRpaOutputs } from "./scanRawTxForRpaOutputs.js";

/**
 * Scan a bounded chain window by txid list.
 * This stays library-friendly by asking the caller for `listTxidsInWindow` and `fetchRawTxHex`.
 */
export async function scanChainWindow(params: ScanChainWindowParams): Promise<RpaMatch[]> {
  const {
    listTxidsInWindow,
    fetchRawTxHex,
    startHeight,
    endHeight,
    scanPrivBytes,
    spendPrivBytes,
    maxRoleIndex
  } = params;

  const txids = await listTxidsInWindow({ startHeight, endHeight });

  const matches: RpaMatch[] = [];
  for (const txid of txids) {
    const rawTxHex = await fetchRawTxHex(txid);
    const found = scanRawTxForRpaOutputs({
      rawTxHex,
      scanPrivBytes,
      spendPrivBytes,
      maxRoleIndex
    });
    matches.push(...found);
  }

  return matches;
}
```

## File: src/scanRawTxForRpaOutputs.ts
```typescript
import type { RpaMatch, ScanRawTxForRpaOutputsParams } from "./types.js";

/**
 * Scan a raw transaction for RPA-like stealth outputs.
 *
 * Phase 2 intent:
 * - Use your existing RPA derivation rules (paycode, prevout-based context, index/role).
 * - Match candidate P2PKH hash160s against outputs in the tx.
 *
 * This function should be PURE:
 * - no electrum calls
 * - no file IO
 * - deterministic output given inputs
 */
export function scanRawTxForRpaOutputs(params: ScanRawTxForRpaOutputsParams): RpaMatch[] {
  const { rawTxHex, maxMatches = 64 } = params;

  // TODO: parse rawTxHex -> outputs[]
  // You already have parseTx(rawTxHex) in your repo; you can:
  //  - copy a minimal parser here, OR
  //  - pass in a parse function via params (preferred if you want).
  //
  // For now, just return empty to make the package compile.

  void rawTxHex;
  void maxMatches;

  return [];
}
```

## File: src/types.ts
```typescript
export type Hex = string;

export type RpaMatch = {
  txid: Hex;
  vout: number;
  valueSats?: bigint;
  lockingBytecodeHex: Hex;

  // the derived address the scanner believes this is for
  hash160Hex: Hex;

  // optional extra metadata you may want to persist
  roleIndex?: number;
  note?: string;
};

export type ScanRawTxForRpaOutputsParams = {
  rawTxHex: Hex;

  scanPrivBytes: Uint8Array;
  spendPrivBytes: Uint8Array;

  /**
   * How far to scan role/index space (kept small in Phase 2).
   * You can widen later as you add checkpoints.
   */
  maxRoleIndex: number;

  /**
   * Optional: cap on candidates per tx so we never blow up.
   */
  maxMatches?: number;
};

export type ScanChainWindowParams = {
  /**
   * Your electrum helper (so this package stays pure/portable).
   * Implement this in your repo using your existing electrum.js.
   */
  fetchRawTxHex: (txid: Hex) => Promise<Hex>;

  /**
   * Return txids in the window. Again implemented in your repo.
   * You might back this by: scripthash history, block ranges, or mempool.
   */
  listTxidsInWindow: (opts: { startHeight: number; endHeight: number }) => Promise<Hex[]>;

  startHeight: number;
  endHeight: number;

  scanPrivBytes: Uint8Array;
  spendPrivBytes: Uint8Array;
  maxRoleIndex: number;
};
```

## File: package.json
```json
{
  "name": "@bch-stealth/rpa-scan",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.9.3"
  }
}
```

## File: rpa_scan.js
```javascript
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
```

## File: tsconfig.json
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```
