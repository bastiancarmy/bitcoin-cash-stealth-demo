// packages/cli/src/pool/state.ts
import type { FileBackedPoolStateStore, PoolState } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, readPoolState, writePoolState } from '@bch-stealth/pool-state';

export function emptyPoolState(network: string): PoolState {
  return ensurePoolStateDefaults(
    {
      schemaVersion: 1,
      network,
      poolIdHex: 'unknown',
      poolVersion: 'unknown',
      categoryHex: '',
      redeemScriptHex: '',
      shardCount: 0,
      shards: [],
      stealthUtxos: [],
      deposits: [],
      withdrawals: [],
      createdAt: new Date().toISOString(),
    } as any,
    network
  );
}

/**
 * Reads state, applies defaults, and persists any migrations immediately.
 * (So callers can assume the store is always “up to date” after load.)
 */
export async function loadStateOrEmpty(args: {
  store: FileBackedPoolStateStore;
  network: string;
}): Promise<PoolState> {
  const { store, network } = args;

  const st = (await readPoolState({ store, networkDefault: network })) ?? emptyPoolState(network);
  const state = ensurePoolStateDefaults(st, network);

  // persist migrations/defaults once on load
  await writePoolState({ store, state, networkDefault: network });

  return state;
}

export async function saveState(args: {
  store: FileBackedPoolStateStore;
  state: PoolState;
  network: string;
}): Promise<void> {
  const { store, state, network } = args;
  await writePoolState({ store, state: ensurePoolStateDefaults(state, network), networkDefault: network });
}