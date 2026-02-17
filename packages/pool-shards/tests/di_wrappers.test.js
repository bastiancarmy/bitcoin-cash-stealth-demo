// packages/pool-shards/tests/di_wrappers.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

test('package surface: no legacy wrappers export; core builders + DI utilities exist', async () => {
  const mod = await import('@bch-stealth/pool-shards');

  // Core builders
  assert.equal(typeof mod.initShardsTx, 'function');
  assert.equal(typeof mod.importDepositToShard, 'function');
  assert.equal(typeof mod.withdrawFromShard, 'function');

  // DI + templates
  assert.equal(typeof mod.makeDefaultAuthProvider, 'function');
  assert.equal(typeof mod.makeDefaultLockingTemplates, 'function');

  // No wrappers in current surface
  assert.equal(mod.wrappers, undefined);
});