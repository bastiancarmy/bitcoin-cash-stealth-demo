// packages/pool-shards/tests/multi_signer_selection.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@bch-stealth/utils';
import { importDepositToShard, withdrawFromShard, outpointHash32 } from '@bch-stealth/pool-shards';
import { buildPoolHashFoldUnlockingBytecode, makeProofBlobV11 } from '@bch-stealth/pool-hash-fold';

function u8(n, b = 1) {
  return new Uint8Array(n).fill(b);
}

test('import: deposit input (vin=1) uses depositWallet key; covenant input is unsigned unlocking blob', () => {
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
  const depositPrevout = { txid: 'bb'.repeat(32), vout: 3, valueSats: 50_000n, scriptPubKey: p2pkhSpk };

  const depositPriv = u8(32, 0xd1);
  const depositWallet = { signPrivBytes: depositPriv };

  const res = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    depositWallet,
    feeSats: 2000n,
    deps,
  });

  // P2PKH signed with deposit wallet
  assert.equal(calls.length, 1);
  assert.equal(calls[0].vin, 1);
  assert.deepEqual(Buffer.from(calls[0].privBytes), Buffer.from(depositPriv));

  // Covenant scriptSig equals expected unlock
  const noteHash32 = outpointHash32(depositPrevout.txid, depositPrevout.vout);
  const proofBlob32 = makeProofBlobV11(noteHash32);
  const expectedUnlock = buildPoolHashFoldUnlockingBytecode({
    version: 'V1_1',
    limbs: [],
    noteHash32,
    proofBlob32,
  });

  assert.ok(res.tx.inputs[0].scriptSig instanceof Uint8Array);
  assert.deepEqual(Buffer.from(res.tx.inputs[0].scriptSig), Buffer.from(expectedUnlock));
});

test('withdraw: fee input (vin=1) uses feeWallet key; covenant input is unsigned unlocking blob', () => {
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
    shards: [{ index: 0, txid: 'aa'.repeat(32), vout: 0, valueSats: '100000', commitmentHex: '11'.repeat(32) }],
  };

  const p2pkhSpk = hexToBytes('76a914' + '11'.repeat(20) + '88ac');

  const shardPrevout = { txid: 'aa'.repeat(32), vout: 0, valueSats: 100_000n, scriptPubKey: u8(10) };
  const feePrevout = { txid: 'cc'.repeat(32), vout: 0, valueSats: 10_000n, scriptPubKey: p2pkhSpk };

  const feePriv = u8(32, 0xf2);
  const feeWallet = { signPrivBytes: feePriv, pubkeyHash160Hex: '11'.repeat(20) };

  const res = withdrawFromShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    feePrevout,
    feeWallet,
    receiverP2pkhHash160Hex: '22'.repeat(20),
    changeP2pkhHash160Hex: '11'.repeat(20),
    amountSats: 1000n,
    feeSats: 2000n,
    deps,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].vin, 1);
  assert.deepEqual(Buffer.from(calls[0].privBytes), Buffer.from(feePriv));

  assert.ok(res.tx.inputs[0].scriptSig instanceof Uint8Array);
  assert.ok(res.tx.inputs[0].scriptSig.length > 0, 'expected push-only unlock for covenant input');
});