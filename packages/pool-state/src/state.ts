// packages/pool-state/src/state.ts

export type RpaContext = {
  senderPub33Hex: string;
  prevoutHashHex: string;
  prevoutN: number;
  index: number;
};

export type StealthUtxoRecord = {
  owner: string;
  purpose: string;
  txid: string;
  vout: number;

  /**
   * Canonical field (v1):
   * - stringified bigint sats
   */
  valueSats: string;

  /**
   * Legacy field (kept for backward compatibility with older state files).
   * Prefer `valueSats`.
   */
  value?: string;

  hash160Hex: string;
  rpaContext: RpaContext;
  createdAt: string;
  spentInTxid?: string;
  spentAt?: string;
};

export type DepositRecord = {
  txid: string;
  vout: number;

  /**
   * Canonical field (v1):
   * - stringified bigint sats
   */
  valueSats: string;

  /**
   * Legacy field (kept for backward compatibility with older state files).
   * Prefer `valueSats`.
   */
  value?: string;

  receiverRpaHash160Hex: string;
  createdAt: string;
  rpaContext: RpaContext;
  importTxid?: string;
  importedIntoShard?: number;
  spentTxid?: string;
  spentAt?: string;
};

export type WithdrawalRecord = {
  txid: string;
  shardIndex: number;
  amountSats: number;
  receiverRpaHash160Hex: string;
  createdAt: string;
  rpaContext: RpaContext;
  receiverPaycodePub33Hex?: string;

  // debug / optional history snapshots
  shardBefore?: unknown;
  shardAfter?: unknown;
};

/**
 * Canonical shard pointer (aligned with @bch-stealth/pool-shards).
 */
export type ShardPointer = {
  index: number;
  txid: string;
  vout: number;
  valueSats: string;
  commitmentHex: string;
};

export type PoolState = {
  /**
   * Canonical schema version for the pool state contract.
   * If missing in old files, pool-state migration will set this to 1.
   */
  schemaVersion: 1;

  network: string;
  poolIdHex: string;
  poolVersion: string;

  categoryHex: string;
  redeemScriptHex: string;

  shardCount: number;
  shards: ShardPointer[];

  // Optional operational history (append-only)
  stealthUtxos?: StealthUtxoRecord[];
  deposits?: DepositRecord[];
  withdrawals?: WithdrawalRecord[];

  // Optional metadata (non-consensus, may be absent)
  createdAt?: string;
  repairedAt?: string;

  /**
   * Legacy/compat metadata fields (kept for MVP compatibility).
   * Prefer `poolIdHex`+`shards[]` and use history arrays for operations.
   */
  txid?: string;
  lastDeposit?: DepositRecord;
  lastImport?: unknown;
  lastWithdraw?: unknown;
};