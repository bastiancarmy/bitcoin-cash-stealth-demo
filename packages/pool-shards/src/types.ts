// packages/pool-shards/src/types.ts

export type CategoryMode = 'none' | 'reverse';

// types.ts
export type PoolConfig = {
  network: string;
  poolIdHex: string;
  poolVersion: string;
  shardValueSats: number | string;
  defaultFeeSats: number | string;
  redeemScriptHex?: string;
};

export type ShardPointer = {
  index: number;
  txid: string;
  vout: number;
  valueSats: string; // stringified bigint
  commitmentHex: string; // 32-byte hex
};

export type PoolState = {
  poolIdHex: string;
  poolVersion: string;
  shardCount: number;
  network: string;
  categoryHex: string; // 32-byte hex
  redeemScriptHex: string; // covenant redeemScript bytes (hex)
  shards: ShardPointer[];
};

// Minimal “wallet-like” signer used by tx builders (avoid CLI types)
export type WalletLike = {
  signPrivBytes: Uint8Array;
  pubkeyHash160Hex: string; // 20-byte hex (for change)
};

// Legacy alias still used by some callers
export type Actor = {
  signPrivBytes: Uint8Array;
  pubkeyHashHex: string; // 20-byte hex
};

export type PrevoutLike = {
  txid: string;
  vout: number;
  valueSats: bigint;
  scriptPubKey: Uint8Array;
};

export type ShardPrevoutLike = {
  txid: string;
  vout: number;
  valueSats: bigint;
  commitment32: Uint8Array;
  redeemScript: Uint8Array;
  category32: Uint8Array;
  // if you already have it, great; otherwise we reconstruct when needed
  scriptPubKey?: Uint8Array;
};

// ---- Standardized builder results / diagnostics ----------------------------

export type PolicyDiagnostics = {
  poolHashFoldVersion?: string; // e.g. "V1_1"
  categoryMode?: CategoryMode;
  capByte?: number; // e.g. 0x01
};

export type BuilderResultBase<Diag, State> = {
  tx: any;
  rawTx: Uint8Array;
  sizeBytes: number; // rawTx.length
  diagnostics: Diag;
  nextPoolState: State;
};

export type InitShardsDiagnostics = {
  fundingOutpoint: { txid: string; vout: number };
  category32Hex: string;
  poolIdHex: string;
  poolVersion: string;
  shardCount: number;
  shardValueSats: string;
  feeSats: string;
  changeSats: string;
  redeemScriptHex: string;
  shardCommitmentsHex: string[]; // by shard index
  policy: {
    categoryDerivation: 'fundingTxid'; // matches deriveCategory32FromFundingTxidHex
    initialCommitment: 'H(H(poolId||category32||i||shardCount))';
  };
};

export type ImportDepositDiagnostics = {
  shardIndex: number;
  depositOutpoint: { txid: string; vout: number };
  category32Hex: string;
  stateIn32Hex: string;
  stateOut32Hex: string;
  noteHash32Hex: string;
  limbsHex: string[];
  feeSats: string;
  shardValueInSats: string;
  depositValueInSats: string;
  newShardValueSats: string;
  policy: PolicyDiagnostics;
};

export type WithdrawDiagnostics = {
  shardIndex: number;
  receiverHash160Hex: string;
  amountSats: string;
  feeSats: string;
  changeSats: string;
  category32Hex: string;
  stateIn32Hex: string;
  stateOut32Hex: string;
  noteHash32Hex: string; // nullifier-ish note hash in withdraw
  limbsHex: string[];
  policy: PolicyDiagnostics;
};

// ---- Public results --------------------------------------------------------

export type InitShardsResult = {
  // Back-compat fields:
  tx: any;
  rawTx: Uint8Array;
  poolState: PoolState;

  // Standardized fields (preferred):
  sizeBytes: number;
  diagnostics: InitShardsDiagnostics;
  nextPoolState: PoolState; // alias of poolState
};

export type ImportDepositResult = BuilderResultBase<ImportDepositDiagnostics, PoolState>;
export type ImportDepositResultLegacy = ImportDepositResult;

export type WithdrawResult = BuilderResultBase<WithdrawDiagnostics, PoolState>;
export type WithdrawResultLegacy = WithdrawResult;