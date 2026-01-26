// packages/cli/src/pool/state.ts

import type {
  PoolState,
  StealthUtxoRecord,
  FileBackedPoolStateStore,
} from '@bch-stealth/pool-state';

import {
  ensurePoolStateDefaults,
  markStealthSpent,
  readPoolState,
  writePoolState,
} from '@bch-stealth/pool-state';

import type { WalletLike } from './context.js';

import { bytesToHex, hexToBytes, hash160 } from '@bch-stealth/utils';
import { deriveRpaOneTimePrivReceiver } from '@bch-stealth/rpa';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { pubkeyHashFromPriv } from '../utils.js';

/**
 * Create an empty PoolState shell.
 * Keep callable with no args for backwards-compat with older CLI call sites.
 */
export function emptyPoolState(networkDefault: string = 'chipnet'): PoolState {
  return ensurePoolStateDefaults({
    schemaVersion: 1,
    network: networkDefault,
    createdAt: new Date().toISOString(),
  } as any);
}

/**
 * Load state via pool-state store helpers; return an empty state if missing.
 * NOTE: uses @bch-stealth/pool-state readPoolState/writePoolState to avoid coupling
 * to FileBackedPoolStateStore method names.
 */
export async function loadStateOrEmpty(args: {
  store: FileBackedPoolStateStore;
  networkDefault: string;
}): Promise<PoolState> {
  const { store, networkDefault } = args;

  const st = await readPoolState({ store, networkDefault });
  if (!st) return emptyPoolState(networkDefault);

  return ensurePoolStateDefaults(st);
}

export async function saveState(args: {
  store: FileBackedPoolStateStore;
  state: PoolState;
  networkDefault: string;
}): Promise<void> {
  const { store, state, networkDefault } = args;

  const st = ensurePoolStateDefaults(state);
  await writePoolState({ store, state: st, networkDefault });
}

// -------------------------------------------------------------------------------------
// Funding selection helper (moved from index.ts)
// -------------------------------------------------------------------------------------

