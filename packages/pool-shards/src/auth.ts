// packages/pool-shards/src/auth.ts
import { bytesToHex, hexToBytes } from '@bch-stealth/utils';
import type { TxBuilderLike } from './di.js';
import { maybeLogCovenantSpendDossier } from './debug/covenant_spend_dossier.js';

export type PrevoutAuthLike = {
  valueSats: bigint;
  scriptPubKey: Uint8Array;
};

export type WitnessContext = {
  witnessVin?: number;
  witnessPrevout?: (PrevoutAuthLike & { outpoint?: { txid: string; vout: number } }) | undefined;
};

export type AuthorizeP2pkhInputArgs = {
  tx: any;
  vin: number;
  privBytes: Uint8Array;
  prevout: PrevoutAuthLike;
} & WitnessContext;

export type AuthorizeCovenantInputArgs = {
  tx: any;
  vin: number;
  covenantPrivBytes: Uint8Array;
  redeemScript: Uint8Array;
  prevout: PrevoutAuthLike;

  amountCommitment?: bigint;
  hashtype?: number;

  extraPrefix?: Uint8Array;
} & WitnessContext;

export type AuthProvider = {
  authorizeP2pkhInput(args: AuthorizeP2pkhInputArgs): void;
  authorizeCovenantInput(args: AuthorizeCovenantInputArgs): void;
};

function inferAmountCommitmentFromTx(tx: any): bigint {
    const out0 = tx?.outputs?.[0];
    const v =
      out0?.value ??
      out0?.satoshis ??
      out0?.valueSats ??
      out0?.amount;
    if (v == null) return 0n;
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }

export function makeDefaultAuthProvider(txb: TxBuilderLike): AuthProvider {
  return {
    authorizeP2pkhInput(args: AuthorizeP2pkhInputArgs) {
      const { tx, vin, privBytes, prevout } = args;
      txb.signInput(tx, vin, privBytes, prevout.scriptPubKey, prevout.valueSats);
    },

    authorizeCovenantInput(args: AuthorizeCovenantInputArgs) {
      const {
        tx,
        vin,
        covenantPrivBytes,
        redeemScript,
        prevout,
        amountCommitment,
        hashtype,
        extraPrefix,
        witnessPrevout,
      } = args;

      const ht = hashtype ?? 0x41;
      const inferred = inferAmountCommitmentFromTx(tx);
      const amt = amountCommitment == null || amountCommitment === 0n ? inferred : amountCommitment;

      txb.signCovenantInput(
        tx,
        vin,
        covenantPrivBytes,
        redeemScript,
        prevout.valueSats,
        prevout.scriptPubKey,
        amt,
        ht
      );

      if (extraPrefix && extraPrefix.length) {
        const cur = tx.inputs?.[vin]?.scriptSig;
        const base =
          cur instanceof Uint8Array ? cur : typeof cur === 'string' ? hexToBytes(cur) : new Uint8Array();
        tx.inputs[vin].scriptSig = new Uint8Array([...extraPrefix, ...base]);
      }

      // ---- B451 dossier (after prefix applied) ----
      maybeLogCovenantSpendDossier({
        tx,
        vin,
        redeemScript,
        prevout: {
          ...prevout,
          outpoint: witnessPrevout?.outpoint,
        },
        amountCommitment: amt,
        hashtype: ht,
        extraPrefix,
      });
    },
  };
}