// packages/pool-shards/tests/covenant_pushparse_v11.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { hexToBytes } from '@bch-stealth/utils';

import {
  parseScriptPushes,
  validatePoolHashFoldV11UnlockScriptSig,
  importDepositToShard,
} from '@bch-stealth/pool-shards';

function u8(n, b = 1) {
  return new Uint8Array(n).fill(b);
}

test('parseScriptPushes: OP_0 + direct pushes', () => {
  const script = Uint8Array.from([
    0x00,       // OP_0 => empty push
    0x01, 0xaa, // push 1
    0x02, 0xbb, 0xcc, // push 2
  ]);

  const { pushes } = parseScriptPushes(script);
  assert.equal(pushes.length, 3);
  assert.equal(pushes[0].length, 0);
  assert.deepEqual(Array.from(pushes[1]), [0xaa]);
  assert.deepEqual(Array.from(pushes[2]), [0xbb, 0xcc]);
});

test('parseScriptPushes: PUSHDATA1', () => {
  const data = Uint8Array.from([1, 2, 3, 4, 5]);
  const script = Uint8Array.from([0x4c, data.length, ...data]);
  const { pushes } = parseScriptPushes(script);
  assert.equal(pushes.length, 1);
  assert.deepEqual(Array.from(pushes[0]), Array.from(data));
});

test('parseScriptPushes: PUSHDATA2', () => {
  const data = u8(300, 0x5a);
  const len = data.length;
  const script = Uint8Array.from([0x4d, len & 0xff, (len >> 8) & 0xff, ...data]);
  const { pushes } = parseScriptPushes(script);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].length, 300);
  assert.equal(pushes[0][0], 0x5a);
  assert.equal(pushes[0][299], 0x5a);
});

test('parseScriptPushes: rejects non-push opcode by default', () => {
  const script = Uint8Array.from([0x76]); // OP_DUP
  assert.throws(() => parseScriptPushes(script), /unexpected non-push opcode/i);
});

test('parseScriptPushes: truncated direct push throws', () => {
  const script = Uint8Array.from([0x02, 0xaa]); // says 2 bytes, only 1 provided
  assert.throws(() => parseScriptPushes(script), /truncated direct push/i);
});

test('validator: Phase 2 import covenant scriptSig is exactly 2 pushes of 32 bytes', () => {
  const calls = [];

  const auth = {
    authorizeP2pkhInput({ vin }) {
      calls.push({ vin });
    },
    authorizeCovenantInput() {
      throw new Error('authorizeCovenantInput should not be called (Phase 2 bare covenant)');
    },
  };

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
    addTokenToScript(_t, locking) {
      return locking;
    },
  };

  const locking = {
    p2pkh(_h160) {
      return u8(25, 0x51);
    },
    shardLock({ redeemScript }) {
      // deterministic prefix||redeemScript
      const prefix = u8(10, 0xef);
      const out = new Uint8Array(prefix.length + redeemScript.length);
      out.set(prefix, 0);
      out.set(redeemScript, prefix.length);
      return out;
    },
  };

  const deps = { txb, auth, locking };

  const pool = {
    categoryHex: '00'.repeat(32),
    redeemScriptHex: '51',
    shards: [{ index: 0, txid: 'aa'.repeat(32), vout: 0, valueSats: '2000', commitmentHex: '11'.repeat(32) }],
  };

  const p2pkhSpk = hexToBytes('76a914' + '11'.repeat(20) + '88ac');

  const shardPrevout = { txid: 'aa'.repeat(32), vout: 0, valueSats: 2000n, scriptPubKey: u8(10) };
  const depositPrevout = { txid: 'bb'.repeat(32), vout: 1, valueSats: 50_000n, scriptPubKey: p2pkhSpk };

  const r = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    depositWallet: { signPrivBytes: u8(32, 0xd1) },
    deps,
  });

  const scriptSig = r.tx.inputs[0].scriptSig;
  assert.ok(scriptSig instanceof Uint8Array);

  const { pushes } = parseScriptPushes(scriptSig);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].length, 32);
  assert.equal(pushes[1].length, 32);

  // Should not throw
  validatePoolHashFoldV11UnlockScriptSig(scriptSig);
});