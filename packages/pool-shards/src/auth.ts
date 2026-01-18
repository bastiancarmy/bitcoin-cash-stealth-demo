// packages/pool-shards/src/auth.ts
import { bytesToHex, hexToBytes } from '@bch-stealth/utils';
import type { TxBuilderLike } from './di.js';

export type PrevoutAuthLike = {
  valueSats: bigint;
  scriptPubKey: Uint8Array;
};

export type AuthorizeP2pkhInputArgs = {
  tx: any;
  vin: number;
  privBytes: Uint8Array;
  prevout: PrevoutAuthLike;
};

export type AuthorizeCovenantInputArgs = {
  tx: any;
  vin: number;
  covenantPrivBytes: Uint8Array;
  redeemScript: Uint8Array;
  prevout: PrevoutAuthLike;

  // For your current covenant signing routine:
  amountCommitment?: bigint;
  hashtype?: number;

  // Pool hash-fold unlocking prefix (builder computes; provider applies)
  extraPrefix?: Uint8Array;
};

export type AuthProvider = {
  authorizeP2pkhInput(args: AuthorizeP2pkhInputArgs): void;
  authorizeCovenantInput(args: AuthorizeCovenantInputArgs): void;
};

export function makeDefaultAuthProvider(txb: TxBuilderLike): AuthProvider {
  return {
    authorizeP2pkhInput({ tx, vin, privBytes, prevout }) {
      txb.signInput(tx, vin, privBytes, prevout.scriptPubKey, prevout.valueSats);
    },

    authorizeCovenantInput({
      tx,
      vin,
      covenantPrivBytes,
      redeemScript,
      prevout,
      amountCommitment,
      hashtype,
      extraPrefix,
    }) {
      txb.signCovenantInput(
        tx,
        vin,
        covenantPrivBytes,
        redeemScript,
        prevout.valueSats,
        prevout.scriptPubKey,
        amountCommitment ?? 0n,
        hashtype
      );

      if (extraPrefix && extraPrefix.length) {
        const base = hexToBytes(tx.inputs[vin].scriptSig);
        tx.inputs[vin].scriptSig = bytesToHex(new Uint8Array([...extraPrefix, ...base]));
      }
    },
  };
}