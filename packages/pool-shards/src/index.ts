// packages/pool-shards/src/index.ts

// Public types
export * from './types.js';

// Dependency injection + auth + output templates (public utilities)
export * from './di.js';
export * from './auth.js';
export * from './locking.js';

// Policy primitives (stable, reusable)
export * from './policy.js';

// Debug utilities (push parser + validator)
export * from './script_pushes.js';

// Core builders (public API)
export { initShardsTx } from './init.js';
export { importDepositToShard } from './import.js';
export { withdrawFromShard } from './withdraw.js';

// NOTE:
// We intentionally do NOT export shard_common.js from the package surface.
// Keep it internal to reduce accidental API coupling and name collisions.