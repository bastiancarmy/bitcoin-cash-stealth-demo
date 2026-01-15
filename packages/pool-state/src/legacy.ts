// demo-state/src/legacy.ts
import { promises as fs } from 'node:fs';
import type { PoolStateStore } from './types.js';

type LegacyShard = {
  index?: number;
  txid: string;
  vout: number;
  value: string;
  commitmentHex: string;
};

type LegacyFile = {
  network: string;
  txid?: string;
  categoryHex: string;
  poolVersion: 'v1' | 'v1_1' | string;
  redeemScriptHex: string;
  shards: LegacyShard[];
  deposits?: unknown[];
  withdrawals?: unknown[];
  stealthUtxos?: unknown[];
  [k: string]: unknown; // keep everything
};

function normalizePoolVersion(v: string): 'v1' | 'v1.1' {
  if (v === 'v1') return 'v1';
  if (v === 'v1_1' || v === 'v1.1') return 'v1.1';
  // fall back to v1.1 for demo; or throw if you prefer strictness
  return 'v1.1';
}

/**
 * Import legacy sharded_pool_state.json into the new PoolStateStore.
 * Safe to call multiple times: only imports if pool.state is missing.
 */
export async function importLegacyShardedPoolState(opts: {
  store: PoolStateStore;
  legacyFilename: string;
}): Promise<{ imported: boolean }> {
  const { store, legacyFilename } = opts;

  const existing = store.get('pool.state');
  if (existing) return { imported: false };

  const raw = await fs.readFile(legacyFilename, 'utf8');
  const legacy = JSON.parse(raw) as LegacyFile;

  const poolState = {
    poolIdHex: (legacy as any).poolIdHex ?? 'unknown', // if present in other variants
    poolVersion: normalizePoolVersion(String(legacy.poolVersion)),
    shardCount: legacy.shards.length,
    network: legacy.network === 'chipnet' ? 'chipnet' : 'chipnet', // demo default
    categoryHex: legacy.categoryHex,
    redeemScriptHex: legacy.redeemScriptHex,
    shards: legacy.shards.map((s, i) => ({
      index: s.index ?? i,
      txid: s.txid,
      vout: s.vout,
      valueSats: s.value,
      commitmentHex: s.commitmentHex,
    })),
  };

  // Write canonical state
  store.set('pool.state', poolState);

  // Preserve the full legacy object too (lossless archive)
  store.set('pool.legacy', legacy);

  // Preserve common arrays where the CLI might still use them
  if (legacy.deposits) store.set('pool.deposits', legacy.deposits);
  if (legacy.withdrawals) store.set('pool.withdrawals', legacy.withdrawals);
  if (legacy.stealthUtxos) store.set('stealth.utxos', legacy.stealthUtxos);

  // Preserve legacy "txid" as metadata (so nothing disappears)
  if (legacy.txid) store.set('pool.meta.lastTxid', legacy.txid);

  await store.flush();
  return { imported: true };
}