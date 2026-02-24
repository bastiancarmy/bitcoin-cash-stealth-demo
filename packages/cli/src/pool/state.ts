// packages/cli/src/pool/state.ts

import type { PoolState, PoolStateStore, StealthUtxoRecord, FileBackedPoolStateStore } from '@bch-stealth/pool-state';
import type { WalletLike } from './context.js';

import {
  POOL_STATE_STORE_KEY,
  ensurePoolStateDefaults,
  readPoolState,
  upsertStealthUtxo,
} from '@bch-stealth/pool-state';

import { bytesToHex, hexToBytes } from '@bch-stealth/utils';
import { deriveRpaOneTimePrivReceiver } from '@bch-stealth/rpa';
import { pubkeyHashFromPriv } from '../utils.js';
import { normalizeWalletKeys, debugPrintKeyFlags } from '../wallet/normalizeKeys.js';

// -------------------------------------------------------------------------------------
// Canonicalization helpers
// -------------------------------------------------------------------------------------

const LEGACY_STEALTH_KEYS = [
  'stealth.utxos',
  'stealthUtxos',
] as const;

function isLikelyTxid(x: unknown): x is string {
  return typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x);
}

function toOutpointKey(txid: unknown, vout: unknown): string | null {
  if (!isLikelyTxid(txid)) return null;
  const n = Number(vout);
  if (!Number.isFinite(n) || n < 0) return null;
  return `${txid.toLowerCase()}:${n}`;
}

function mergeLegacyStealthUtxosIntoPoolState(args: {
  store: PoolStateStore;
  poolState: PoolState;
}): { mergedCount: number; sources: Record<string, number> } {
  const { store } = args;
  const st = ensurePoolStateDefaults(args.poolState);

  st.stealthUtxos ??= [];

  const have = new Set<string>();
  for (const r of st.stealthUtxos) {
    const k = toOutpointKey((r as any)?.txid, (r as any)?.vout);
    if (k) have.add(k);
  }

  let mergedCount = 0;
  const sources: Record<string, number> = {};

  for (const key of LEGACY_STEALTH_KEYS) {
    const legacy = store.get<any>(key);
    if (!Array.isArray(legacy) || legacy.length === 0) continue;

    let fromThisKey = 0;

    for (const rec of legacy) {
      const k = toOutpointKey(rec?.txid, rec?.vout);
      if (!k) continue;
      if (have.has(k)) continue;

      try {
        upsertStealthUtxo(st, rec);
        have.add(k);
        mergedCount++;
        fromThisKey++;
      } catch {
        // ignore malformed legacy entries
      }
    }

    if (fromThisKey > 0) sources[key] = fromThisKey;
  }

  return { mergedCount, sources };
}

function deleteLegacyStealthKeys(store: PoolStateStore): void {
  for (const key of LEGACY_STEALTH_KEYS) store.delete(key);
}

export function emptyPoolState(networkDefault: string = 'chipnet'): PoolState {
  return ensurePoolStateDefaults({
    schemaVersion: 1,
    network: networkDefault,
    createdAt: new Date().toISOString(),
  } as any);
}

export async function loadStateOrEmpty(args: {
  store: FileBackedPoolStateStore;
  networkDefault: string;
}): Promise<PoolState> {
  const { store, networkDefault } = args;

  const st0 = await readPoolState({ store, networkDefault });
  const st = ensurePoolStateDefaults(st0 ?? emptyPoolState(networkDefault));

  mergeLegacyStealthUtxosIntoPoolState({ store, poolState: st });

  return ensurePoolStateDefaults(st);
}

export async function saveState(args: {
  store: FileBackedPoolStateStore;
  state: PoolState;
  networkDefault: string;
}): Promise<void> {
  const { store, state, networkDefault } = args;

  const st = ensurePoolStateDefaults(state, networkDefault);

  await store.load();
  store.set(POOL_STATE_STORE_KEY, ensurePoolStateDefaults(st, networkDefault));
  deleteLegacyStealthKeys(store);
  await store.flush();
}

