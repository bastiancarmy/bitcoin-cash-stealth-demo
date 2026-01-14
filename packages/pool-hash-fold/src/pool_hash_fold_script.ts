// packages/pool-hash-fold/src/pool_hash_fold_script.ts

export const POOL_HASH_FOLD_VERSION = {
  V0: 'v0',
  V1: 'v1',
  V1_1: 'v1.1',
} as const;

export type PoolHashFoldVersion =
  (typeof POOL_HASH_FOLD_VERSION)[keyof typeof POOL_HASH_FOLD_VERSION];