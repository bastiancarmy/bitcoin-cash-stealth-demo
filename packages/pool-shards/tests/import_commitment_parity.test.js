// packages/pool-shards/tests/import_commitment_parity.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import vector from '../test-vectors/golden_commitment_v11.json' with { type: 'json' };

import { bytesToHex, hexToBytes } from '@bch-stealth/utils';
import { computePoolStateOut, POOL_HASH_FOLD_VERSION } from '@bch-stealth/pool-hash-fold';
import { importDepositToShard, outpointHash32, DEFAULT_CATEGORY_MODE } from '@bch-stealth/pool-shards';

function readVarInt(u8, offset) {
  const first = u8[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) return { value: u8[offset + 1] | (u8[offset + 2] << 8), size: 3 };
  if (first === 0xfe) {
    const v =
      (u8[offset + 1]) |
      (u8[offset + 2] << 8) |
      (u8[offset + 3] << 16) |
      (u8[offset + 4] << 24);
    return { value: v >>> 0, size: 5 };
  }
  const lo =
    (u8[offset + 1]) |
    (u8[offset + 2] << 8) |
    (u8[offset + 3] << 16) |
    (u8[offset + 4] << 24);
  const hi =
    (u8[offset + 5]) |
    (u8[offset + 6] << 8) |
    (u8[offset + 7] << 16) |
    (u8[offset + 8] << 24);
  return { value: hi * 2 ** 32 + (lo >>> 0), size: 9 };
}

// Minimal token prefix parse: expects 0xef || category32 || bitfield || varint(32) || commitment32 ...
function parseTokenCommitmentFromScriptPubKey(scriptPubKey) {
  assert.ok(scriptPubKey instanceof Uint8Array);
  assert.ok(scriptPubKey.length > 1 + 32 + 1 + 1 + 32, 'scriptPubKey too short for token prefix + commitment');

  assert.equal(scriptPubKey[0], 0xef, 'missing CashTokens prefix marker 0xef');
  let off = 1;

  const category32 = scriptPubKey.slice(off, off + 32);
  off += 32;

  const bitfield = scriptPubKey[off++];
  const hasCommitment = (bitfield & 0x40) !== 0;
  const hasNft = (bitfield & 0x20) !== 0;

  assert.ok(hasNft, 'expected HAS_NFT bit set');
  assert.ok(hasCommitment, 'expected HAS_COMMITMENT bit set');

  const { value: commitLen, size } = readVarInt(scriptPubKey, off);
  off += size;

  assert.equal(commitLen, 32, `expected commitment length varint=32, got ${commitLen}`);

  const commitment = scriptPubKey.slice(off, off + commitLen);
  assert.equal(commitment.length, 32, 'commitment slice must be 32 bytes');

  return { category32, bitfield, commitment };
}

test('parity: importDepositToShard output[0] token commitment equals computed stateOut32', () => {
  const category32 = hexToBytes(vector.category32Hex);
  const stateIn32 = hexToBytes(vector.stateIn32Hex);

  const depositTxidHex = vector.depositOutpoint.txidHex;
  const depositVout = vector.depositOutpoint.vout;

  const noteHash32 = outpointHash32(depositTxidHex, depositVout);

  // IMPORTANT: current Phase 2 import logic uses limbs = [] (no folding yet),
  // and passes noteHash32 separately.
  const limbs = [];

  const expectedStateOut32 = computePoolStateOut({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    stateIn32,
    category32,
    noteHash32,
    limbs,
    categoryMode: vector.categoryMode ?? DEFAULT_CATEGORY_MODE,
    capByte: Number.parseInt(vector.capByte.replace(/^0x/, ''), 16),
  });

  // Deterministic redeemScript; doesn't need to be "real" for parity check
  const redeemScriptHex = '51'; // OP_1

  const pool = {
    categoryHex: vector.category32Hex,
    redeemScriptHex,
    shards: [
      { valueSats: '2000', commitmentHex: vector.stateIn32Hex, txid: '<prev>', vout: 0, index: 0 },
    ],
  };

  // Deterministic scriptPubKeys (not required to match signing key for parity test)
  const p2pkhSpk = hexToBytes('76a914' + '11'.repeat(20) + '88ac');

  const shardPrevout = {
    txid: '00'.repeat(32),
    vout: 0,
    valueSats: 2000n,
    scriptPubKey: p2pkhSpk,
  };

  const depositPrevout = {
    txid: depositTxidHex,
    vout: depositVout,
    valueSats: 50_000n,
    scriptPubKey: p2pkhSpk,
  };

  const depositWallet = {
    // non-zero deterministic private key
    signPrivBytes: Uint8Array.from([1, ...new Array(31).fill(0)]),
  };

  const res = importDepositToShard({
    pool,
    shardIndex: 0,
    shardPrevout,
    depositPrevout,
    depositWallet,
    feeSats: 2000n,
    categoryMode: vector.categoryMode ?? DEFAULT_CATEGORY_MODE,
    amountCommitment: 0n,
  });

  assert.ok(res?.tx?.outputs?.length >= 1);

  const spk0 = res.tx.outputs[0].scriptPubKey;
  const parsed = parseTokenCommitmentFromScriptPubKey(spk0);

  assert.equal(bytesToHex(parsed.commitment), bytesToHex(expectedStateOut32));
  assert.equal(res.nextPoolState.shards[0].commitmentHex, bytesToHex(expectedStateOut32));
});