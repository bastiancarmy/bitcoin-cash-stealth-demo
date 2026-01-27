// packages/cli/src/tests/wallet.init.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { walletJsonFromMnemonic } from '../wallets.js';

test('walletJsonFromMnemonic: deterministic keys', () => {
  const mnemonic = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
  const a = walletJsonFromMnemonic({ mnemonic, network: 'chipnet', birthdayHeight: 0 });
  const b = walletJsonFromMnemonic({ mnemonic, network: 'chipnet', birthdayHeight: 0 });

  assert.equal(a.privHex, b.privHex);
  assert.equal(a.scanPrivHex, b.scanPrivHex);
  assert.equal(a.spendPrivHex, b.spendPrivHex);

  assert.equal(a.privHex.length, 64);
  assert.equal(a.scanPrivHex.length, 64);
  assert.equal(a.spendPrivHex.length, 64);
});

test('walletJsonFromMnemonic: validates birthdayHeight', () => {
  assert.throws(
    () => walletJsonFromMnemonic({ mnemonic: 'one two three four five six seven eight', network: 'chipnet', birthdayHeight: -1 }),
    /birthdayHeight/i
  );
});