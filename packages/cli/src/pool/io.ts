// packages/cli/src/pool/io.ts
//
// Chain IO boundary for CLI pool demo (B4a).
// Keep callsites stable; adapt to electrum export variations here.

import { p2pkhHash160HexToScripthashHex } from './scripthash.js';

export function makeChainIO(args: {
  network: string;
  electrum: any;
  // Some callers still pass this during refactors. Keep it optional + ignored for now.
  txb?: any;
}) {
  const { network, electrum } = args;

  // Electrum exports vary across refactors/builds. Prefer feature detection.
  const broadcastTx = (electrum as any)?.broadcastTx;
  const getTxDetails = (electrum as any)?.getTxDetails;
  const getUtxosFromScripthash = (electrum as any)?.getUtxosFromScripthash;
  const getFeeRate = (electrum as any)?.getFeeRate;

  // Present in the electrum.js you pasted (good primitive for prevout lookup)
  const getPrevoutScriptAndValue = (electrum as any)?.getPrevoutScriptAndValue;

  function assertFn(name: string, fn: any) {
    if (typeof fn !== 'function') {
      const keys = electrum ? Object.keys(electrum).sort().join(', ') : '<null>';
      throw new Error(`[chainIO] electrum.${name} is not a function. Available exports: ${keys}`);
    }
  }

  /**
   * Return a minimal “prev output” object with the shape CLI already expects:
   *   { value: number, scriptPubKey: Uint8Array }
   *
   * Supports both:
   * - electrum.getTxDetails(txid, network) -> details.outputs[vout]
   * - electrum.getPrevoutScriptAndValue(txid, vout, network)
   */
  async function getPrevOutput(txid: string, vout: number): Promise<any> {
    if (typeof getTxDetails === 'function') {
      const details = await getTxDetails(txid, network);
      const out = details?.outputs?.[vout];
      if (!out) throw new Error(`Unable to read prevout ${txid}:${vout}`);
      return out;
    }

    if (typeof getPrevoutScriptAndValue === 'function') {
      const res = await getPrevoutScriptAndValue(txid, vout, network);
      if (!res?.scriptPubKey || typeof res?.value !== 'number') {
        throw new Error(`Unable to read prevout ${txid}:${vout} via getPrevoutScriptAndValue`);
      }
      return { value: res.value, scriptPubKey: res.scriptPubKey };
    }

    const keys = electrum ? Object.keys(electrum).sort().join(', ') : '<null>';
    throw new Error(
      `[chainIO] No prevout reader available. Expected electrum.getTxDetails or electrum.getPrevoutScriptAndValue.\n` +
        `Available exports: ${keys}`
    );
  }

  async function getFeeRateOrFallback(): Promise<number> {
    // electrum.getFeeRate(network?) exists in your snippet; keep it defensive.
    if (typeof getFeeRate !== 'function') return network === 'chipnet' ? 2 : 1;

    try {
      const fr = await getFeeRate(network);
      if (typeof fr === 'number' && Number.isFinite(fr) && fr >= 1) return Math.ceil(fr);
    } catch {
      // ignore
    }
    return network === 'chipnet' ? 2 : 1;
  }

  async function broadcastRawTx(rawHex: string): Promise<string> {
    assertFn('broadcastTx', broadcastTx);
    // electrum.broadcastTx(txHex, network=DEFAULT_NETWORK)
    return await broadcastTx(rawHex, network);
  }

  /**
   * B4a compatibility wrapper:
   * Call sites pass { hash160Hex }, but Electrum needs a scripthash.
   * Keep conversion inside IO boundary so index.ts stays mechanical.
   */
  async function isP2pkhOutpointUnspent(args: {
    txid: string;
    vout: number;
    hash160Hex: string;
  }): Promise<boolean> {
    assertFn('getUtxosFromScripthash', getUtxosFromScripthash);

    const scripthashHex = p2pkhHash160HexToScripthashHex(args.hash160Hex).toLowerCase();
    const utxos = await getUtxosFromScripthash(scripthashHex, network, true);

    return Array.isArray(utxos) && utxos.some((u) => u.txid === args.txid && u.vout === args.vout);
  }

  async function waitForP2pkhOutpointUnspent(
    args: { txid: string; vout: number; hash160Hex: string },
    opts: { attempts?: number; delayMs?: number } = {}
  ): Promise<boolean> {
    const attempts = opts.attempts ?? 10;
    const delayMs = opts.delayMs ?? 800;

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < attempts; i++) {
      const ok = await isP2pkhOutpointUnspent(args);
      if (ok) return true;
      await sleep(delayMs);
    }
    return false;
  }

  return {
    getPrevOutput,
    getFeeRateOrFallback,
    broadcastRawTx,

    // Keep these names/signatures stable for index.ts (B4a)
    isP2pkhOutpointUnspent,
    waitForP2pkhOutpointUnspent,
  };
}