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