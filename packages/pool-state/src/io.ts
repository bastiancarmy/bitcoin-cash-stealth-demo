import path from 'node:path';
import fsSync from 'node:fs';

import type { PoolState } from './state.js';
import { ensurePoolStateDefaults } from './helpers.js';
import { FileBackedPoolStateStore } from './filestore.js';

// Canonical key (v1)
export const POOL_STATE_STORE_KEY = 'pool.state';

export const DEFAULT_STATE_DIRNAME = '.bch-stealth';
export const DEFAULT_STATE_FILENAME = 'state.json';

function ensureDirForFileSync(filename: string) {
  const dir = path.dirname(filename);
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
}

export function resolveDefaultPoolStatePaths(repoRoot: string) {
  const stateDir = path.join(repoRoot, DEFAULT_STATE_DIRNAME);
  const storeFile = path.join(stateDir, DEFAULT_STATE_FILENAME);
  return { stateDir, storeFile };
}

export async function readPoolState(args: {
  store: FileBackedPoolStateStore;
  networkDefault?: string;
}): Promise<PoolState | null> {
  const { store, networkDefault } = args;

  ensureDirForFileSync(store.filename);
  await store.load();

  const cur = store.get<any>(POOL_STATE_STORE_KEY);
  if (!cur) return null;

  return ensurePoolStateDefaults(cur, networkDefault);
}

export async function writePoolState(args: {
  store: FileBackedPoolStateStore;
  state: PoolState;
  networkDefault?: string;
}): Promise<void> {
  const { store, state, networkDefault } = args;

  ensureDirForFileSync(store.filename);
  await store.load();

  store.set(POOL_STATE_STORE_KEY, ensurePoolStateDefaults(state, networkDefault));
  await store.flush();
}