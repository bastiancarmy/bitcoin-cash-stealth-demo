import test from 'node:test';
import assert from 'node:assert/strict';

import { selectFundingUtxo } from '../pool/state.js';

test('selectFundingUtxo: calls getUtxos in (address, network, includeUnconfirmed) order (and can fall back)', async () => {
  const wallet = {
    address: 'bitcoincash:qq000000000000000000000000000000000000000',
    privBytes: new Uint8Array(32).fill(1),
  } as any;

  const chainIO = {
    isP2pkhOutpointUnspent: async () => true,
    getPrevOutput: async (txid: string, vout: number) => ({
      value: 10_000,
      scriptPubKey: Uint8Array.from([
        0x76, 0xa9, 0x14,
        ...new Uint8Array(20).fill(0x11),
        0x88, 0xac,
      ]),
    }),
  };

  // This stub only returns utxos if called with the preferred arg order.
  const getUtxos = async (...a: any[]) => {
    const [address, network, includeUnconfirmed] = a;
    if (typeof address === 'string' && typeof network === 'string' && typeof includeUnconfirmed === 'boolean') {
      return [{ txid: 'aa'.repeat(32), vout: 0, value_sats: 10_000, height: 100 }];
    }
    return [];
  };

  const res = await selectFundingUtxo({
    mode: 'wallet-send',
    state: null, // should skip stealth path
    wallet,
    ownerTag: 'me',
    minSats: 1_000n,
    chainIO,
    getUtxos,
    network: 'chipnet',
    dustSats: 546n,
  });

  assert.equal(res.source, 'base');
  assert.equal(res.txid, 'aa'.repeat(32));
  assert.equal(res.vout, 0);
});