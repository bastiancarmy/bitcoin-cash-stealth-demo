// packages/pool-shards/src/locking.ts
import { hash160 } from '@bch-stealth/utils';
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
      ensureBytesLen(redeemScript, redeemScript.length, 'locking.shardLock(redeemScript)'); // (optional/no-op)
      const redeemHash20 = hash160(redeemScript);
      ensureBytesLen(redeemHash20, 20, 'locking.shardLock(redeemHash20)');
      const p2shLock = txb.getP2SHScript(redeemHash20);
      return txb.addTokenToScript(token as any, p2shLock);
    },
  };
}