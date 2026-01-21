// packages/pool-state/src/helpers.ts
import type { PoolState, DepositRecord, StealthUtxoRecord, ShardPointer, CovenantSignerIdentity } from './state.js';

function normalizeShardPointer(s: any, fallbackIndex: number): ShardPointer {
  const index = typeof s?.index === 'number' ? s.index : fallbackIndex;

  // legacy shard pointers used `value` instead of `valueSats`
  const valueSats =
    typeof s?.valueSats === 'string'
      ? s.valueSats
      : typeof s?.value === 'string'
        ? s.value
        : '0';

  return {
    index,
    txid: String(s?.txid ?? ''),
    vout: Number(s?.vout ?? 0),
    valueSats,
    commitmentHex: String(s?.commitmentHex ?? ''),
  };
}

function normalizeDeposit(d: any): DepositRecord {
  const valueSats =
    typeof d?.valueSats === 'string'
      ? d.valueSats
      : typeof d?.value === 'string'
        ? d.value
        : '0';

  return {
    ...d,
    txid: String(d?.txid ?? ''),
    vout: Number(d?.vout ?? 0),
    valueSats,
    // keep legacy field if it exists (but canonical is valueSats)
    value: typeof d?.value === 'string' ? d.value : undefined,
    receiverRpaHash160Hex: String(d?.receiverRpaHash160Hex ?? ''),
    createdAt: String(d?.createdAt ?? new Date().toISOString()),
    rpaContext: d?.rpaContext,
  } as DepositRecord;
}

function normalizeStealthUtxo(r: any): StealthUtxoRecord {
  const valueSats =
    typeof r?.valueSats === 'string'
      ? r.valueSats
      : typeof r?.value === 'string'
        ? r.value
        : '0';

  return {
    ...r,
    txid: String(r?.txid ?? ''),
    vout: Number(r?.vout ?? 0),
    valueSats,
    value: typeof r?.value === 'string' ? r.value : undefined,
    hash160Hex: String(r?.hash160Hex ?? ''),
    createdAt: String(r?.createdAt ?? new Date().toISOString()),
    rpaContext: r?.rpaContext,
    owner: String(r?.owner ?? ''),
    purpose: String(r?.purpose ?? ''),
  } as StealthUtxoRecord;
}

function normalizeCovenantSigner(x: any): CovenantSignerIdentity | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const actorId = typeof x.actorId === 'string' ? x.actorId : '';
  const pubkeyHash160Hex = typeof x.pubkeyHash160Hex === 'string' ? x.pubkeyHash160Hex : '';
  if (!actorId || !pubkeyHash160Hex) return undefined;
  return { actorId, pubkeyHash160Hex };
}

/**
 * Ensure a PoolState is in canonical v1 shape.
 * - Idempotent: safe to call multiple times.
 * - Tolerant: keeps extra legacy fields without deleting them.
 */
export function ensurePoolStateDefaults(state?: PoolState | any | null, networkDefault?: string): PoolState {
  const st: any = (state ?? {}) as any;

  // canonical schemaVersion
  if (st.schemaVersion !== 1) st.schemaVersion = 1;

  // covenantSigner (additive)
  // - keep if present
  // - if malformed, drop to undefined
  if ('covenantSigner' in st) {
    st.covenantSigner = normalizeCovenantSigner(st.covenantSigner);
  }

  // network defaulting
  const net = networkDefault ?? st.network;
  if (net) st.network = st.network ?? net;
  if (!st.network) st.network = networkDefault ?? 'chipnet';

  // Required-ish canonical fields (keep tolerant; migrations should set these)
  st.poolIdHex = st.poolIdHex ?? 'unknown';
  st.poolVersion = st.poolVersion ?? 'unknown';
  st.categoryHex = st.categoryHex ?? st.categoryHex ?? '';
  st.redeemScriptHex = st.redeemScriptHex ?? st.redeemScriptHex ?? '';

  // shards: normalize pointers + compute shardCount
  const shardsIn = Array.isArray(st.shards) ? st.shards : [];
  st.shards = shardsIn.map((s: any, i: number) => normalizeShardPointer(s, i));
  st.shardCount =
    typeof st.shardCount === 'number' && Number.isFinite(st.shardCount)
      ? st.shardCount
      : st.shards.length;

  // optional history arrays (default empty arrays, but keep optional on the object)
  const stealthIn = Array.isArray(st.stealthUtxos) ? st.stealthUtxos : [];
  const depositsIn = Array.isArray(st.deposits) ? st.deposits : [];
  const withdrawalsIn = Array.isArray(st.withdrawals) ? st.withdrawals : [];

  st.stealthUtxos = stealthIn.map(normalizeStealthUtxo);
  st.deposits = depositsIn.map(normalizeDeposit);
  st.withdrawals = withdrawalsIn;

  return st as PoolState;
}

export function upsertDeposit(state: PoolState, dep: DepositRecord): void {
  const st = ensurePoolStateDefaults(state);

  // normalize input record too
  const normalized = ensurePoolStateDefaults({
    ...st,
    deposits: [dep],
  } as any).deposits?.[0] as DepositRecord;

  const deps = st.deposits ?? (st.deposits = []);
  const i = deps.findIndex((d) => d.txid === normalized.txid && d.vout === normalized.vout);
  if (i >= 0) deps[i] = { ...deps[i], ...normalized };
  else deps.push(normalized);
}

export function getLatestUnimportedDeposit(state: PoolState, amountSats: number | null): DepositRecord | null {
  const st = ensurePoolStateDefaults(state);
  const deps = Array.isArray(st?.deposits) ? st.deposits! : [];
  for (let i = deps.length - 1; i >= 0; i--) {
    const d = deps[i];
    if (!d) continue;
    if (d.importTxid) continue;
    if (amountSats != null && Number(d.valueSats ?? d.value) !== Number(amountSats)) continue;
    return d;
  }
  return null;
}

export function upsertStealthUtxo(state: PoolState, rec: StealthUtxoRecord): void {
  const st = ensurePoolStateDefaults(state);

  // normalize input record too
  const normalized = ensurePoolStateDefaults({
    ...st,
    stealthUtxos: [rec],
  } as any).stealthUtxos?.[0] as StealthUtxoRecord;

  const list = st.stealthUtxos ?? (st.stealthUtxos = []);
  const key = `${normalized.txid}:${normalized.vout}`;
  const idx = list.findIndex((r) => r && `${r.txid}:${r.vout}` === key);
  if (idx >= 0) list[idx] = { ...list[idx], ...normalized };
  else list.push(normalized);
}

export function markStealthSpent(state: PoolState, txid: string, vout: number, spentInTxid: string): void {
  const st = ensurePoolStateDefaults(state);
  const list = st.stealthUtxos ?? (st.stealthUtxos = []);

  const key = `${txid}:${vout}`;
  const idx = list.findIndex((r) => r && `${r.txid}:${r.vout}` === key);
  if (idx >= 0) {
    list[idx] = {
      ...list[idx],
      spentInTxid,
      spentAt: new Date().toISOString(),
    };
  }
}