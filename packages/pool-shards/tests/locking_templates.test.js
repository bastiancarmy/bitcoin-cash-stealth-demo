// packages/pool-shards/tests/locking_templates.test.js
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { initShardsTx } from '../dist/init.js';
import { importDepositToShard } from '../dist/import.js';
import { withdrawFromShard } from '../dist/withdraw.js';

function u8(n) {
  return new Uint8Array(n).fill(7);
}

function endsWithBytes(buf, suffix) {
  assert.ok(buf instanceof Uint8Array);
  assert.ok(suffix instanceof Uint8Array);
  assert.ok(buf.length >= suffix.length);
  const start = buf.length - suffix.length;
  for (let i = 0; i < suffix.length; i++) {
    if (buf[start + i] !== suffix[i]) return false;
  }
  return true;
}

test('builders use LockingTemplates; shardLock returns prefix||redeemScript (byte-for-byte suffix)', () => {
  const calls = [];
  const shardLockReturns = [];

  // tx-builder stub: forbid inline output assembly
  const txb = {
    buildRawTx() {
      return u8(200);
    },

    // initShardsTx still signs funding input directly
    signInput() {},

    // covenant signing intentionally disabled
    signCovenantInput() {
      throw new Error('signCovenantInput should not be called');
    },

    // These must never be called directly by builders anymore:
    addTokenToScript() {
      throw new Error('txb.addTokenToScript should not be called directly (must use deps.locking.shardLock)');
    },
    getP2PKHScript() {
      throw new Error('txb.getP2PKHScript should not be called directly (must use deps.locking.p2pkh)');
    },

    // Legacy fallback should not be necessary in bare covenant tests
    getP2SHScript() {
      throw new Error('txb.getP2SHScript should not be called in this test');
    },
  };

  // Locking templates are the *only* place output scripts get produced.
  const locking = {
    p2pkh(h160) {
      calls.push(['p2pkh', Buffer.from(h160).toString('hex')]);
      return u8(25);
    },

    shardLock({ token, redeemScript }) {
      calls.push(['shardLock', token, Buffer.from(redeemScript).toString('hex')]);

      // IMPORTANT:
      // We are testing “builders call shardLock”, not re-implementing token encoding.
      // Return a deterministic “prefix||redeemScript” byte array.
      const prefix = u8(10); // arbitrary non-empty prefix for this test
      const out = new Uint8Array(prefix.length + redeemScript.length);
      out.set(prefix, 0);
      out.set(redeemScript, prefix.length);

      shardLockReturns.push({ redeemScript, scriptPubKey: out });
      return out;
    },
  };

  const auth = {
    authorizeP2pkhInput() {},
    authorizeCovenantInput() {
      throw new Error('authorizeCovenantInput should not be called (covenant signing disabled)');
    },
  };

  const deps = { txb, auth, locking };

  // ---------- initShardsTx fixture ----------
  const cfg = {
    poolIdHex: '11'.repeat(20),
    poolVersion: 'demo',
    shardValueSats: '1000',
    defaultFeeSats: '500',
    network: 'chipnet',
    redeemScriptHex: '51', // OP_1
  };

  const funding = {
    txid: '22'.repeat(32),
    vout: 0,
    valueSats: 10_000n,
    scriptPubKey: u8(25),
  };

  const ownerWallet = {
    pubkeyHash160Hex: '33'.repeat(20),
    signPrivBytes: u8(32),
  };

  const initRes = initShardsTx({ cfg, shardCount: 2, funding, ownerWallet, deps });
  assert.ok(initRes?.tx?.outputs?.length >= 1);

  // ---------- importDepositToShard fixture ----------
  const pool = {
    poolIdHex: cfg.poolIdHex,
    poolVersion: cfg.poolVersion,
    shardCount: 1,
    network: cfg.network,
    categoryHex: '00'.repeat(32),
    redeemScriptHex: cfg.redeemScriptHex,
    shards: [
      { index: 0, txid: 'aa'.repeat(32), vout: 0, valueSats: '2000', commitmentHex: '00'.repeat(32) },
    ],
  };

  const shardPrevout = { txid: 'aa'.repeat(32), vout: 0, valueSats: 2000n, scriptPubKey: u8(10) };
  const depositPrevout = { txid: 'bb'.repeat(32), vout: 1, valueSats: 1500n, scriptPubKey: u8(25) };

  importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    depositWallet: { signPrivBytes: u8(32) },
    feeSats: 0n,
    deps,
  });

  // ---------- withdrawFromShard fixture ----------
  const feePrevout = { txid: 'cc'.repeat(32), vout: 2, valueSats: 10_000n, scriptPubKey: u8(25) };
  const shardPrevout2 = { txid: shardPrevout.txid, vout: shardPrevout.vout, valueSats: 50_000n, scriptPubKey: u8(10) };

  withdrawFromShard({
    pool,
    shardIndex: 0,
    shardPrevout: shardPrevout2,
    feePrevout,
    feeWallet: { signPrivBytes: u8(32), pubkeyHash160Hex: '55'.repeat(20) },
    receiverP2pkhHash160Hex: '66'.repeat(20),
    amountSats: 20_000n,
    feeSats: 1_000n,
    changeP2pkhHash160Hex: '77'.repeat(20),
    deps,
  });

  // --- Assertions: this is the *actual* goal of the test ---
  assert.ok(calls.some((c) => c[0] === 'p2pkh'), 'expected locking.p2pkh to be used');
  assert.ok(calls.some((c) => c[0] === 'shardLock'), 'expected locking.shardLock to be used');
  assert.ok(shardLockReturns.length > 0, 'expected shardLock to have been called at least once');

  // shardLock contract: returned scriptPubKey must end with redeemScript bytes, and contain a non-empty prefix
  for (const r of shardLockReturns) {
    assert.ok(r.scriptPubKey.length > r.redeemScript.length, 'expected a non-empty prefix before redeemScript');
    assert.ok(
      endsWithBytes(r.scriptPubKey, r.redeemScript),
      'expected shardLock return value to end with redeemScript bytes (byte-for-byte)',
    );
  }
});
