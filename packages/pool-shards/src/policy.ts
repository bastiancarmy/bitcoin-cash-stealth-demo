import {
  sha256,
  concat,
  hexToBytes,
  reverseBytes,
  uint32le,
} from '@bch-stealth/utils';

import { POOL_HASH_FOLD_VERSION } from '@bch-stealth/pool-hash-fold';

export const DUST_SATS = 546n;

// ---- Defaults used by tx builders (CLI can override explicitly) ----
export const DEFAULT_POOL_HASH_FOLD_VERSION = POOL_HASH_FOLD_VERSION.V1_1;
export const DEFAULT_CATEGORY_MODE = 'none' as const;
export const DEFAULT_CAP_BYTE = 0x01 as const; // mutable NFT

// ------------------------------------------------------------------
// Repo conventions
// ------------------------------------------------------------------

/**
 * Repo convention (matches demo_sharded_pool):
 * outpointHash32 = sha256( txid_bytes_as_given || uint32le(vout) )
 *
 * IMPORTANT: txidHex is treated "as-is" bytes (no reversal).
 */
export function outpointHash32(txidHex: string, vout: number): Uint8Array {
  const txid = hexToBytes(txidHex);
  if (txid.length !== 32) throw new Error('outpointHash32: txidHex must be 32 bytes');
  return sha256(concat(txid, uint32le(vout >>> 0)));
}

/**
 * Repo convention for CashTokens category in the demo:
 * category32 = reverseBytes(funding.txid)  // 32 bytes
 */
export function categoryFromFundingTxid32(txidHex: string): Uint8Array {
  const txid = hexToBytes(txidHex);
  if (txid.length !== 32) throw new Error('categoryFromFundingTxid32: txidHex must be 32 bytes');
  return reverseBytes(txid);
}

/**
 * Back-compat alias (some refactors used this name).
 */
export function deriveCategory32FromFundingTxidHex(txidHex: string): Uint8Array {
  return categoryFromFundingTxid32(txidHex);
}

/**
 * Initial shard commitment policy (matches existing shards.ts logic):
 * sha256(sha256(poolId || category32 || u32le(i) || u32le(shardCount)))
 */
export function initialShardCommitment32(args: {
  poolId: Uint8Array;
  category32: Uint8Array;
  shardIndex: number;
  shardCount: number;
}): Uint8Array {
  const { poolId, category32, shardIndex, shardCount } = args;

  if (poolId.length !== 20) throw new Error('initialShardCommitment32: poolId must be 20 bytes');
  if (category32.length !== 32) throw new Error('initialShardCommitment32: category32 must be 32 bytes');

  return sha256(
    sha256(
      concat(
        poolId,
        category32,
        uint32le(shardIndex >>> 0),
        uint32le(shardCount >>> 0),
      ),
    ),
  );
}

export function selectShardIndex(args: {
  depositTxidHex: string;
  depositVout: number;
  shardCount: number;
}): number {
  const { depositTxidHex, depositVout, shardCount } = args;

  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new Error('selectShardIndex: shardCount must be a positive integer');
  }

  const h = outpointHash32(depositTxidHex, depositVout);
  return h[0] % shardCount;
}