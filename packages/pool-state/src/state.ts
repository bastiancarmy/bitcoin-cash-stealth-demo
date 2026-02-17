// packages/pool-state/src/state.ts

export type CovenantSignerIdentity = {
  actorId: string;
  pubkeyHash160Hex: string; // 20-byte hex
};

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

  rpaContext?: RpaContext;

  depositKind?: 'rpa' | 'base_p2pkh';

  baseP2pkhHash160Hex?: string;

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

  shardBefore?: unknown;
  shardAfter?: unknown;
};

export type ShardPointer = {
  index: number;
  txid: string;
  vout: number;
  valueSats: string;
  commitmentHex: string;
};

export type PoolState = {
  /**
   * Explicit signer identity for covenant spends.
   * Additive/non-breaking: older state files may omit this.
   */
  covenantSigner?: CovenantSignerIdentity;

  schemaVersion: 1;

  network: string;
  poolIdHex: string;
  poolVersion: string;

  categoryHex: string;
  redeemScriptHex: string;

  shardCount: number;
  shards: ShardPointer[];

  stealthUtxos?: StealthUtxoRecord[];
  deposits?: DepositRecord[];
  withdrawals?: WithdrawalRecord[];

  createdAt?: string;
  repairedAt?: string;

  txid?: string;
  lastDeposit?: DepositRecord;
  lastImport?: unknown;
  lastWithdraw?: unknown;
};