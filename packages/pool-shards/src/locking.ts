// packages/pool-shards/src/locking.ts
import type { TxBuilderLike } from './di.js';

function ensureBytesLen(u8: Uint8Array, n: number, label: string) {
  if (!(u8 instanceof Uint8Array) || u8.length !== n) throw new Error(`${label} must be ${n} bytes`);
}

export type ShardLockParams = {
  token: unknown;
  redeemScript: Uint8Array;
};

export interface LockingTemplates {
  p2pkh(hash16020: Uint8Array): Uint8Array;

  /**
   * Shard locking script.
   *
   * Phase 2 (chipnet demo): **bare covenant**
   * scriptPubKey = addTokenToScript(token, redeemScriptBytes)
   *
   * NOTE: This is intentionally NOT P2SH-wrapped.
   */
  shardLock(params: ShardLockParams): Uint8Array;
}

export function makeDefaultLockingTemplates(opts: { txb: TxBuilderLike }): LockingTemplates {
  const { txb } = opts;

  return {
    p2pkh(hash16020) {
      ensureBytesLen(hash16020, 20, 'locking.p2pkh(hash16020)');
      return txb.getP2PKHScript(hash16020);
    },

    shardLock({ token, redeemScript }) {
      if (!(redeemScript instanceof Uint8Array) || redeemScript.length === 0) {
        throw new Error('locking.shardLock(redeemScript): redeemScript must be non-empty Uint8Array');
      }

      // ✅ Bare covenant (no P2SH wrapper)
      return txb.addTokenToScript(token as any, redeemScript);
    },
  };
}