function parseP2pkhHash160(scriptPubKey: Uint8Array | string): Uint8Array | null {
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

function toBigIntSats(x: any): bigint {
  return typeof x === 'bigint' ? x : BigInt(x);
}

function errToString(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export async function selectFundingUtxo(args: {
  mode: 'wallet-send' | 'pool-op';
  prefer?: Array<'base' | 'stealth'>; // default ['base','stealth']
  minConfirmations?: number;
  includeUnconfirmed?: boolean;

  // side effects must be explicit
  markStaleStealthRecords?: boolean; // default false

  // token safety
  allowTokens?: boolean; // default false

  state?: PoolState | null;
  wallet: WalletLike;
  ownerTag: string;
  minSats?: bigint;

  chainIO: {
    isP2pkhOutpointUnspent: (o: { txid: string; vout: number; hash160Hex: string }) => Promise<boolean>;
    getPrevOutput: (txid: string, vout: number) => Promise<any>;
    // optional, only used if provided
    getTipHeight?: () => Promise<number>;
  };

  // Keep this as unknown/any-ish because callers are inconsistent today.
  // We'll probe signatures safely.
  getUtxos: (...a: any[]) => Promise<any[]>;
  network: string;
  dustSats: bigint;
}): Promise<{
  txid: string;
  vout: number;
  prevOut: any;
  signPrivBytes: Uint8Array;
  source: 'stealth' | 'base';
  record?: StealthUtxoRecord;
  stale?: Array<{ source: 'stealth' | 'base'; txid: string; vout: number; reason: string }>;
}> {
  const {
    mode,
    prefer = ['base', 'stealth'],
    minConfirmations = 0,
    includeUnconfirmed = true,
    markStaleStealthRecords = false,
    allowTokens = false,

    state,
    wallet,
    ownerTag,
    minSats = args.dustSats,
    chainIO,
    getUtxos,
    network,
  } = args;

  const dbg = process.env.BCH_STEALTH_DEBUG_FUNDING === '1';
  const stale: Array<{ source: 'stealth' | 'base'; txid: string; vout: number; reason: string }> = [];

  function dlog(obj: any) {
    if (!dbg) return;
    console.log(`[funding] ${JSON.stringify(obj, null, 2)}`);
  }

  function toValueSats(u: any): bigint {
    const v = u?.valueSats ?? u?.value_sats ?? u?.value ?? 0;
    return typeof v === 'bigint' ? v : BigInt(v);
  }

  function isTokenUtxo(u: any): boolean {
    const td = u?.tokenData ?? u?.token_data ?? null;
    return td != null;
  }

  async function getTipHeightMaybe(): Promise<number | undefined> {
    if (!chainIO.getTipHeight) return undefined;
    try {
      return await chainIO.getTipHeight();
    } catch {
      return undefined;
    }
  }

  function confirmationsFrom(utxo: any, tipHeight?: number): number {
    if (typeof utxo?.confirmations === 'number') return utxo.confirmations;
    const h = typeof utxo?.height === 'number' ? utxo.height : 0;
    if (!h) return 0;
    if (typeof tipHeight === 'number') return tipHeight - h + 1;
    return 1;
  }

  function confirmedEnough(utxo: any, tipHeight?: number): boolean {
    if (includeUnconfirmed) return true;
    if (minConfirmations <= 0) return true;
    return confirmationsFrom(utxo, tipHeight) >= minConfirmations;
  }

  function pickLargest(utxos: any[]): any | null {
    if (!utxos.length) return null;
    let best = utxos[0];
    let bestV = toValueSats(best);
    for (let i = 1; i < utxos.length; i++) {
      const v = toValueSats(utxos[i]);
      if (v > bestV) {
        best = utxos[i];
        bestV = v;
      }
    }
    return best;
  }

  // --- stealth selection (skips entirely if state missing) ---
  async function tryStealth(): Promise<{
    txid: string;
    vout: number;
    prevOut: any;
    signPrivBytes: Uint8Array;
    source: 'stealth';
    record: StealthUtxoRecord;
  } | null> {
    if (!state) {
      dlog({ mode, stage: 'stealth', skipped: true, reason: 'no-state' });
      return null;
    }

    const st = ensurePoolStateDefaults(state);

    const tipHeight = !includeUnconfirmed && minConfirmations > 1 ? await getTipHeightMaybe() : undefined;

    const stealthRecs = (st?.stealthUtxos ?? [])
      .filter((r) => r && r.owner === ownerTag && !r.spentInTxid)
      .sort((a, b) => (toBigIntSats(b.valueSats ?? b.value ?? 0) > toBigIntSats(a.valueSats ?? a.value ?? 0) ? 1 : -1));

    dlog({ mode, stage: 'stealth', records: stealthRecs.length, minSats: minSats.toString() });

    for (const r of stealthRecs) {
      const unspent = await chainIO.isP2pkhOutpointUnspent({ txid: r.txid, vout: r.vout, hash160Hex: r.hash160Hex });
      if (!unspent) {
        stale.push({ source: 'stealth', txid: r.txid, vout: r.vout, reason: 'spent' });
        if (markStaleStealthRecords) markStealthSpent(st, r.txid, r.vout, '<spent>');
        continue;
      }

      const prev = await chainIO.getPrevOutput(r.txid, r.vout);

      if (!allowTokens && isTokenUtxo(prev)) {
        stale.push({ source: 'stealth', txid: r.txid, vout: r.vout, reason: 'token-utxo-excluded' });
        continue;
      }

      if (!confirmedEnough(prev, tipHeight)) {
        stale.push({ source: 'stealth', txid: r.txid, vout: r.vout, reason: 'unconfirmed' });
        continue;
      }

      const value = toBigIntSats(prev.value);
      if (value < minSats) {
        stale.push({ source: 'stealth', txid: r.txid, vout: r.vout, reason: 'below-min-sats' });
        continue;
      }

      const expectedH160 = parseP2pkhHash160(prev.scriptPubKey);
      if (!expectedH160 || bytesToHex(expectedH160) !== r.hash160Hex) {
        stale.push({ source: 'stealth', txid: r.txid, vout: r.vout, reason: 'prevout-mismatch' });
        continue;
      }

      const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
        wallet.scanPrivBytes ?? wallet.privBytes,
        wallet.spendPrivBytes ?? wallet.privBytes,
        hexToBytes(r.rpaContext.senderPub33Hex),
        r.rpaContext.prevoutHashHex,
        r.rpaContext.prevoutN,
        r.rpaContext.index
      );

      const { h160 } = pubkeyHashFromPriv(oneTimePriv);
      if (bytesToHex(h160) !== r.hash160Hex) {
        stale.push({ source: 'stealth', txid: r.txid, vout: r.vout, reason: 'derivation-mismatch' });
        continue;
      }

      return { txid: r.txid, vout: r.vout, prevOut: prev, signPrivBytes: oneTimePriv, source: 'stealth', record: r };
    }

    return null;
  }

  // --- base selection ---
  async function tryBase(): Promise<{
    txid: string;
    vout: number;
    prevOut: any;
    signPrivBytes: Uint8Array;
    source: 'base';
  } | null> {
    const tipHeight = !includeUnconfirmed && minConfirmations > 1 ? await getTipHeightMaybe() : undefined;

    // Probe both possible getUtxos signatures.
    // A) (address, network, includeUnconfirmed)  [preferred]
    // B) (address, includeUnconfirmed, network)  [legacy/caller mistake]
    let utxos: any[] = [];

    try {
      utxos = await getUtxos(wallet.address, network, includeUnconfirmed);
      dlog({ mode, stage: 'base', call: '(address, network, includeUnconfirmed)', count: utxos?.length ?? 0 });
    } catch (e) {
      dlog({ mode, stage: 'base', call: '(address, network, includeUnconfirmed)', error: errToString(e) });
    }

    if (!Array.isArray(utxos) || utxos.length === 0) {
      try {
        utxos = await getUtxos(wallet.address, includeUnconfirmed, network);
        dlog({ mode, stage: 'base', call: '(address, includeUnconfirmed, network)', count: utxos?.length ?? 0 });
      } catch (e) {
        dlog({ mode, stage: 'base', call: '(address, includeUnconfirmed, network)', error: errToString(e) });
      }
    }

    const candidates = (utxos ?? [])
      .filter((u) => u && (allowTokens ? true : !u.token_data && !isTokenUtxo(u)))
      .filter((u) => confirmedEnough(u, tipHeight))
      .filter((u) => toValueSats(u) >= minSats);

    dlog({
      mode,
      stage: 'base',
      fetched: Array.isArray(utxos) ? utxos.length : 0,
      candidates: candidates.length,
      minSats: minSats.toString(),
      minConfirmations,
      includeUnconfirmed,
      allowTokens,
    });

    const best = pickLargest(candidates);
    if (!best) return null;

    const prev = await chainIO.getPrevOutput(best.txid, best.vout);

    if (!allowTokens && isTokenUtxo(prev)) {
      stale.push({ source: 'base', txid: best.txid, vout: best.vout, reason: 'token-utxo-excluded' });
      return null;
    }

    if (!confirmedEnough(prev, tipHeight)) {
      stale.push({ source: 'base', txid: best.txid, vout: best.vout, reason: 'unconfirmed' });
      return null;
    }

    const value = toBigIntSats(prev.value);
    if (value < minSats) return null;

    if (!parseP2pkhHash160(prev.scriptPubKey)) return null;

    return { txid: best.txid, vout: best.vout, prevOut: prev, signPrivBytes: wallet.privBytes, source: 'base' };
  }

  dlog({ mode, prefer, ownerTag, network });

  // Preference pipeline (wallet-first by default)
  for (const src of prefer) {
    if (src === 'base') {
      const hit = await tryBase();
      if (hit) return { ...hit, stale: stale.length ? stale : undefined };
    } else if (src === 'stealth') {
      const hit = await tryStealth();
      if (hit) return { ...hit, stale: stale.length ? stale : undefined };
    }
  }

  throw new Error(
    `No funding UTXO available for ${ownerTag}. Fund ${wallet.address} on chipnet. (mode=${mode}, prefer=${prefer.join(
      ','
    )})`
  );
}