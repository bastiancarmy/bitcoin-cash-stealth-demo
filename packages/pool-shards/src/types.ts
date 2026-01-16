export type CategoryMode = 'none' | 'reverse';

export type PoolConfig = {
  network: string;
  poolIdHex: string;      // 20-byte hex
  poolVersion: string;
  shardValueSats: number | string;
  defaultFeeSats: number | string;
};

export type ShardPointer = {
  index: number;
  txid: string;
  vout: number;
  valueSats: string;       // stringified bigint
  commitmentHex: string;   // 32-byte hex
};

export type PoolState = {
  poolIdHex: string;
  poolVersion: string;
  shardCount: number;
  network: string;
  categoryHex: string;       // 32-byte hex
  redeemScriptHex: string;   // covenant redeemScript bytes (hex)
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

export type InitShardsResult = {
  tx: any;
  rawTx: Uint8Array;
  poolState: PoolState;
};

export type ImportDepositResult = {
  tx: any;
  rawTx: Uint8Array;
  nextPoolState: PoolState;
};

export type WithdrawResult = {
  tx: any;
  rawTx: Uint8Array;
  nextPoolState: PoolState;
};