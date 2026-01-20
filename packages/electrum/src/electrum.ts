// packages/electrum/src/electrum.ts
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  shuffleArray,
  hexToBytes,
  bytesToHex,
  reverseBytes,
  concat,
  bytesToBigInt,
  decodeVarInt
} from '@bch-stealth/utils';

import { decodeCashAddress } from '@bch-stealth/utils/cashaddr';

import { ELECTRUM_SERVERS } from './servers.js';
import type { Network, Utxo, Prevout } from './types.js';
import { NodeElectrumSocket } from './node_socket.js';

export const DEFAULT_NETWORK: Network = 'chipnet';

type ElectrumServer = {
  host: string;
  port: number;
  protocol: string; // e.g. 'ssl' | 'tcp' | 'ws' | 'wss'
};

const CONNECT_TIMEOUT_MS = 10_000;

const feeRateCache: Record<string, { rate: number | null; t: number }> = Object.create(null);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, label = 'Operation timeout'): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(label)), ms);
  });

  // Ensure the timer never keeps the process alive after p finishes.
  return Promise.race([p, timeoutPromise]).finally(() => {
    if (id !== undefined) clearTimeout(id);
  }) as Promise<T>;
}


function isWsProtocol(proto: string): boolean {
  const p = proto.toLowerCase();
  return p === 'ws' || p === 'wss' || p === 'websocket';
}

function isTlsProtocol(proto: string): boolean {
  const p = proto.toLowerCase();
  return p === 'ssl' || p === 'tls' || p === 'ssl_tcp' || p === 'ssl-tcp';
}

function createSocketForServer(server: ElectrumServer, network: Network) {
  const proto = server.protocol.toLowerCase();

  // in createSocketForServer
  if (isWsProtocol(proto)) {
    const encrypted = proto === 'wss';
    return new ElectrumWebSocket(server.host, server.port, encrypted, CONNECT_TIMEOUT_MS);
  }

  const encrypted = isTlsProtocol(proto);
  const tlsOptions = network === 'chipnet' ? { rejectUnauthorized: false } : undefined;

  return new NodeElectrumSocket({
    host: server.host,
    port: server.port,
    encrypted,
    timeout: CONNECT_TIMEOUT_MS,
    tlsOptions
  });
}

function serversForNetwork(network: Network): ElectrumServer[] {
  // ELECTRUM_SERVERS shape is assumed from your existing codebase.
  // If it's keyed by network, adjust this selector accordingly.
  const anyServers = ELECTRUM_SERVERS as unknown as ElectrumServer[] | Record<string, ElectrumServer[]>;
  if (Array.isArray(anyServers)) return anyServers;

  const list = anyServers[network];
  if (!list || !Array.isArray(list)) {
    throw new Error(`No electrum servers configured for network: ${network}`);
  }
  return list;
}

export async function connectElectrum(network: Network = DEFAULT_NETWORK, retries = 10): Promise<ElectrumClient<any>> {
  const servers = shuffleArray([...serversForNetwork(network)]);

  for (let attempt = 0; attempt < retries; attempt++) {
    for (const server of servers) {
      const socket = createSocketForServer(server, network);
      const client = new ElectrumClient('bch-stealth-demo', '1.4.1', socket);

      try {
        await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'Connection timeout');
        return client;
      } catch {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
      }
    }

    // exponential backoff
    const delay = Math.pow(2, attempt) * 250;
    await sleep(delay);
  }

  throw new Error('No Electrum servers available after retries');
}

export function scriptToScripthash(script: Uint8Array): string {
  const hash = sha256(script);
  return bytesToHex(reverseBytes(hash));
}

export function addressToScripthash(address: string): string {
  const decoded = decodeCashAddress(address);

  // Keep this strict; expand later when you support more prefixes/types.
  if (decoded.prefix !== 'bitcoincash' && decoded.prefix !== 'bchtest') {
    throw new Error('Invalid CashAddr prefix');
  }
  if (decoded.type !== 'P2PKH') throw new Error('Only P2PKH supported');
  if (decoded.hash.length !== 20) throw new Error('Invalid PKH length');

  const script = concat(hexToBytes('76a914'), decoded.hash, hexToBytes('88ac'));
  return scriptToScripthash(script);
}

export async function getUtxosFromScripthash(
  scriptHash: string,
  network: Network = DEFAULT_NETWORK,
  includeUnconfirmed = true
): Promise<Utxo[]> {
  const client = await connectElectrum(network);
  try {
    const utxos = await client.request('blockchain.scripthash.listunspent', scriptHash);

    const processed: Utxo[] = (utxos as any[]).map((utxo: any) => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      value: utxo.value,
      height: utxo.height,
      token_data: utxo.token_data
    }));

    return includeUnconfirmed ? processed : processed.filter((u) => u.height > 0);
  } finally {
    await client.disconnect();
  }
}

export async function getUtxos(
  address: string,
  network: Network = DEFAULT_NETWORK,
  includeUnconfirmed = true
): Promise<Utxo[]> {
  const sh = addressToScripthash(address);
  return getUtxosFromScripthash(sh, network, includeUnconfirmed);
}

