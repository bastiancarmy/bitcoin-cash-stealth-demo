// packages/cli/src/pool/state.ts
import type { PoolState } from '@bch-stealth/pool-state';
import type { FileBackedPoolStateStore } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults } from '@bch-stealth/pool-state';
import { readPoolState, writePoolState } from '@bch-stealth/pool-state';

export function emptyPoolState(): PoolState {
  // Minimal empty v1 shape; ensurePoolStateDefaults will fill defaults when saving/loading.
  return ensurePoolStateDefaults({
    schemaVersion: 1,
    network: '',
    poolIdHex: '',
    poolVersion: '',
    categoryHex: '',
    redeemScriptHex: '',
    shardCount: 0,
    shards: [],
    deposits: [],
    withdrawals: [],
    stealthUtxos: [],
  } as any);
}

export async function loadStateOrEmpty(args: {
  store: FileBackedPoolStateStore;
  networkDefault: string;
}): Promise<PoolState> {
  const { store, networkDefault } = args;

  const st = (await readPoolState({ store, networkDefault })) ?? emptyPoolState();
  // Persist forward-migrations (idempotent)
  await writePoolState({ store, state: st, networkDefault });
  return ensurePoolStateDefaults(st, networkDefault);
}

export async function saveState(args: {
  store: FileBackedPoolStateStore;
  state: PoolState;
  networkDefault: string;
}): Promise<void> {
  const { store, state, networkDefault } = args;
  await writePoolState({ store, state, networkDefault });
}