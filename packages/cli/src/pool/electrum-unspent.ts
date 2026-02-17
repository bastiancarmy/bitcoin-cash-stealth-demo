// packages/cli/src/pool/electrum-unspent.ts
import { hexToBytes, bytesToHex, reverseBytes, sha256 } from '@bch-stealth/utils';
import { getFullScriptPubKeyHex } from '@bch-stealth/tx-builder';

/**
 * Determine whether an outpoint is unspent using Electrum *history*,
 * not listunspent.
 *
 * Why: Some Electrum backends do not report certain script types (or
 * token-bearing scriptPubKeys) correctly in scripthash.listunspent.
 *
 * Method:
 *  1) Fetch the tx output (to ensure it exists + get locking script).
 *  2) Compute scripthash on the LOCKING bytecode (out.scriptPubKey.hex).
 *  3) Get scripthash history.
 *  4) Scan history txs for a vin that spends (txid,vout).
 *  5) If no spender found => treat as unspent.
 */
export async function outpointIsUnspentViaVerboseTx(args: {
  c: any; // electrum client
  txid: string;
  vout: number;
  /**
   * Optional safety knob: if the history is unexpectedly huge, you can cap scan.
   * Default: scan all history entries (recommended for correctness).
   */
  maxHistoryToScan?: number;
}): Promise<{ ok: boolean; spkHex: string | null; spentByTxid?: string | null }> {
  const txid = String(args.txid).toLowerCase();
  const vout = Number(args.vout);

  if (!/^[0-9a-f]{64}$/.test(txid) || !Number.isFinite(vout) || vout < 0) {
    return { ok: false, spkHex: null, spentByTxid: null };
  }

  // 1) Fetch verbose tx to ensure vout exists and to get scriptPubKey.hex + tokenData
  const tx = await args.c.request('blockchain.transaction.get', txid, true);
  const out = tx?.vout?.[vout];
  const lockingHex = String(out?.scriptPubKey?.hex ?? '').toLowerCase();

  if (!lockingHex) return { ok: false, spkHex: null, spentByTxid: null };

  // Full script hex is still useful for debug printing and other callers,
  // but DO NOT use it for Electrum scripthash here.
  const fullSpkHex = getFullScriptPubKeyHex({
    lockingBytecodeHex: lockingHex,
    tokenData: out?.tokenData ?? null,
  });

  // 2) Compute scripthash on LOCKING bytecode (Electrum indexes locking script)
  const scripthash = bytesToHex(reverseBytes(sha256(hexToBytes(lockingHex))));

  // 3) Fetch history
  const hist = await args.c.request('blockchain.scripthash.get_history', scripthash);
  if (!Array.isArray(hist)) {
    // If backend can’t even provide history, we cannot prove unspent.
    return { ok: false, spkHex: fullSpkHex, spentByTxid: null };
  }

  // Optional cap (default scan all)
  const maxN = Number.isFinite(args.maxHistoryToScan) && (args.maxHistoryToScan as number) > 0
    ? Math.min(hist.length, Number(args.maxHistoryToScan))
    : hist.length;

  // 4) Scan history txs for a spender
  // Scan newest -> oldest (best chance to find a spender early)
  for (let i = hist.length - 1, scanned = 0; i >= 0 && scanned < maxN; i--, scanned++) {
    const htxid = String(hist[i]?.tx_hash ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(htxid)) continue;

    const t = await args.c.request('blockchain.transaction.get', htxid, true);
    const vins = Array.isArray(t?.vin) ? t.vin : [];

    for (const vin of vins) {
      const prev = String(vin?.txid ?? vin?.tx_hash ?? '').toLowerCase();
      const n = Number(vin?.vout ?? vin?.tx_pos ?? -1);
      if (prev === txid && n === vout) {
        // Found spender => spent
        return { ok: false, spkHex: fullSpkHex, spentByTxid: htxid };
      }
    }
  }

  // 5) No spender found => treat as unspent
  return { ok: true, spkHex: fullSpkHex, spentByTxid: null };
}