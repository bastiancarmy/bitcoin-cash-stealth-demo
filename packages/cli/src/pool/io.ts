// packages/cli/src/pool/io.ts
import type * as ElectrumNS from '@bch-stealth/electrum';
import type * as TxBuilderNS from '@bch-stealth/tx-builder';

export function makeChainIO(args: {
  network: string;
  electrum: any;   // Electrum namespace (you already cast Electrum as any in CLI)
  txb: any;        // TxBuilder namespace (same pattern)
}) {
  const { network, electrum, txb } = args;

  const { broadcastTx, getTxDetails, getUtxosFromScripthash, getFeeRate } = electrum as any;

  async function getPrevOutput(txid: string, vout: number): Promise<any> {
    const details = await getTxDetails(txid, network);
    const out = details.outputs?.[vout];
    if (!out) throw new Error(`Unable to read prevout ${txid}:${vout}`);
    return out;
  }

  async function pickFeeRateOrFallback(): Promise<number> {
    try {
      const fr = await getFeeRate();
      if (typeof fr === 'number' && Number.isFinite(fr) && fr >= 1) return Math.ceil(fr);
    } catch {}
    return 2;
  }

  async function broadcastRawTx(rawHex: string): Promise<string> {
    return await broadcastTx(rawHex);
  }

  async function isP2pkhOutpointUnspent(args: {
    scripthashHex: string;
    txid: string;
    vout: number;
  }): Promise<boolean> {
    const { scripthashHex, txid, vout } = args;
    const utxos = await getUtxosFromScripthash(scripthashHex.toLowerCase(), network, true);
    return Array.isArray(utxos) && utxos.some((u) => u.txid === txid && u.vout === vout);
  }

  async function waitForP2pkhOutpointUnspent(
    args: { scripthashHex: string; txid: string; vout: number },
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
    pickFeeRateOrFallback,
    broadcastRawTx,
    isP2pkhOutpointUnspent,
    waitForP2pkhOutpointUnspent,
  };
}