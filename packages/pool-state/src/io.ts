// packages/pool-state/src/io.ts
import path from 'node:path';
import fsSync from 'node:fs';

import type { PoolState } from './state.js';
import { ensurePoolStateDefaults } from './helpers.js';
import { FileBackedPoolStateStore } from './filestore.js';

// Canonical key (v1)
export const POOL_STATE_STORE_KEY = 'pool.state';

// Legacy keys (migrate forward once)
export const LEGACY_POOL_STATE_STORE_KEY = 'pool.shardedPool';
export const LEGACY_POOL_STATE_STORE_KEY_V0 = 'demo.shardedPool';

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

/**
 * Read canonical pool state from store.
 * - Uses canonical key `pool.state`.
 * - Migrates forward from legacy keys if present.
 */
export async function readPoolState(args: {
  store: FileBackedPoolStateStore;
  networkDefault?: string;
}): Promise<PoolState | null> {
  const { store, networkDefault } = args;

  ensureDirForFileSync(store.filename);
  await store.load();

  const cur = store.get<any>(POOL_STATE_STORE_KEY);
  if (cur) return ensurePoolStateDefaults(cur, networkDefault);

  // Try legacy keys in priority order
  const legacyA = store.get<any>(LEGACY_POOL_STATE_STORE_KEY);
  if (legacyA) {
    const migrated = ensurePoolStateDefaults(legacyA, networkDefault);
    store.set(POOL_STATE_STORE_KEY, migrated);
    store.delete(LEGACY_POOL_STATE_STORE_KEY);
    await store.flush();
    return migrated;
  }

  const legacyB = store.get<any>(LEGACY_POOL_STATE_STORE_KEY_V0);
  if (legacyB) {
    const migrated = ensurePoolStateDefaults(legacyB, networkDefault);
    store.set(POOL_STATE_STORE_KEY, migrated);
    store.delete(LEGACY_POOL_STATE_STORE_KEY_V0);
    await store.flush();
    return migrated;
  }

  return null;
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