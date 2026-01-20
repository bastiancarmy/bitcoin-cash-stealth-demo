// packages/cli/src/pool/context.ts
import type { FileBackedPoolStateStore } from '@bch-stealth/pool-state';

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

export type PoolOpConfig = {
  DUST: number;
  DEFAULT_FEE: bigint | number | string;
  SHARD_VALUE: bigint | number | string;
};

export type ChainIO = {
  getPrevOutput: (txid: string, vout: number) => Promise<any>;
  getFeeRateOrFallback: () => Promise<number>;
  broadcastRawTx: (rawHex: string) => Promise<string>;
  isP2pkhOutpointUnspent: (args: { txid: string; vout: number; hash160Hex: string }) => Promise<boolean>;
  waitForP2pkhOutpointUnspent: (
    args: { txid: string; vout: number; hash160Hex: string },
    opts?: { attempts?: number; delayMs?: number }
  ) => Promise<boolean>;
};

export type PoolOpContext = {
  network: string;
  store: FileBackedPoolStateStore;

  chainIO: ChainIO;

  // required by selectFundingUtxo (CLI boundary)
  getUtxos: (address: string, network: string, includeUnconfirmed: boolean) => Promise<any[]>;

  actors: Actors;

  poolVersion: any;
  config: PoolOpConfig;
};