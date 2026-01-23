// packages/pool-shards/tests/auth_provider_abstraction.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@bch-stealth/utils';
import { importDepositToShard, withdrawFromShard } from '@bch-stealth/pool-shards';

import {
  buildPoolHashFoldUnlockingBytecode,
  makeProofBlobV11,
} from '@bch-stealth/pool-hash-fold';

import { outpointHash32 } from '@bch-stealth/pool-shards';

function u8(n, b = 1) {
  return new Uint8Array(n).fill(b);
}

test('builders use deps.auth only for P2PKH inputs; covenant input is push-only shardUnlock', () => {
  const calls = [];

  const auth = {
    authorizeP2pkhInput({ tx, vin, privBytes, prevout, witnessVin }) {
      calls.push({ kind: 'p2pkh', vin, privBytes, prevout, witnessVin });
      tx.inputs[vin].scriptSig = '00';
    },
    authorizeCovenantInput() {
      calls.push({ kind: 'covenant' });
    },
  };

  // If something accidentally tries to covenant-sign, blow up.
  const txb = {
    buildRawTx() {
      return u8(10, 0xaa);
    },
    signInput() {
      throw new Error('txb.signInput should not be called directly (auth seam)');
    },
    signCovenantInput() {
      throw new Error('covenant signing is intentionally disabled in Phase 2');
    },
    getP2PKHScript(hash160) {
      return Uint8Array.from([0x76, 0xa9, 0x14, ...hash160, 0x88, 0xac]);
    },
    addTokenToScript(_token, locking) {
      // Not needed here; locking templates not under test in this file.
      return locking;
    },
  };

  const deps = { txb, auth };

  const pool = {
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51',
    shards: [{ index: 0, txid: 'aa'.repeat(32), vout: 0, valueSats: '2000', commitmentHex: '11'.repeat(32) }],
  };

  const p2pkhSpk = hexToBytes('76a914' + '11'.repeat(20) + '88ac');

  const shardPrevout = { txid: 'aa'.repeat(32), vout: 0, valueSats: 2000n, scriptPubKey: u8(10) };
  const depositPrevout = { txid: 'bb'.repeat(32), vout: 7, valueSats: 50_000n, scriptPubKey: p2pkhSpk };

  const depositWallet = { signPrivBytes: u8(32, 0xd2) };

  const imp = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    depositWallet,
    feeSats: 2000n,
    deps,
  });

  // Covenant input is NOT signed; it is shardUnlock bytes.
  const noteHash32 = outpointHash32(depositPrevout.txid, depositPrevout.vout);
  const proofBlob32 = makeProofBlobV11(noteHash32);
  const expectedUnlock = buildPoolHashFoldUnlockingBytecode({
    version: 'V1_1',
    limbs: [],
    noteHash32,
    proofBlob32,
  });

  assert.ok(imp.tx.inputs[0].scriptSig instanceof Uint8Array, 'covenant scriptSig must be bytes');
  assert.deepEqual(Buffer.from(imp.tx.inputs[0].scriptSig), Buffer.from(expectedUnlock));

  // Deposit input uses auth seam
  assert.ok(calls.some((c) => c.kind === 'p2pkh' && c.vin === 1), 'expected authorizeP2pkhInput(vin=1)');
  assert.ok(!calls.some((c) => c.kind === 'covenant'), 'expected no covenant auth calls');

  // Withdraw path: same idea for covenant input
  const feePrevout = { txid: 'cc'.repeat(32), vout: 0, valueSats: 10_000n, scriptPubKey: p2pkhSpk };
  const feeWallet = { signPrivBytes: u8(32, 0xe3), pubkeyHash160Hex: '11'.repeat(20) };

  const wd = withdrawFromShard({
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

  assert.ok(wd.tx.inputs[0].scriptSig instanceof Uint8Array, 'withdraw covenant scriptSig must be bytes');
  assert.ok(calls.some((c) => c.kind === 'p2pkh' && c.vin === 1), 'expected authorizeP2pkhInput(vin=1) for fee');
});