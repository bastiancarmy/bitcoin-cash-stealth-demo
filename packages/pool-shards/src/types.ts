export type Network = "chipnet";
export type PoolVersion = "v1" | "v1_1";

export interface PoolConfig {
  network: Network;
  shardValueSats: bigint;
  defaultFeeSats: bigint;
  poolVersion: PoolVersion;
}

export interface ShardRef {
  txid: string;
  vout: number;
  value: string;
  commitmentHex: string;
}

export interface PoolState {
  network: string;
  categoryHex: string;
  redeemScriptHex: string;
  shards: ShardRef[];
}

export interface Actor {
  /** opaque identifier used for logs/stateStore keys, not "bob"/"alice" */
  id: string;
  // whatever else you already use internally (wallet, privkey, etc.)
}