export async function getFeeRate(network: Network = DEFAULT_NETWORK): Promise<number> {
  const key = network;
  feeRateCache[key] = feeRateCache[key] ?? { rate: null, t: 0 };
  const cache = feeRateCache[key];

  if (cache.rate !== null && Date.now() - cache.t < 300_000) return cache.rate;

  const client = await connectElectrum(network);
  try {
    let relayFeeBCHPerKB = await client.request('blockchain.relayfee');
    if (typeof relayFeeBCHPerKB !== 'number') relayFeeBCHPerKB = 0.00001;
    if (relayFeeBCHPerKB < 0) relayFeeBCHPerKB = 0.00001;

    const relayFeeSatPerByte = Math.ceil((relayFeeBCHPerKB * 1e8) / 1000);

    const estimate = await client.request('blockchain.estimatefee', 2);
    let estimatedFeeSatPerByte = 1;

    if (typeof estimate === 'number' && estimate >= 0) {
      estimatedFeeSatPerByte = Math.ceil((estimate * 1e8) / 1000);
    }

    let feeRate = Math.max(relayFeeSatPerByte, estimatedFeeSatPerByte, 1);
    if (network === 'chipnet') feeRate = Math.max(feeRate, 2);

    cache.rate = feeRate;
    cache.t = Date.now();
    return feeRate;
  } catch {
    const fallback = network === 'chipnet' ? 2 : 1;
    cache.rate = fallback;
    cache.t = Date.now();
    return fallback;
  } finally {
    await client.disconnect();
  }
}

export async function broadcastTx(txHex: string, network: Network = DEFAULT_NETWORK): Promise<string> {
  const client = await connectElectrum(network);
  try {
    const response = await client.request('blockchain.transaction.broadcast', txHex);

    if (response instanceof Error) throw response;

    if (typeof response === 'string' && response.length === 64 && /^[0-9a-f]{64}$/i.test(response)) {
      return response;
    }

    if (typeof response === 'object' && response && (response as any).error) {
      const msg = (response as any).error?.message ?? JSON.stringify((response as any).error);
      throw new Error(`Broadcast error: ${msg}`);
    }

    throw new Error(`Invalid broadcast response: ${String(response)}`);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  } finally {
    await client.disconnect();
  }
}

export async function getPrevoutScriptAndValue(
  txid: string,
  vout: number,
  network: Network = DEFAULT_NETWORK
): Promise<Prevout> {
  const client = await connectElectrum(network);
  try {
    // Try verbose first
    let tx: any = await client.request('blockchain.transaction.get', txid, true);

    if (typeof tx === 'object' && tx && tx.vout) {
      const out = tx.vout[vout];

      let valueSats: number;
      if (typeof out.value_satoshi === 'number') valueSats = out.value_satoshi;
      else if (typeof out.value === 'number') valueSats = Math.round(out.value * 1e8);
      else if (typeof out.value === 'string') valueSats = Math.round(parseFloat(out.value) * 1e8);
      else throw new Error('Unsupported verbose tx format for value');

      const scriptHex = out.scriptPubKey?.hex || out.scriptPubKey;
      if (!scriptHex) throw new Error('Missing scriptPubKey in verbose tx');

      return { scriptPubKey: hexToBytes(scriptHex), value: valueSats };
    }

    // Fallback: raw tx hex
    if (typeof tx !== 'string') {
      tx = await client.request('blockchain.transaction.get', txid);
      if (typeof tx !== 'string') throw new Error('Unexpected electrum response for transaction.get');
    }

    const bytes = hexToBytes(tx);
    let pos = 0;

    // version
    pos += 4;

    // inputs
    const inCount = decodeVarInt(bytes, pos);
    pos += inCount.length;

    for (let i = 0; i < inCount.value; i++) {
      // outpoint (32 txid + 4 vout)
      pos += 32 + 4;

      // scriptSig
      const scrLen = decodeVarInt(bytes, pos);
      pos += scrLen.length;
      pos += scrLen.value;

      // sequence
      pos += 4;
    }

    // outputs
    const outCount = decodeVarInt(bytes, pos);
    pos += outCount.length;

    if (vout >= outCount.value) throw new Error('vout index out of range');

    for (let i = 0; i < outCount.value; i++) {
      // value (8 bytes LE)
      const valueLE = bytes.slice(pos, pos + 8);
      const value = Number(bytesToBigInt(reverseBytes(valueLE)));
      pos += 8;

      // scriptPubKey (varint length + bytes)
      const scrLen = decodeVarInt(bytes, pos);
      pos += scrLen.length;

      const script = bytes.slice(pos, pos + scrLen.value);
      pos += scrLen.value;

      if (i === vout) return { scriptPubKey: script, value };
    }

    throw new Error('Could not locate vout');
  } finally {
    await client.disconnect();
  }
}

/**
 * Minimal helper for header subscription (keeps the client open).
 * Caller must call `disconnect()` on the returned client.
 */
export async function subscribeHeaders(
  network: Network = DEFAULT_NETWORK,
  onHeader?: (header: unknown) => void
): Promise<ElectrumClient<any>> {
  const client = await connectElectrum(network);

  const handler = (data: any) => {
    if (data?.method === 'blockchain.headers.subscribe') {
      const header = data?.params?.[0];
      onHeader?.(header);
    }
  };

  client.on('notification', handler);
  await client.subscribe('blockchain.headers.subscribe');

  return client;
}
