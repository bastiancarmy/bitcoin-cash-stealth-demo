// packages/pool-state/src/index.ts
//
// Public exports for @bch-stealth/pool-state (strict mode).
// Legacy migration exports intentionally removed to avoid tech debt.

export {
  POOL_STATE_STORE_KEY,
  DEFAULT_STATE_DIRNAME,
  DEFAULT_STATE_FILENAME,
  resolveDefaultPoolStatePaths,
  readPoolState,
  writePoolState,
} from './io.js';

export { FileBackedPoolStateStore } from './filestore.js';

export type { PoolStateStore } from './types.js';

// Canonical state types (CLI imports these from @bch-stealth/pool-state)
export type {
  PoolState,
  RpaContext,
  StealthUtxoRecord,
  DepositRecord,
  ShardPointer,
} from './state.js';

// Canonical state helpers (CLI imports these from @bch-stealth/pool-state)
export {
  ensurePoolStateDefaults,
  upsertDeposit,
  getLatestUnimportedDeposit,
  upsertStealthUtxo,
  markStealthSpent,
} from './helpers.js';