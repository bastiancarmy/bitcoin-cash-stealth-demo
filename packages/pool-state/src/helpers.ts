import type { PoolState, DepositRecord, StealthUtxoRecord } from './state.js';

export function ensurePoolStateDefaults(state?: PoolState | null, networkDefault?: string): PoolState {
  const st = (state ?? {}) as PoolState;

  const net = networkDefault ?? st.network;
  if (net) st.network = st.network ?? net;

  st.shards = Array.isArray(st.shards) ? st.shards : [];
  st.stealthUtxos = Array.isArray(st.stealthUtxos) ? st.stealthUtxos : [];
  st.deposits = Array.isArray(st.deposits) ? st.deposits : [];
  st.withdrawals = Array.isArray(st.withdrawals) ? st.withdrawals : [];

  return st;
}

export function upsertDeposit(state: PoolState, dep: DepositRecord): void {
  const st = ensurePoolStateDefaults(state);
  const i = st.deposits.findIndex((d) => d.txid === dep.txid && d.vout === dep.vout);
  if (i >= 0) st.deposits[i] = { ...st.deposits[i], ...dep };
  else st.deposits.push(dep);
}

export function getLatestUnimportedDeposit(state: PoolState, amountSats: number | null): DepositRecord | null {
  const st = ensurePoolStateDefaults(state);
  const deps = Array.isArray(st?.deposits) ? st.deposits : [];
  for (let i = deps.length - 1; i >= 0; i--) {
    const d = deps[i];
    if (!d) continue;
    if (d.importTxid) continue;
    if (amountSats != null && Number(d.value) !== Number(amountSats)) continue;
    return d;
  }
  return null;
}

export function upsertStealthUtxo(state: PoolState, rec: StealthUtxoRecord): void {
  const st = ensurePoolStateDefaults(state);
  const key = `${rec.txid}:${rec.vout}`;
  const idx = st.stealthUtxos.findIndex((r) => r && `${r.txid}:${r.vout}` === key);
  if (idx >= 0) st.stealthUtxos[idx] = { ...st.stealthUtxos[idx], ...rec };
  else st.stealthUtxos.push(rec);
}

export function markStealthSpent(state: PoolState, txid: string, vout: number, spentInTxid: string): void {
  const st = ensurePoolStateDefaults(state);
  const key = `${txid}:${vout}`;
  const idx = st.stealthUtxos.findIndex((r) => r && `${r.txid}:${r.vout}` === key);
  if (idx >= 0) {
    st.stealthUtxos[idx] = {
      ...st.stealthUtxos[idx],
      spentInTxid,
      spentAt: new Date().toISOString(),
    };
  }
}