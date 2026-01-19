import { strict as assert } from 'node:assert';
import test from 'node:test';

import { importDepositToShard } from '../dist/import.js';
import { withdrawFromShard } from '../dist/withdraw.js';

function u8(n) { return new Uint8Array(n).fill(1); }

function makeDeps() {
  const locking = {
    p2pkh() { return u8(25); },
    shardLock() { return u8(35); },
  };

  const txb = {
    buildRawTx() { return u8(200); },
    getP2SHScript() { return u8(23); },
    signInput() {},
    signCovenantInput() { throw new Error('unexpected'); },
    getP2PKHScript() { throw new Error('unexpected'); },
    addTokenToScript() { throw new Error('unexpected'); },
  };

  const authCalls = [];
  const auth = {
    authorizeP2pkhInput(a) { authCalls.push(['p2pkh', a.vin, a.witnessVin]); },
    authorizeCovenantInput(a) { authCalls.push(['covenant', a.vin, a.witnessVin]); },
  };

  return { deps: { txb, locking, auth }, authCalls };
}

test('importDepositToShard: witness input appended last when provided', () => {
  const { deps, authCalls } = makeDeps();

  const pool = {
    poolIdHex: '11'.repeat(20),
    poolVersion: 'demo',
    shardCount: 1,
    network: 'chipnet',
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51',
    shards: [{ index: 0, txid: 'aa'.repeat(32), vout: 0, valueSats: '2000', commitmentHex: '00'.repeat(32) }],
  };

  const shardPrevout = { txid: 'aa'.repeat(32), vout: 0, valueSats: 2000n, scriptPubKey: undefined };
  const depositPrevout = { txid: 'bb'.repeat(32), vout: 1, valueSats: 1500n, scriptPubKey: u8(25) };

  // without witness
  const r0 = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    covenantWallet: { signPrivBytes: u8(32) },
    depositWallet: { signPrivBytes: u8(32) },
    deps,
  });
  assert.equal(r0.tx.inputs.length, 2);
  assert.equal(r0.tx.inputs[0].txid, shardPrevout.txid);
  assert.equal(r0.tx.inputs[1].txid, depositPrevout.txid);

  // with witness
  const witnessPrevout = { txid: 'cc'.repeat(32), vout: 9, valueSats: 10_000n, scriptPubKey: u8(25) };

  const r1 = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    witnessPrevout,
    covenantWallet: { signPrivBytes: u8(32) },
    depositWallet: { signPrivBytes: u8(32) },
    deps,
  });

  assert.equal(r1.tx.inputs.length, 3);
  assert.equal(r1.tx.inputs[0].txid, shardPrevout.txid);
  assert.equal(r1.tx.inputs[1].txid, depositPrevout.txid);
  assert.equal(r1.tx.inputs[2].txid, witnessPrevout.txid);

  // auth calls should carry witnessVin=2 (last input)
  assert.ok(authCalls.some((c) => c[0] === 'covenant' && c[1] === 0 && c[2] === 2));
  assert.ok(authCalls.some((c) => c[0] === 'p2pkh' && c[1] === 1 && c[2] === 2));
});

test('withdrawFromShard: witness input appended last when provided', () => {
  const { deps, authCalls } = makeDeps();

  const pool = {
    poolIdHex: '11'.repeat(20),
    poolVersion: 'demo',
    shardCount: 1,
    network: 'chipnet',
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51',
    shards: [{ index: 0, txid: 'aa'.repeat(32), vout: 0, valueSats: '50000', commitmentHex: '00'.repeat(32) }],
  };

  const shardPrevout = { txid: 'aa'.repeat(32), vout: 0, valueSats: 50_000n, scriptPubKey: undefined };
  const feePrevout = { txid: 'bb'.repeat(32), vout: 1, valueSats: 10_000n, scriptPubKey: u8(25) };

  const witnessPrevout = { txid: 'cc'.repeat(32), vout: 9, valueSats: 10_000n, scriptPubKey: u8(25) };

  const r = withdrawFromShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    feePrevout,
    witnessPrevout,
    covenantWallet: { signPrivBytes: u8(32), pubkeyHash160Hex: '44'.repeat(20) },
    feeWallet: { signPrivBytes: u8(32), pubkeyHash160Hex: '55'.repeat(20) },
    receiverP2pkhHash160Hex: '66'.repeat(20),
    amountSats: 20_000,
    feeSats: 1_000,
    changeP2pkhHash160Hex: '77'.repeat(20),
    deps,
  });

  assert.equal(r.tx.inputs.length, 3);
  assert.equal(r.tx.inputs[0].txid, shardPrevout.txid);
  assert.equal(r.tx.inputs[1].txid, feePrevout.txid);
  assert.equal(r.tx.inputs[2].txid, witnessPrevout.txid);

  // auth calls should carry witnessVin=2 (last input)
  assert.ok(authCalls.some((c) => c[0] === 'covenant' && c[1] === 0 && c[2] === 2));
  assert.ok(authCalls.some((c) => c[0] === 'p2pkh' && c[1] === 1 && c[2] === 2));
});