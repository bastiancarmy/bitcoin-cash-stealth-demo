// src/pool_shards_deps.ts
import * as txb from '@bch-stealth/tx-builder';
import { broadcastTx, getTxDetails } from '@bch-stealth/electrum';
import { NETWORK } from './config.js';

export type PrevoutRecord = {
  txid: string;
  vout: number;
  valueSats: bigint;
  scriptPubKey: Uint8Array;
};

export type PoolShardsDeps = {
  txb: typeof txb;
  prevouts: {
    getPrevout(txid: string, vout: number): Promise<PrevoutRecord>;
  };
  broadcast: {
    broadcastTx(rawTx: Uint8Array): Promise<string>;
  };
};

export function makePoolShardsDeps(): PoolShardsDeps {
  return {
    txb,
    prevouts: {
      async getPrevout(txid: string, vout: number) {
        const details: any = await getTxDetails(txid, NETWORK);
        const out = details?.outputs?.[vout];
        if (!out) throw new Error(`Unable to read prevout ${txid}:${vout}`);

        const spk = out.scriptPubKey;
        if (!(spk instanceof Uint8Array)) {
          throw new Error(`Prevout scriptPubKey must be Uint8Array at ${txid}:${vout}`);
        }

        const valueSats = BigInt(out.value);
        return { txid, vout, valueSats, scriptPubKey: spk };
      },
    },
    broadcast: {
      async broadcastTx(rawTx: Uint8Array) {
        // electrum api currently accepts hex in some call sites; keep it bytes here
        // If your broadcastTx expects hex, convert in caller (bytesToHex).
        return broadcastTx(rawTx);
      },
    },
  };
}