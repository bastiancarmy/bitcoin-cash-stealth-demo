// packages/rpa-scan/src/scanChainWindow.ts

import type { RpaMatch, ScanChainWindowParams } from "./types.js";
import { scanRawTxForRpaOutputs } from "./scanRawTxForRpaOutputs.js";

/**
 * Scan a bounded chain window by txid list.
 * Stays library-friendly by asking the caller for `listTxidsInWindow` and `fetchRawTxHex`.
 */
export async function scanChainWindow(params: ScanChainWindowParams): Promise<RpaMatch[]> {
  const {
    listTxidsInWindow,
    fetchRawTxHex,
    startHeight,
    endHeight,
    scanPrivBytes,
    spendPrivBytes,
    maxRoleIndex,

    indexHints = null,
    stopOnFirstMatch = false,
  } = params;

  const txids = await listTxidsInWindow({ startHeight, endHeight });

  const matches: RpaMatch[] = [];
  for (const txid of txids) {
    const rawTxHex = await fetchRawTxHex(txid);

    const found = scanRawTxForRpaOutputs({
      rawTxHex,
      scanPrivBytes,
      spendPrivBytes,
      maxRoleIndex,
      indexHints,
      stopOnFirstMatch,
    } as any);

    matches.push(...found);
    if (stopOnFirstMatch && matches.length > 0) break;
  }

  return matches;
}