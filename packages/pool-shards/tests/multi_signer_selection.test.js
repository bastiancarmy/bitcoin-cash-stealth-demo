// packages/pool-shards/tests/multi_signer_selection.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes, bytesToHex } from '@bch-stealth/utils';
import { importDepositToShard, withdrawFromShard } from '@bch-stealth/pool-shards';

// A tiny “spy” tx-builder that records which privkey bytes were used per input.
function makeSpyTxb() {
  const calls = {
    signCovenantInput: [],
    signInput: [],
  };

  const txb = {
    buildRawTx(_tx, _opts) {
      return Uint8Array.from([0x00]);
    },

    signInput(tx, inputIndex, privBytes, scriptPubKey, value) {
      calls.signInput.push({ inputIndex, privBytes, scriptPubKey, value });
      if (!tx.inputs[inputIndex].scriptSig) tx.inputs[inputIndex].scriptSig = '';
      return tx;
    },

    signCovenantInput(tx, inputIndex, privBytes, redeemScript, value, rawPrevScript, amount, hashtype) {
      calls.signCovenantInput.push({
        inputIndex,
        privBytes,
        redeemScript,
        value,
        rawPrevScript,
        amount,
        hashtype,
      });
      // must exist for prefix-prepend logic
      tx.inputs[inputIndex].scriptSig = '00';
      return tx;
    },

    addTokenToScript(_token, lockingScript) {
      return lockingScript;
    },

    getP2PKHScript(hash160) {
      return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160, 0x88, 0xac]);
    },

    getP2SHScript(scriptHash20) {
      return Uint8Array.from([0xa9, 0x14, ...scriptHash20, 0x87]);
    },
  };

  return { txb, calls };
}

function assertBytesEqual(actualU8, expectedU8, label) {
  assert.ok(actualU8 instanceof Uint8Array, `${label}: actual must be Uint8Array`);
  assert.ok(expectedU8 instanceof Uint8Array, `${label}: expected must be Uint8Array`);
  assert.equal(bytesToHex(actualU8), bytesToHex(expectedU8), `${label}: bytes mismatch`);
}

test('multi-signer: importDepositToShard uses covenantWallet for input0 and depositWallet for input1', () => {
  const { txb, calls } = makeSpyTxb();

  const covenantPriv = Uint8Array.from([0xc1, ...new Array(31).fill(0x01)]);
  const depositPriv = Uint8Array.from([0xd1, ...new Array(31).fill(0x02)]);

  const pool = {
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51', // OP_1 placeholder
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
    txid: 'aa'.repeat(32),
    vout: 0,
    valueSats: 2000n,
    scriptPubKey: p2pkhSpk,
  };

  const depositPrevout = {
    txid: 'bb'.repeat(32),
    vout: 0,
    valueSats: 50_000n,
    scriptPubKey: p2pkhSpk,
  };

  // Explicit multi-signer (wallet-based, matches current builders)
  const covenantWallet = {
    signPrivBytes: covenantPriv,
    pubkeyHash160Hex: '11'.repeat(20),
  };

  const depositWallet = {
    signPrivBytes: depositPriv,
    pubkeyHash160Hex: '22'.repeat(20),
  };

  importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    covenantWallet,
    depositWallet,
    feeSats: 2000n,
    amountCommitment: 0n,
    deps: { txb },
  });

  assert.equal(calls.signCovenantInput.length, 1, 'expected one covenant signature');
  assert.equal(calls.signInput.length, 1, 'expected one p2pkh signature');

  assert.equal(calls.signCovenantInput[0].inputIndex, 0);
  assertBytesEqual(calls.signCovenantInput[0].privBytes, covenantPriv, 'covenant input privkey');

  assert.equal(calls.signInput[0].inputIndex, 1);
  assertBytesEqual(calls.signInput[0].privBytes, depositPriv, 'deposit input privkey');
});

test('multi-signer: withdrawFromShard uses covenantWallet for input0 and feeWallet for input1', () => {
  const { txb, calls } = makeSpyTxb();

  const covenantPriv = Uint8Array.from([0xc2, ...new Array(31).fill(0x04)]);
  const feePriv = Uint8Array.from([0xf2, ...new Array(31).fill(0x05)]);

  const pool = {
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51', // OP_1 placeholder
    shards: [
      {
        index: 0,
        txid: '<prev>',
        vout: 0,
        valueSats: '100000',
        commitmentHex: '22'.repeat(32),
      },
    ],
  };

  const p2pkhSpk = hexToBytes('76a914' + '11'.repeat(20) + '88ac');

  const shardPrevout = {
    txid: 'cc'.repeat(32),
    vout: 0,
    valueSats: 100_000n,
    scriptPubKey: p2pkhSpk,
  };

  const feePrevout = {
    txid: 'dd'.repeat(32),
    vout: 0,
    valueSats: 10_000n,
    scriptPubKey: p2pkhSpk,
  };

  const covenantWallet = {
    signPrivBytes: covenantPriv,
    pubkeyHash160Hex: '11'.repeat(20),
  };

  const feeWallet = {
    signPrivBytes: feePriv,
    pubkeyHash160Hex: '11'.repeat(20),
  };

  withdrawFromShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    feePrevout,
    covenantWallet,
    feeWallet,
    receiverP2pkhHash160Hex: '22'.repeat(20),
    changeP2pkhHash160Hex: '11'.repeat(20),
    amountSats: 1000n,
    feeSats: 2000n,
    amountCommitment: 0n,
    deps: { txb },
  });

  assert.equal(calls.signCovenantInput.length, 1, 'expected one covenant signature');
  assert.equal(calls.signInput.length, 1, 'expected one fee signature');

  assert.equal(calls.signCovenantInput[0].inputIndex, 0);
  assertBytesEqual(calls.signCovenantInput[0].privBytes, covenantPriv, 'covenant input privkey');

  assert.equal(calls.signInput[0].inputIndex, 1);
  assertBytesEqual(calls.signInput[0].privBytes, feePriv, 'fee input privkey');
});