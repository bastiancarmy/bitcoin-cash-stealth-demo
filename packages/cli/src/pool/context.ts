// packages/cli/src/pool/context.ts
import type { FileBackedPoolStateStore, PoolState } from '@bch-stealth/pool-state';

export type WalletLike = {
  address: string;
  privBytes: Uint8Array;
  pubBytes: Uint8Array;
  hash160: Uint8Array;
  scanPrivBytes?: Uint8Array;
  spendPrivBytes?: Uint8Array;
};

export type Actors = {
  actorABaseWallet: WalletLike;
  actorBBaseWallet: WalletLike;
  actorAPaycodePub33: Uint8Array;
  actorBPaycodePub33: Uint8Array;
};

export type PoolContext = {
  network: string;
  store: FileBackedPoolStateStore;
  state: PoolState;
  actors: Actors;

  // chain boundary
  chain: {
    getPrevOutput: (txid: string, vout: number) => Promise<any>;
    pickFeeRateOrFallback: () => Promise<number>;
    broadcastRawTx: (rawHex: string) => Promise<string>;
    isP2pkhOutpointUnspent: (args: { scripthashHex: string; txid: string; vout: number }) => Promise<boolean>;
    waitForP2pkhOutpointUnspent: (
      args: { scripthashHex: string; txid: string; vout: number },
      opts?: { attempts?: number; delayMs?: number }
    ) => Promise<boolean>;
  };
};