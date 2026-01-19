// packages/pool-shards/src/shard_common.ts
import * as txbDefault from '@bch-stealth/tx-builder';
import { hexToBytes } from '@bch-stealth/utils';

import { makeDefaultAuthProvider } from './auth.js';
import { makeDefaultLockingTemplates } from './locking.js';
import type { BuilderDeps, TxBuilderLike } from './di.js';
import type { PrevoutLike } from './types.js';

export function asBigInt(v: number | string | bigint, label: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v);
  throw new Error(`${label} must be number|string|bigint`);
}

export function ensureBytesLen(u8: Uint8Array, n: number, label: string) {
  if (!(u8 instanceof Uint8Array) || u8.length !== n) throw new Error(`${label} must be ${n} bytes`);
}

export function normalizeRawTxBytes(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  return hexToBytes(raw);
}

export function resolveBuilderDeps(deps?: BuilderDeps): {
  txb: TxBuilderLike;
  auth: ReturnType<typeof makeDefaultAuthProvider>;
  locking: ReturnType<typeof makeDefaultLockingTemplates>;
} {
  const txb = deps?.txb ?? txbDefault;
  const auth = deps?.auth ?? makeDefaultAuthProvider(txb);
  const locking = deps?.locking ?? makeDefaultLockingTemplates({ txb });
  return { txb, auth, locking };
}

export function makeShardTokenOut(args: { category32: Uint8Array; commitment32: Uint8Array }) {
  const { category32, commitment32 } = args;
  return {
    category: category32,
    nft: { capability: 'mutable' as const, commitment: commitment32 },
  };
}

export function appendWitnessInput(tx: any, witnessPrevout?: PrevoutLike): {
  witnessVin?: number;
  witnessPrevoutCtx?: {
    valueSats: bigint;
    scriptPubKey: Uint8Array;
    outpoint: { txid: string; vout: number };
  };
} {
  if (!witnessPrevout) return {};

  tx.inputs.push({
    txid: witnessPrevout.txid,
    vout: witnessPrevout.vout,
    sequence: 0xffffffff,
  });

  const witnessVin = tx.inputs.length - 1;

  return {
    witnessVin,
    witnessPrevoutCtx: {
      valueSats: asBigInt(witnessPrevout.valueSats, 'witnessPrevout.valueSats'),
      scriptPubKey: witnessPrevout.scriptPubKey as Uint8Array,
      outpoint: { txid: witnessPrevout.txid, vout: witnessPrevout.vout },
    },
  };
}