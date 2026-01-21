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

  /**
   * For RPA deposits: the derived stealth receiver hash160 (P2PKH).
   * For base deposits: we still set this to the P2PKH hash160 from the deposit output,
   * so existing "isP2pkhOutpointUnspent" checks keep working.
   */
  receiverRpaHash160Hex: string;

  createdAt: string;

  /**
   * RPA-only metadata. Base deposits will have this absent.
   */
  rpaContext?: RpaContext;

  /**
   * Non-consensus classification. If absent, treat as 'rpa' for old files.
   */
  depositKind?: 'rpa' | 'base_p2pkh';

  /**
   * For base deposits: record the actual P2PKH hash160 (same as receiverRpaHash160Hex),
   * explicitly to avoid implying stealth.
   */
  baseP2pkhHash160Hex?: string;

  /**
   * Optional warnings/notes for operators.
   */
  warnings?: string[];

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