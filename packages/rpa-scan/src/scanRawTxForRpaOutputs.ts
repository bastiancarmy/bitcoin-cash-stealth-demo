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