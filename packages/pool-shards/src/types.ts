// packages/pool-shards/src/types.ts

export type Network = 'chipnet';

// Match pool-hash-fold versions (POOL_HASH_FOLD_VERSION.V1_1 is "v1.1")
export type PoolVersion = 'v1' | 'v1.1';

export type Hex = string;

export interface PoolConfig {
  network: Network;

  // 20-byte identifier (demo convention)
  poolIdHex: Hex;

  shardValueSats: bigint;
  defaultFeeSats: bigint;
  poolVersion: PoolVersion;
}

export interface ShardRef {
  index: number;
  txid: string;
  vout: number;

  // store as string for JSON friendliness
  valueSats: string;

  // 32-byte commitment hex
  commitmentHex: string;
}

export interface PoolState {
  poolIdHex: Hex;
  poolVersion: PoolVersion;
  shardCount: number;

  network: Network;

  // 32-byte hex
  categoryHex: Hex;

  // redeem script hex
  redeemScriptHex: Hex;

  shards: ShardRef[];
}

export interface Actor {
  // used to find fee UTXOs
  addressCashAddr: string;

  // used for change fallback if you do non-stealth change (20-byte hex)
  pubkeyHashHex: Hex;

  // used by tx-builder signing helpers
  signPrivBytes: Uint8Array;
}