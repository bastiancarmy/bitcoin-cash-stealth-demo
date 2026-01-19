// packages/pool-state/src/legacy.ts
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
  [k: string]: unknown;
};

function normalizePoolVersion(v: string): string {
  if (v === 'v1') return 'v1';
  if (v === 'v1_1' || v === 'v1.1') return 'v1.1';
  return String(v);
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
    schemaVersion: 1 as const,

    poolIdHex: (legacy as any).poolIdHex ?? 'unknown',
    poolVersion: normalizePoolVersion(String(legacy.poolVersion)),
    shardCount: legacy.shards.length,
    network: String(legacy.network ?? 'chipnet'),

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

  store.set('pool.state', poolState);
  store.set('pool.legacy', legacy);

  if (legacy.deposits) store.set('pool.deposits', legacy.deposits);
  if (legacy.withdrawals) store.set('pool.withdrawals', legacy.withdrawals);
  if (legacy.stealthUtxos) store.set('stealth.utxos', legacy.stealthUtxos);
  if (legacy.txid) store.set('pool.meta.lastTxid', legacy.txid);

  await store.flush();
  return { imported: true };
}