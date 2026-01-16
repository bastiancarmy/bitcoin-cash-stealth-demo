// packages/pool-shards/tests/shard_selection.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import vector from '../test-vectors/golden_commitment_v11.json' with { type: 'json' };

import { bytesToHex } from '@bch-stealth/utils';
import { outpointHash32, selectShardIndex } from '@bch-stealth/pool-shards';

test('stability: outpointHash32 + selectShardIndex match fixture', () => {
  const {
    txidHex,
    vout,
    shardCount,
    expectedOutpointHash32Hex,
    expectedShardIndex,
  } = vector.shardSelection;

  const h = outpointHash32(txidHex, vout);
  assert.equal(bytesToHex(h), expectedOutpointHash32Hex);

  const idx = selectShardIndex({
    depositTxidHex: txidHex,
    depositVout: vout,
    shardCount,
  });
  assert.equal(idx, expectedShardIndex);
});