// packages/cli/src/pool/io.ts
import type { ChainIO } from './context.js';
import { hexToBytes } from '@bch-stealth/utils';

// Minimal P2PKH locking bytecode (avoid importing other helpers here)
function p2pkhLockingBytecode(hash160: Uint8Array): Uint8Array {
  if (!(hash160 instanceof Uint8Array) || hash160.length !== 20) {
    throw new Error('p2pkhLockingBytecode: hash160 must be 20 bytes');
  }
  return Uint8Array.from([
    0x76, // OP_DUP
    0xa9, // OP_HASH160
    0x14, // push 20
    ...hash160,
    0x88, // OP_EQUALVERIFY
    0xac, // OP_CHECKSIG
  ]);
}

export function makeChainIO(args: {
  network: string;
  electrum: any;
  // Some callers still pass this during refactors. Keep it optional + ignored for now.
  txb?: any;
}): ChainIO {
  const { network, electrum } = args;

  // Electrum exports vary across refactors/builds. Prefer feature detection.
  const broadcastTx = (electrum as any)?.broadcastTx;
  const getTxDetails = (electrum as any)?.getTxDetails;
  const getUtxosFromScripthash = (electrum as any)?.getUtxosFromScripthash;
  const getFeeRate = (electrum as any)?.getFeeRate;

  // Present in your current electrum build (good primitive for prevout lookup)
  const getPrevoutScriptAndValue = (electrum as any)?.getPrevoutScriptAndValue;

  // Present in your electrum build (preferred for scripthash derivation)
  const scriptToScripthash = (electrum as any)?.scriptToScripthash;

  function assertFn(name: string, fn: any) {
    if (typeof fn !== 'function') {
      const keys = electrum ? Object.keys(electrum).sort().join(', ') : '<null>';
      throw new Error(`[chainIO] electrum.${name} is not a function. Available exports: ${keys}`);
    }
  }

  /**
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

  async function callGetUtxosFromScripthash(scripthashHex: string): Promise<any[]> {
    assertFn('getUtxosFromScripthash', getUtxosFromScripthash);

    // Try common signatures across refactors/clients.
    const attempts: Array<() => Promise<any>> = [
      () => (getUtxosFromScripthash as any)(scripthashHex, network, true),
      () => (getUtxosFromScripthash as any)(scripthashHex, network),
      () => (getUtxosFromScripthash as any)(scripthashHex),
      () => (getUtxosFromScripthash as any)(network, scripthashHex, true),
      () => (getUtxosFromScripthash as any)(network, scripthashHex),
    ];

    let lastErr: any = null;

    for (const fn of attempts) {
      try {
        const res = await fn();
        if (Array.isArray(res)) return res;
        if (res && Array.isArray((res as any).utxos)) return (res as any).utxos;
      } catch (e) {
        lastErr = e;
      }
    }

    const keys = electrum ? Object.keys(electrum).sort().join(', ') : '<null>';
    throw new Error(
      `[chainIO] getUtxosFromScripthash call failed for all known signatures.\n` +
        `scripthash=${scripthashHex} network=${network}\n` +
        `Available exports: ${keys}\n` +
        `Last error: ${lastErr?.stack || lastErr?.message || lastErr}`
    );
  }

  /**
   * Convert a P2PKH hash160 into an electrum scripthash using the electrum lib’s own conversion,
   * if available. This avoids mismatches due to differing internal conventions.
   */
  async function p2pkhHash160HexToScripthashHex(hash160Hex: string): Promise<string> {
    const h160 = hexToBytes(hash160Hex);
    const spk = p2pkhLockingBytecode(h160);

    if (typeof scriptToScripthash === 'function') {
      // Try both: scriptToScripthash(script, network) and scriptToScripthash(script)
      try {
        const v = await (scriptToScripthash as any)(spk, network);
        if (typeof v === 'string' && v.length) return v;
      } catch {
        // ignore
      }
      const v2 = await (scriptToScripthash as any)(spk);
      if (typeof v2 === 'string' && v2.length) return v2;
    }

    throw new Error(
      `[chainIO] electrum.scriptToScripthash is missing or did not return a string. ` +
        `Cannot derive scripthash for funding checks.`
    );
  }

  async function isP2pkhOutpointUnspent(args: {
    txid: string;
    vout: number;
    hash160Hex: string;
  }): Promise<boolean> {
    const scripthashHex = (await p2pkhHash160HexToScripthashHex(args.hash160Hex)).toLowerCase();
    const utxos = await callGetUtxosFromScripthash(scripthashHex);
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

  // IMPORTANT: ensure we return the ChainIO object (prevents TS inferring void)
  return {
    getPrevOutput,
    getFeeRateOrFallback,
    broadcastRawTx,
    isP2pkhOutpointUnspent,
    waitForP2pkhOutpointUnspent,
  };
}