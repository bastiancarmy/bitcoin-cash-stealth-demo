// packages/pool-shards/tests/commitment_transition_v11.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import vector from '../test-vectors/golden_commitment_v11.json' with { type: 'json' };

import { hexToBytes, bytesToHex } from '@bch-stealth/utils';
import { computePoolStateOut, POOL_HASH_FOLD_VERSION } from '@bch-stealth/pool-hash-fold';

test('golden: v1.1 commitment transition matches expected stateOut32', () => {
  const stateIn32 = hexToBytes(vector.stateIn32Hex);
  const category32 = hexToBytes(vector.category32Hex);
  const noteHash32 = hexToBytes(vector.noteHash32Hex);
  const limbs = vector.limbsHex.map(hexToBytes);

  const stateOut32 = computePoolStateOut({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    stateIn32,
    category32,
    noteHash32,
    limbs,
    categoryMode: vector.categoryMode,
    capByte: Number.parseInt(vector.capByte.replace(/^0x/, ''), 16),
  });

  assert.equal(bytesToHex(stateOut32), vector.expectedStateOut32Hex);
});