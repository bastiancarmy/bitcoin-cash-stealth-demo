// packages/pool-shards/tests/di_wrappers.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// Import wrappers directly (not from package barrel) since wrappers are optional/internal.
import { initShards, importDeposit, withdraw } from '../dist/wrappers.js';

// Minimal deterministic mock deps: no network, no electrum.
const mockDeps = {
  txb: undefined,
  prevouts: {
    async getPrevout(txid, vout) {
      return {
        txid,
        vout,
        valueSats: 100_000n,
        scriptPubKey: Uint8Array.from([0x76, 0xa9, 0x14, ...new Array(20).fill(0x11), 0x88, 0xac]),
      };
    },
  },
  broadcast: {
    async broadcastTx(rawTx) {
      assert.ok(rawTx instanceof Uint8Array);
      return { txid: 'ff'.repeat(32) };
    },
  },
};

test('wrappers DI: can run init/import/withdraw using mock prevout provider (no network)', async () => {
  const cfg = {
    network: 'chipnet',
    poolIdHex: 'aa'.repeat(20),
    poolVersion: 'v1',
    shardValueSats: 2000,
    defaultFeeSats: 2000,
  };

  const wallet = {
    signPrivBytes: Uint8Array.from([1, ...new Array(31).fill(0)]),
    pubkeyHash160Hex: '11'.repeat(20),
  };

  const initRes = await initShards({
    cfg,
    shardCount: 1,
    fundingOutpoint: { txid: '00'.repeat(32), vout: 0 },
    ownerWallet: wallet,
    deps: mockDeps,
  });

  assert.ok(initRes.result?.rawTx instanceof Uint8Array);
  assert.ok(initRes.broadcast);

  const pool = initRes.result.nextPoolState;

  const impRes = await importDeposit({
    pool,
    shardIndex: 0,
    shardOutpoint: { txid: '00'.repeat(32), vout: 1 },
    depositOutpoint: { txid: '22'.repeat(32), vout: 0 },
    ownerWallet: wallet,
    feeSats: 2000n,
    amountCommitment: 0n,
    deps: mockDeps,
  });

  assert.ok(impRes.result?.rawTx instanceof Uint8Array);
  assert.ok(impRes.broadcast);

  const wRes = await withdraw({
    pool: impRes.result.nextPoolState,
    shardIndex: 0,
    shardOutpoint: { txid: '00'.repeat(32), vout: 0 },
    feeOutpoint: { txid: '33'.repeat(32), vout: 0 },
    senderWallet: wallet,
    receiverP2pkhHash160Hex: '22'.repeat(20),
    amountSats: 1000n,
    feeSats: 2000n,
    amountCommitment: 0n,
    deps: mockDeps,
  });

  assert.ok(wRes.result?.rawTx instanceof Uint8Array);
  assert.ok(wRes.broadcast);
});