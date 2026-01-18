import { strict as assert } from 'node:assert';
import test from 'node:test';

import { initShardsTx } from '../dist/init.js';
import { importDepositToShard } from '../dist/import.js';
import { withdrawFromShard } from '../dist/withdraw.js';

function u8(n) {
  return new Uint8Array(n).fill(7);
}

test('builders use LockingTemplates (no inline output script assembly)', () => {
  const calls = [];

  const locking = {
    p2pkh(h160) {
      calls.push(['p2pkh', Buffer.from(h160).toString('hex')]);
      return u8(25);
    },
    shardLock({ token, redeemScript }) {
      calls.push(['shardLock', token, Buffer.from(redeemScript).toString('hex')]);
      return u8(35);
    },
  };

  // tx-builder stub:
  // - allow getP2SHScript/hash160 fallback paths (builders still use this for prevout fallback)
  // - forbid inline output creation paths (those must go through locking templates)
  const txb = {
    buildRawTx() {
      // builders call this to compute sizeBytes; any bytes is fine for this test
      return u8(200);
    },

    // initShardsTx still signs funding input directly (not via auth provider), so allow no-op
    signInput() {},

    // import/withdraw use auth provider, so this shouldn't be called here; keep it a guard
    signCovenantInput() {
      throw new Error('signCovenantInput should not be called directly (use deps.auth)');
    },

    // inline output assembly should not be called in builders anymore
    addTokenToScript() {
      throw new Error('inline addTokenToScript not allowed (must use deps.locking.shardLock)');
    },
    getP2PKHScript() {
      throw new Error('inline getP2PKHScript not allowed (must use deps.locking.p2pkh)');
    },

    // allowed: only used for covenant prevout fallback in import/withdraw
    getP2SHScript(scriptHash20) {
      assert.equal(scriptHash20?.length, 20);
      return u8(23);
    },
  };

  // auth stub: builders will call these, but we don't need them to do anything
  const auth = {
    authorizeP2pkhInput() {},
    authorizeCovenantInput() {},
  };

  const deps = { txb, auth, locking };

  // ---------- initShardsTx fixture ----------
  const cfg = {
    poolIdHex: '11'.repeat(20),
    poolVersion: 'demo',
    shardValueSats: '1000',
    defaultFeeSats: '500',
    network: 'chipnet',
    redeemScriptHex: '51', // OP_1 (valid minimal script bytes)
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

  initShardsTx({ cfg, shardCount: 2, funding, ownerWallet, deps });

  // ---------- importDepositToShard fixture ----------
  const pool = {
    poolIdHex: cfg.poolIdHex,
    poolVersion: cfg.poolVersion,
    shardCount: 1,
    network: cfg.network,
    categoryHex: '00'.repeat(32),
    redeemScriptHex: cfg.redeemScriptHex,
    shards: [
      {
        index: 0,
        txid: 'aa'.repeat(32),
        vout: 0,
        valueSats: '2000',
        commitmentHex: '00'.repeat(32),
      },
    ],
  };

  const shardPrevout = {
    txid: 'aa'.repeat(32),
    vout: 0,
    valueSats: 2000n,
    // leave scriptPubKey undefined so the fallback path is exercised (uses txb.getP2SHScript)
    scriptPubKey: undefined,
  };

  const depositPrevout = {
    txid: 'bb'.repeat(32),
    vout: 1,
    valueSats: 1500n,
    scriptPubKey: u8(25),
  };

  importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    covenantWallet: { signPrivBytes: u8(32) },
    depositWallet: { signPrivBytes: u8(32) },
    feeSats: 0,
    deps,
  });

  // ---------- withdrawFromShard fixture ----------
  // Choose values safely above any reasonable dust threshold.
  // Requirements:
  // - payment >= DUST_SATS
  // - newShardValue = shardValueIn - payment >= DUST_SATS
  // - changeValue = feeValue - fee >= DUST_SATS
  const feePrevout = {
    txid: 'cc'.repeat(32),
    vout: 2,
    valueSats: 10_000n,
    scriptPubKey: u8(25),
  };

  // Make shard big enough to leave remainder above dust after payment
  const shardPrevout2 = {
    txid: shardPrevout.txid,
    vout: shardPrevout.vout,
    valueSats: 50_000n,
    scriptPubKey: undefined, // exercise fallback p2shSpk path
  };

  withdrawFromShard({
    pool,
    shardIndex: 0,
    shardPrevout: shardPrevout2,
    feePrevout,
    covenantWallet: { signPrivBytes: u8(32), pubkeyHash160Hex: '44'.repeat(20) },
    feeWallet: { signPrivBytes: u8(32), pubkeyHash160Hex: '55'.repeat(20) },
    receiverP2pkhHash160Hex: '66'.repeat(20),

    // comfortably above dust; remainder also above dust
    amountSats: 20_000,

    // fee + change both above dust with feePrevout=10k and fee=1k => change=9k
    feeSats: 1_000,

    changeP2pkhHash160Hex: '77'.repeat(20),
    deps,
  });

  // Ensure locking was used
  assert.ok(calls.length > 0);

  // Ensure we exercised both calls at least once
  assert.ok(calls.some((c) => c[0] === 'p2pkh'));
  assert.ok(calls.some((c) => c[0] === 'shardLock'));
});