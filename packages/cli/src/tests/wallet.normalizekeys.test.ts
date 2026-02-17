import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeWalletKeys } from '../wallet/normalizeKeys.js';
import { deriveSpendPriv32FromScanPriv32 } from '@bch-stealth/rpa-derive';

function b32(x: number): Uint8Array {
  const a = new Uint8Array(32);
  a.fill(x & 0xff);
  return a;
}

test('normalizeWalletKeys: missing spend -> derived', () => {
  const priv = b32(1);
  const scan = b32(2);

  const nk = normalizeWalletKeys({ privBytes: priv, scanPrivBytes: scan, spendPrivBytes: null });

  assert.equal(nk.flags.scanFallbackToPriv, false);
  assert.equal(nk.flags.spendWasDerived, true);
  assert.equal(nk.flags.spendWasOverridden, false);

  const expected = deriveSpendPriv32FromScanPriv32(scan);
  assert.deepEqual(nk.spendPriv32, expected);
});

test('normalizeWalletKeys: mismatched spend -> overridden to derived', () => {
  const priv = b32(1);
  const scan = b32(2);
  const wrongSpend = b32(9);

  const nk = normalizeWalletKeys({ privBytes: priv, scanPrivBytes: scan, spendPrivBytes: wrongSpend });

  assert.equal(nk.flags.spendWasDerived, false);
  assert.equal(nk.flags.spendWasOverridden, true);

  const expected = deriveSpendPriv32FromScanPriv32(scan);
  assert.deepEqual(nk.spendPriv32, expected);
});

test('normalizeWalletKeys: matching spend -> ok', () => {
  const priv = b32(1);
  const scan = b32(2);
  const spend = deriveSpendPriv32FromScanPriv32(scan);

  const nk = normalizeWalletKeys({ privBytes: priv, scanPrivBytes: scan, spendPrivBytes: spend });

  assert.equal(nk.flags.spendWasDerived, false);
  assert.equal(nk.flags.spendWasOverridden, false);

  assert.deepEqual(nk.spendPriv32, spend);
});