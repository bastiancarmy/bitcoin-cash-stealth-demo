// packages/pool-shards/tests/auth_provider_abstraction.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@bch-stealth/utils';
import { importDepositToShard, withdrawFromShard } from '@bch-stealth/pool-shards';

function u8(fillByte) {
  return Uint8Array.from([fillByte, ...new Array(31).fill(fillByte)]);
}

test('auth provider: builders call deps.auth (and do not call txb.sign* directly)', () => {
  const calls = [];

  const mockAuth = {
    authorizeP2pkhInput({ vin, privBytes, prevout, tx }) {
      calls.push({ kind: 'p2pkh', vin, privBytes, prevout });
      // set something plausible so downstream code doesn’t choke if it inspects
      tx.inputs[vin].scriptSig = '00';
    },
    authorizeCovenantInput({ vin, covenantPrivBytes, prevout, extraPrefix, tx }) {
      calls.push({ kind: 'covenant', vin, covenantPrivBytes, prevout, extraPrefix });
      tx.inputs[vin].scriptSig = '00';
    },
  };

  // txb stub: signing methods MUST NOT be called when deps.auth is provided
  const txb = {
    buildRawTx() {
      return Uint8Array.from([0x01, 0x02]);
    },
    signInput() {
      throw new Error('txb.signInput should NOT be called (auth provider should be used)');
    },
    signCovenantInput() {
      throw new Error('txb.signCovenantInput should NOT be called (auth provider should be used)');
    },
    addTokenToScript(_token, lockingScript) {
      // Just return “something” Uint8Array; correctness not under test here
      return Uint8Array.from([0xef, ...lockingScript]);
    },
    getP2PKHScript(hash160) {
      return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160, 0x88, 0xac]);
    },
    getP2SHScript(scriptHash20) {
      return Uint8Array.from([0xa9, 0x14, ...scriptHash20, 0x87]);
    },
  };

  const deps = { txb, auth: mockAuth };

  const pool = {
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51',
    shards: [
      {
        index: 0,
        txid: '<prev>',
        vout: 0,
        valueSats: '2000',
        commitmentHex: '11'.repeat(32),
      },
    ],
  };

  const p2pkhSpk = hexToBytes('76a914' + '11'.repeat(20) + '88ac');

  const shardPrevout = {
    txid: '00'.repeat(32),
    vout: 0,
    valueSats: 2000n,
    scriptPubKey: p2pkhSpk,
  };

  const depositPrevout = {
    txid: '22'.repeat(32),
    vout: 0,
    valueSats: 50_000n,
    scriptPubKey: p2pkhSpk,
  };

  const feePrevout = {
    txid: '33'.repeat(32),
    vout: 0,
    valueSats: 10_000n,
    scriptPubKey: p2pkhSpk,
  };

  const covenantWallet = { signPrivBytes: u8(0xc1), pubkeyHash160Hex: '11'.repeat(20) };
  const depositWallet = { signPrivBytes: u8(0xd2), pubkeyHash160Hex: '11'.repeat(20) };
  const feeWallet = { signPrivBytes: u8(0xe3), pubkeyHash160Hex: '11'.repeat(20) };

  // --- import ---
  const imp = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    covenantWallet,
    depositWallet,
    feeSats: 2000n,
    amountCommitment: 0n,
    deps,
  });

  assert.ok(imp.rawTx instanceof Uint8Array);

  // --- withdraw ---
  const wd = withdrawFromShard({
    pool: imp.nextPoolState,
    shardIndex: 0,
    shardPrevout,
    feePrevout,
    covenantWallet,
    feeWallet,
    changeP2pkhHash160Hex: '11'.repeat(20),
    receiverP2pkhHash160Hex: '22'.repeat(20),
    amountSats: 1000n,
    feeSats: 2000n,
    amountCommitment: 0n,
    deps,
  });

  assert.ok(wd.rawTx instanceof Uint8Array);

  // --- assertions ---
  const covCalls = calls.filter((c) => c.kind === 'covenant');
  const p2pkhCalls = calls.filter((c) => c.kind === 'p2pkh');

  // We expect: import covenant + import p2pkh + withdraw covenant + withdraw p2pkh
  assert.equal(covCalls.length, 2);
  assert.equal(p2pkhCalls.length, 2);

  // import: covenant input 0 uses covenantWallet key; p2pkh input 1 uses depositWallet key
  assert.equal(covCalls[0].vin, 0);
  assert.strictEqual(covCalls[0].covenantPrivBytes, covenantWallet.signPrivBytes);
  assert.ok(covCalls[0].extraPrefix instanceof Uint8Array);
  assert.ok(covCalls[0].extraPrefix.length > 0);

  assert.equal(p2pkhCalls[0].vin, 1);
  assert.strictEqual(p2pkhCalls[0].privBytes, depositWallet.signPrivBytes);

  // withdraw: covenant input 0 uses covenantWallet key; p2pkh input 1 uses feeWallet key
  assert.equal(covCalls[1].vin, 0);
  assert.strictEqual(covCalls[1].covenantPrivBytes, covenantWallet.signPrivBytes);
  assert.ok(covCalls[1].extraPrefix instanceof Uint8Array);
  assert.ok(covCalls[1].extraPrefix.length > 0);

  assert.equal(p2pkhCalls[1].vin, 1);
  assert.strictEqual(p2pkhCalls[1].privBytes, feeWallet.signPrivBytes);
});