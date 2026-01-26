import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveProfilePaths } from '../paths.js';

test('profile paths: alice and bob are separated', () => {
  const cwd = '/repo';

  const a = resolveProfilePaths({ cwd, profile: 'alice' });
  const b = resolveProfilePaths({ cwd, profile: 'bob' });

  assert.notEqual(a.profileDir, b.profileDir);
  assert.equal(a.profileDir, path.resolve(cwd, '.bch-stealth', 'profiles', 'alice'));
  assert.equal(b.profileDir, path.resolve(cwd, '.bch-stealth', 'profiles', 'bob'));

  assert.equal(a.walletFile, path.resolve(a.profileDir, 'wallet.json'));
  assert.equal(a.stateFile, path.resolve(a.profileDir, 'state.json'));
  assert.equal(a.logFile, path.resolve(a.profileDir, 'events.ndjson'));
});

test('--state-file override wins over profile default', () => {
  const cwd = '/repo';

  const p = resolveProfilePaths({
    cwd,
    profile: 'alice',
    stateOverride: './custom/state.json',
  });

  assert.equal(p.stateFile, path.resolve(cwd, './custom/state.json'));
});

test('--wallet override wins over profile default', () => {
  const cwd = '/repo';

  const p = resolveProfilePaths({
    cwd,
    profile: 'alice',
    walletOverride: './custom/wallet.json',
  });

  assert.equal(p.walletFile, path.resolve(cwd, './custom/wallet.json'));
});