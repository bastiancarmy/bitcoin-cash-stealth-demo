// packages/pool-shards/scripts/gen_b3c_vectors.mjs
import { bytesToHex, hexToBytes } from '@bch-stealth/utils';
import { computePoolStateOut, POOL_HASH_FOLD_VERSION } from '@bch-stealth/pool-hash-fold';
import { outpointHash32, DEFAULT_CATEGORY_MODE, DEFAULT_CAP_BYTE } from '../dist/policy.js'; 
// If you run from TS source instead, adjust import to ../src/policy.js depending on your build setup.

const category32Hex = '11'.repeat(32);
const stateIn32Hex = '01'.repeat(32);

const depositTxidHex = 'aa'.repeat(32);
const depositVout = 5;
const shardCount = 8;

const category32 = hexToBytes(category32Hex);
const stateIn32 = hexToBytes(stateIn32Hex);

const noteHash32 = outpointHash32(depositTxidHex, depositVout);
const limbs = [noteHash32];

const stateOut32 = computePoolStateOut({
  version: POOL_HASH_FOLD_VERSION.V1_1,
  stateIn32,
  category32,
  noteHash32,
  limbs,
  categoryMode: DEFAULT_CATEGORY_MODE,
  capByte: DEFAULT_CAP_BYTE,
});

const expectedOutpointHash32Hex = bytesToHex(noteHash32);
const expectedShardIndex = noteHash32[0] % shardCount;

const vector = {
  name: 'golden_commitment_v11_vector_0',
  version: 'V1_1',
  categoryMode: DEFAULT_CATEGORY_MODE,
  capByte: `0x${DEFAULT_CAP_BYTE.toString(16).padStart(2, '0')}`,
  stateIn32Hex,
  category32Hex,
  depositOutpoint: { txidHex: depositTxidHex, vout: depositVout },
  noteHash32Hex: bytesToHex(noteHash32),
  limbsHex: limbs.map(bytesToHex),
  expectedStateOut32Hex: bytesToHex(stateOut32),
  shardSelection: {
    txidHex: depositTxidHex,
    vout: depositVout,
    shardCount,
    expectedOutpointHash32Hex,
    expectedShardIndex,
  },
};

process.stdout.write(JSON.stringify(vector, null, 2) + '\n');