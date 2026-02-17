// packages/pool-shards/src/policy.ts
//
// Backward-compatible re-export shim.
// Pool policy lives in @bch-stealth/utils to avoid circular deps.

export {
  DUST_SATS,
  POOL_HASH_FOLD_VERSION,
  type PoolHashFoldVersion,
  DEFAULT_POOL_HASH_FOLD_VERSION,
  DEFAULT_CATEGORY_MODE,
  DEFAULT_CAP_BYTE,
  outpointHash32,
  categoryFromFundingTxid32,
  deriveCategory32FromFundingTxidHex,
  initialShardCommitment32,
  selectShardIndex,
} from '@bch-stealth/utils';