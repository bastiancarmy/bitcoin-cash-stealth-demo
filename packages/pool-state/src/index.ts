export type {
  PoolState,
  ShardPointer,
  DepositRecord,
  WithdrawalRecord,
  StealthUtxoRecord,
  RpaContext,
} from './state.js';

export {
  ensurePoolStateDefaults,
  upsertDeposit,
  getLatestUnimportedDeposit,
  upsertStealthUtxo,
  markStealthSpent,
} from './helpers.js';

export {
  POOL_STATE_STORE_KEY,
  LEGACY_POOL_STATE_STORE_KEY,
  DEFAULT_STATE_DIRNAME,
  DEFAULT_STATE_FILENAME,
  resolveDefaultPoolStatePaths,
  migrateLegacyPoolStateDirSync,
  readPoolState,
  writePoolState,
} from './io.js';

export { FileBackedPoolStateStore } from './filestore.js';