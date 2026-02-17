// packages/pool-shards/tests/witness_input_ordering.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@bch-stealth/utils';
import { importDepositToShard, withdrawFromShard } from '@bch-stealth/pool-shards';

function u8(n, b = 1) {
  return new Uint8Array(n).fill(b);
}

test('import: witness input (if provided) is appended last; signed only if witnessPrivBytes provided', () => {
  const calls = [];

  const auth = {
    authorizeP2pkhInput({ vin, privBytes }) {
      calls.push({ vin, privBytes });
    },
  };

  const txb = {
    buildRawTx() { return u8(10, 0xaa); },
    getP2PKHScript(hash160) { return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160, 0x88, 0xac]); },
    addTokenToScript(_t, locking) { return locking; },
  };

  const deps = { txb, auth };

  const pool = {
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51',
    shards: [{ index: 0, txid: 'aa'.repeat(32), vout: 0, valueSats: '2000', commitmentHex: '11'.repeat(32) }],
  };

  const p2pkhSpk = hexToBytes('76a914' + '11'.repeat(20) + '88ac');

  const shardPrevout = { txid: 'aa'.repeat(32), vout: 0, valueSats: 2000n, scriptPubKey: u8(10) };
  const depositPrevout = { txid: 'bb'.repeat(32), vout: 1, valueSats: 50_000n, scriptPubKey: p2pkhSpk };

  // No witness
  const r0 = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    depositWallet: { signPrivBytes: u8(32, 0xd1) },
    deps,
  });
  assert.equal(r0.tx.inputs.length, 2);

  // Witness provided but no witnessPrivBytes => no extra signing call
  calls.length = 0;
  const witnessPrevout = { txid: 'cc'.repeat(32), vout: 9, valueSats: 10_000n, scriptPubKey: p2pkhSpk };
  const r1 = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    witnessPrevout,
    depositWallet: { signPrivBytes: u8(32, 0xd1) },
    deps,
  });
  assert.equal(r1.tx.inputs.length, 3);
  assert.equal(r1.tx.inputs[2].txid, witnessPrevout.txid);
  assert.equal(calls.filter((c) => c.vin === 2).length, 0);

  // Witness + witnessPrivBytes => witness vin signed
  calls.length = 0;
  const r2 = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    witnessPrevout,
    witnessPrivBytes: u8(32, 0xa7),
    depositWallet: { signPrivBytes: u8(32, 0xd1) },
    deps,
  });
  assert.equal(r2.tx.inputs.length, 3);
  assert.equal(r2.tx.inputs[2].txid, witnessPrevout.txid);
  assert.equal(calls.filter((c) => c.vin === 2).length, 1);
});

test('withdraw: witness input (if provided) is appended last; signed only if witnessPrivBytes provided', () => {
  const calls = [];

  const auth = {
    authorizeP2pkhInput({ vin }) {
      calls.push({ vin });
    },
  };

  const txb = {
    buildRawTx() { return u8(10, 0xaa); },
    getP2PKHScript(hash160) { return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160, 0x88, 0xac]); },
    addTokenToScript(_t, locking) { return locking; },
  };

  const deps = { txb, auth };

  const pool = {
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51',
    shards: [{ index: 0, txid: 'aa'.repeat(32), vout: 0, valueSats: '50000', commitmentHex: '11'.repeat(32) }],
  };

  const p2pkhSpk = hexToBytes('76a914' + '11'.repeat(20) + '88ac');

  const shardPrevout = { txid: 'aa'.repeat(32), vout: 0, valueSats: 50_000n, scriptPubKey: u8(10) };
  const feePrevout = { txid: 'bb'.repeat(32), vout: 1, valueSats: 10_000n, scriptPubKey: p2pkhSpk };
  const witnessPrevout = { txid: 'cc'.repeat(32), vout: 9, valueSats: 10_000n, scriptPubKey: p2pkhSpk };

  calls.length = 0;
  const r1 = withdrawFromShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    feePrevout,
    witnessPrevout,
    feeWallet: { signPrivBytes: u8(32, 0xf2), pubkeyHash160Hex: '11'.repeat(20) },
    receiverP2pkhHash160Hex: '22'.repeat(20),
    changeP2pkhHash160Hex: '11'.repeat(20),
    amountSats: 20_000n,
    feeSats: 1_000n,
    deps,
  });

  assert.equal(r1.tx.inputs.length, 3);
  assert.equal(r1.tx.inputs[2].txid, witnessPrevout.txid);
  assert.equal(calls.filter((c) => c.vin === 2).length, 0);

  calls.length = 0;
  const r2 = withdrawFromShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    feePrevout,
    witnessPrevout,
    witnessPrivBytes: u8(32, 0xa7),
    feeWallet: { signPrivBytes: u8(32, 0xf2), pubkeyHash160Hex: '11'.repeat(20) },
    receiverP2pkhHash160Hex: '22'.repeat(20),
    changeP2pkhHash160Hex: '11'.repeat(20),
    amountSats: 20_000n,
    feeSats: 1_000n,
    deps,
  });

  assert.equal(r2.tx.inputs.length, 3);
  assert.equal(r2.tx.inputs[2].txid, witnessPrevout.txid);
  assert.equal(calls.filter((c) => c.vin === 2).length, 1);
});