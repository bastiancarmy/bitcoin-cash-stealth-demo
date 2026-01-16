import path from 'node:path';
import fsSync from 'node:fs';

import type { PoolState } from './state.js';
import { ensurePoolStateDefaults } from './helpers.js';
import { FileBackedPoolStateStore } from './filestore.js'; // or wherever this class lives in your package

export const POOL_STATE_STORE_KEY = 'pool.shardedPool';
export const LEGACY_POOL_STATE_STORE_KEY = 'demo.shardedPool';

export const DEFAULT_STATE_DIRNAME = '.bch-stealth';
export const DEFAULT_STATE_FILENAME = 'state.json';


function ensureDirForFileSync(filename: string) {
  const dir = path.dirname(filename);
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true });
}

export function resolveDefaultPoolStatePaths(repoRoot: string) {
  const stateDir = path.join(repoRoot, DEFAULT_STATE_DIRNAME);
  const storeFile = path.join(stateDir, DEFAULT_STATE_FILENAME);

  // legacy dirs
  const legacyDotDir = path.join(repoRoot, '.demo-state');
  const legacyDir = path.join(repoRoot, 'demo_state');

  return { stateDir, storeFile, legacyDotDir, legacyDir };
}

export function migrateLegacyPoolStateDirSync(args: {
  repoRoot: string;
  optedStateFile?: string | null;
}): void {
  const { repoRoot, optedStateFile } = args;
  if (optedStateFile) return;

  const { stateDir, legacyDotDir, legacyDir } = resolveDefaultPoolStatePaths(repoRoot);

  if (fsSync.existsSync(stateDir)) return;

  if (fsSync.existsSync(legacyDotDir)) {
    fsSync.renameSync(legacyDotDir, stateDir);
    return;
  }

  if (fsSync.existsSync(legacyDir)) {
    fsSync.renameSync(legacyDir, stateDir);
    return;
  }
}

export async function readPoolState(args: {
  store: FileBackedPoolStateStore;
  networkDefault?: string;
}): Promise<PoolState | null> {
  const { store, networkDefault } = args;

  ensureDirForFileSync(store.filename); // <- add this

  await store.load();

  const cur = store.get<PoolState>(POOL_STATE_STORE_KEY);
  if (cur) return ensurePoolStateDefaults(cur, networkDefault);

  const legacy = store.get<PoolState>(LEGACY_POOL_STATE_STORE_KEY);
  if (legacy) {
    store.set(POOL_STATE_STORE_KEY, legacy);
    store.delete(LEGACY_POOL_STATE_STORE_KEY);
    await store.flush();
    return ensurePoolStateDefaults(legacy, networkDefault);
  }

  return null;
}

export async function writePoolState(args: {
  store: FileBackedPoolStateStore;
  state: PoolState;
  networkDefault?: string;
}): Promise<void> {
  const { store, state, networkDefault } = args;

  ensureDirForFileSync(store.filename); // <- add this

  await store.load();
  store.set(POOL_STATE_STORE_KEY, ensurePoolStateDefaults(state, networkDefault));
  await store.flush();
}