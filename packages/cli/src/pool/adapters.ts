// packages/cli/src/pool/adapters.ts
import type { PoolState } from '@bch-stealth/pool-state';
import type * as PoolShards from '@bch-stealth/pool-shards';

export function normalizeValueSats(rec: any): string {
  // pool-state v1 uses valueSats; legacy had value
  const v = rec?.valueSats ?? rec?.value ?? '0';
  return String(v);
}

export function toPoolShardsState(state: PoolState, networkDefault: string): PoolShards.PoolState {
  const st: any = state as any;

  if (!st.categoryHex || !st.redeemScriptHex) {
    throw new Error('toPoolShardsState: state missing categoryHex/redeemScriptHex');
  }

  const shards: any[] = Array.isArray(st.shards) ? st.shards : [];

  return {
    poolIdHex: String(st.poolIdHex ?? 'unknown'),
    poolVersion: String(st.poolVersion ?? 'unknown'),
    shardCount: Number(st.shardCount ?? shards.length ?? 0),
    network: String(st.network ?? networkDefault),
    categoryHex: String(st.categoryHex),
    redeemScriptHex: String(st.redeemScriptHex),
    shards: shards.map((s: any, i: number) => ({
      index: Number(s?.index ?? i),
      txid: String(s?.txid ?? ''),
      vout: Number(s?.vout ?? 0),
      valueSats: normalizeValueSats(s),
      commitmentHex: String(s?.commitmentHex ?? ''),
    })),
  };
}

/**
 * After broadcasting a shard-tx, patch the CLI pool-state shard pointer using the builder's nextPoolState.
 * Assumes shard output is vout=0 for import/withdraw updates (matches builder convention).
 */
export function patchShardFromNextPoolState(args: {
  poolState: PoolState;
  shardIndex: number;
  txid: string;
  nextPool: PoolShards.PoolState;
}): void {
  const { poolState, shardIndex, txid, nextPool } = args;

  const newShard = nextPool.shards[shardIndex];
  if (!newShard) throw new Error(`patchShardFromNextPoolState: missing shard ${shardIndex} in nextPoolState`);

  const st: any = poolState as any;
  st.shards ??= [];

  const prev = st.shards[shardIndex] ?? {};

  const valueSats = String((newShard as any).valueSats ?? '0');
  const commitmentHex = String((newShard as any).commitmentHex ?? '');

  st.shards[shardIndex] = {
    ...prev,
    index: prev.index ?? shardIndex,
    txid,
    vout: 0,
    valueSats,
    // optional legacy compat field (harmless; remove later if you want strict v1 only)
    value: prev.value ?? valueSats,
    commitmentHex,
  };
}