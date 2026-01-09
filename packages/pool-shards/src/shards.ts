import type { Actor, PoolConfig, PoolState } from "./types.js";

export async function initShards(params: {
  cfg: PoolConfig;
  owner: Actor;
  shardCount: number;
  stateStore?: unknown; // TODO: replace later with demo-state interface
}): Promise<PoolState> {
  // TODO: wire to your existing ops (tx-builder, electrum, pool-hash-fold, etc.)
  throw new Error("initShards not implemented yet");
}

export async function importDepositToShard(params: {
  cfg: PoolConfig;
  pool: PoolState;
  receiver: Actor;
  deposit: {
    txid: string;
    vout: number;
    value: string;
    receiverRpaHash160Hex: string;
    rpaContext: unknown;
    createdAt?: string;
  };
  shardIndex: number;
}): Promise<{ txid: string; shardIndex: number; newPool: PoolState }> {
  throw new Error("importDepositToShard not implemented yet");
}

export async function withdrawFromShard(params: {
  cfg: PoolConfig;
  pool: PoolState;
  sender: Actor;
  receiverPaycodePub33: Uint8Array;
  shardIndex: number;
  amountSats: bigint;
}): Promise<{
  txid: string;
  newPool: PoolState;
  paymentOut: { hash160Hex: string; vout: number };
}> {
  throw new Error("withdrawFromShard not implemented yet");
}