// -------------------------------------------------------------------------------------
// Funding selection helper
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
  prefer?: Array<'base' | 'stealth'>;

  // NEW: some operations (pool init) must spend a vout=0 outpoint (CashTokens category genesis)
  requireVout0?: boolean;

  minConfirmations?: number;
  includeUnconfirmed?: boolean;
  markStaleStealthRecords?: boolean;
  allowTokens?: boolean;

  state?: PoolState | null;
  wallet: WalletLike;
  ownerTag: string;

  minSats?: bigint;

  chainIO: {
    isP2pkhOutpointUnspent: (o: { txid: string; vout: number; hash160Hex: string }) => Promise<boolean>;
    getPrevOutput: (txid: string, vout: number) => Promise<any>;
    getTipHeight?: () => Promise<number>;
  };

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
    minConfirmations = 0,
    includeUnconfirmed = true,
    markStaleStealthRecords = false,
    allowTokens = false,
    requireVout0 = false,
    state,
    wallet,
    ownerTag,
    minSats = args.dustSats,
    chainIO,
    getUtxos,
    network,
  } = args;

  const preferEnv = String(process.env.BCH_STEALTH_FUNDING_PREFER ?? '').trim().toLowerCase();
  const prefer =
    preferEnv === 'stealth-first'
      ? (['stealth', 'base'] as const)
      : preferEnv === 'base-first'
        ? (['base', 'stealth'] as const)
        : (args.prefer ?? (['base', 'stealth'] as const));

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

  function isLocallySpentStealth(r: any): boolean {
    return Boolean(
      r?.spent === true ||
        (typeof r?.spentInTxid === 'string' && r.spentInTxid.trim()) ||
        (typeof r?.spentByTxid === 'string' && r.spentByTxid.trim()) ||
        (typeof r?.spentAt === 'string' && r.spentAt.trim())
    );
  }

  function markStealthSpentCompat(st: any, txid: string, vout: number, spentByTxid: string) {
    const recs = st?.stealthUtxos ?? [];
    for (const r of recs) {
      if (!r) continue;
      if (String(r.txid) === String(txid) && Number(r.vout) === Number(vout)) {
        (r as any).spent = true;
        (r as any).spentAt = new Date().toISOString();
        (r as any).spentByTxid = String(spentByTxid);
        (r as any).spentInTxid = String(spentByTxid);
        return true;
      }
    }
    return false;
  }

  // --- stealth selection ---
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

    let nk: ReturnType<typeof normalizeWalletKeys> | null = null;
    try {
      nk = normalizeWalletKeys(wallet);
    } catch {
      dlog({ mode, stage: 'stealth', skipped: true, reason: 'missing/invalid wallet keys' });
      return null;
    }

    debugPrintKeyFlags('funding', nk.flags);

    const scanPriv32 = nk.scanPriv32;
    const spendPriv32 = nk.spendPriv32;

    const tipHeight = !includeUnconfirmed && minConfirmations > 1 ? await getTipHeightMaybe() : undefined;

    const stealthRecs = (st?.stealthUtxos ?? [])
      .filter((r) => r && r.owner === ownerTag)
      .filter((r) => !isLocallySpentStealth(r))
      .filter((r) => (requireVout0 ? Number((r as any)?.vout ?? -1) === 0 : true)) // NEW
      .sort((a, b) =>
        toBigIntSats((b as any).valueSats ?? (b as any).value ?? 0) > toBigIntSats((a as any).valueSats ?? (a as any).value ?? 0)
          ? 1
          : -1
      );

    dlog({
      mode,
      stage: 'stealth',
      records: stealthRecs.length,
      minSats: minSats.toString(),
      requireVout0,
    });

    function rejectStealth(r: StealthUtxoRecord, reason: string, extra?: any) {
      stale.push({ source: 'stealth', txid: r.txid, vout: r.vout, reason });
      dlog({
        mode,
        stage: 'stealth',
        reject: { outpoint: `${r.txid}:${r.vout}`, reason, valueSats: (r as any).valueSats, hash160Hex: (r as any).hash160Hex },
        ...(extra ? { extra } : {}),
      });
    }

    for (const r of stealthRecs) {
      // require vout=0 at selection time (defense in depth)
      if (requireVout0 && Number(r.vout) !== 0) {
        rejectStealth(r, 'require-vout0');
        continue;
      }

      const unspent = await chainIO.isP2pkhOutpointUnspent({
        txid: r.txid,
        vout: r.vout,
        hash160Hex: (r as any).hash160Hex,
      });
      if (!unspent) {
        rejectStealth(r, 'spent');
        if (markStaleStealthRecords) markStealthSpentCompat(st, r.txid, r.vout, '<spent>');
        continue;
      }

      const prev = await chainIO.getPrevOutput(r.txid, r.vout);

      if (!allowTokens && isTokenUtxo(prev)) {
        rejectStealth(r, 'token-utxo-excluded');
        continue;
      }

      if (!confirmedEnough(prev, tipHeight)) {
        rejectStealth(r, 'unconfirmed', { tipHeight, minConfirmations, includeUnconfirmed });
        continue;
      }

      const value = toBigIntSats(prev.value);
      if (value < minSats) {
        rejectStealth(r, 'below-min-sats', { value: value.toString(), minSats: minSats.toString() });
        continue;
      }

      const expectedH160 = parseP2pkhHash160(prev.scriptPubKey);
      if (!expectedH160 || bytesToHex(expectedH160) !== (r as any).hash160Hex) {
        rejectStealth(r, 'prevout-mismatch', {
          expected: expectedH160 ? bytesToHex(expectedH160) : null,
          record: (r as any).hash160Hex,
        });
        continue;
      }

      const ctxAny: any = (r as any)?.rpaContext;
      const senderPub33Hex = String(ctxAny?.senderPub33Hex ?? '').trim();
      const prevoutHashHex = String(ctxAny?.prevoutHashHex ?? ctxAny?.prevoutTxidHex ?? '').trim();
      const prevoutN = Number(ctxAny?.prevoutN);
      const index = Number(ctxAny?.index);

      if (!/^[0-9a-fA-F]{66}$/.test(senderPub33Hex)) {
        rejectStealth(r, 'missing-rpaContext.senderPub33Hex', { senderPub33Hex });
        continue;
      }
      if (!/^[0-9a-fA-F]{64}$/.test(prevoutHashHex)) {
        rejectStealth(r, 'missing-rpaContext.prevoutHashHex', { prevoutHashHex });
        continue;
      }
      if (!Number.isFinite(prevoutN) || prevoutN < 0) {
        rejectStealth(r, 'missing-rpaContext.prevoutN', { prevoutN });
        continue;
      }
      if (!Number.isFinite(index) || index < 0) {
        rejectStealth(r, 'missing-rpaContext.index', { index });
        continue;
      }

      const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
        scanPriv32,
        spendPriv32,
        hexToBytes(senderPub33Hex),
        prevoutHashHex.toLowerCase(),
        prevoutN,
        index
      );

      const { h160 } = pubkeyHashFromPriv(oneTimePriv);
      if (bytesToHex(h160) !== (r as any).hash160Hex) {
        rejectStealth(r, 'derivation-mismatch', { derived: bytesToHex(h160), record: (r as any).hash160Hex });
        continue;
      }

      return {
        txid: r.txid,
        vout: r.vout,
        prevOut: prev,
        signPrivBytes: oneTimePriv,
        source: 'stealth',
        record: r,
      };
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
      .filter((u) => toValueSats(u) >= minSats)
      .filter((u) => (requireVout0 ? Number(u?.vout ?? -1) === 0 : true)) // NEW (best-effort for getUtxos shape)
      .sort((a, b) => (toValueSats(b) > toValueSats(a) ? 1 : -1));

    dlog({
      mode,
      stage: 'base',
      fetched: Array.isArray(utxos) ? utxos.length : 0,
      candidates: candidates.length,
      minSats: minSats.toString(),
      minConfirmations,
      includeUnconfirmed,
      allowTokens,
      requireVout0,
    });

    for (const cand of candidates) {
      // enforce vout=0 even if getUtxos uses different field names
      const candVout = Number((cand as any)?.vout ?? (cand as any)?.tx_pos ?? -1);
      if (requireVout0 && candVout !== 0) {
        stale.push({ source: 'base', txid: cand.txid, vout: candVout, reason: 'require-vout0' });
        continue;
      }

      const prev = await chainIO.getPrevOutput(cand.txid, candVout);

      if (!allowTokens && isTokenUtxo(prev)) {
        stale.push({ source: 'base', txid: cand.txid, vout: candVout, reason: 'token-utxo-excluded' });
        continue;
      }

      if (!confirmedEnough(prev, tipHeight)) {
        stale.push({ source: 'base', txid: cand.txid, vout: candVout, reason: 'unconfirmed' });
        continue;
      }

      const value = toBigIntSats(prev.value);
      if (value < minSats) {
        stale.push({ source: 'base', txid: cand.txid, vout: candVout, reason: 'below-min-sats' });
        continue;
      }

      const h160 = parseP2pkhHash160(prev.scriptPubKey);
      if (!h160) {
        stale.push({ source: 'base', txid: cand.txid, vout: candVout, reason: 'non-p2pkh' });
        continue;
      }

      const unspent = await chainIO.isP2pkhOutpointUnspent({
        txid: cand.txid,
        vout: candVout,
        hash160Hex: bytesToHex(h160),
      });

      if (!unspent) {
        stale.push({ source: 'base', txid: cand.txid, vout: candVout, reason: 'spent' });
        continue;
      }

      return { txid: cand.txid, vout: candVout, prevOut: prev, signPrivBytes: wallet.privBytes, source: 'base' };
    }

    return null;
  }

  dlog({ mode, prefer, ownerTag, network, requireVout0 });

  for (const src of prefer) {
    if (src === 'base') {
      const hit = await tryBase();
      if (hit) return { ...hit, stale: stale.length ? stale : undefined };
    } else if (src === 'stealth') {
      const hit = await tryStealth();
      if (hit) return { ...hit, stale: stale.length ? stale : undefined };
    }
  }

  if (dbg && stale.length) {
    console.log(`[funding] stale: ${JSON.stringify(stale, null, 2)}`);
  }

  const hint = requireVout0
    ? `\nTip: pool init requires a funding outpoint at vout=0. Create a self-send where the intended funding output is vout=0, then re-run.`
    : '';

  throw new Error(
    `No funding UTXO available for ${ownerTag}. Fund ${wallet.address} on chipnet. (mode=${mode}, prefer=${prefer.join(',')})` +
      hint
  );
}