import { outpointHash32 } from './policy.js';

export function selectShardIndex(args: {
  depositTxidHex: string;
  depositVout: number;
  shardCount: number;
}): number {
  const { depositTxidHex, depositVout, shardCount } = args;

  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error('selectShardIndex: shardCount must be > 0');
  }

  const h = outpointHash32(depositTxidHex, depositVout);
  return h[0] % shardCount;
}