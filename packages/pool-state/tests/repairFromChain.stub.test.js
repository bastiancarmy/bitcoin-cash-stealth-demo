// packages/pool-state/tests/repairFromChain.stub.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

import { repairFromChain } from '../dist/index.js';

function assertDiagnosticsSpine(d) {
  assert.equal(typeof d, 'object');
  assert.ok(d !== null);

  assert.equal(typeof d.status, 'string');
  assert.equal(typeof d.message, 'string');
  assert.equal(typeof d.version, 'number');
  assert.equal(typeof d.timestamp, 'string');
  assert.ok(Number.isFinite(Date.parse(d.timestamp)));

  assert.equal(typeof d.received, 'object');
  assert.ok(d.received !== null);

  assert.equal(typeof d.received.hasElectrumIO, 'boolean');
  assert.equal(typeof d.received.hasWalletsOrPaycodes, 'boolean');
  assert.equal(typeof d.received.walletsOrPaycodesType, 'string');
  assert.equal(typeof d.received.scanWindowProvided, 'boolean');
}

test('repairFromChain returns stub diagnostics when required fields are missing', async () => {
  const res = await repairFromChain(/** @type {any} */ ({}));

  assert.equal(res.repairedState, null);
  assertDiagnosticsSpine(res.diagnostics);

  assert.equal(res.diagnostics.status, 'stub');
  assert.equal(res.diagnostics.version, 1);
  assert.equal(res.diagnostics.received.hasElectrumIO, false);
  assert.equal(res.diagnostics.received.hasWalletsOrPaycodes, false);
});

test('repairFromChain returns stub diagnostics when required fields are present', async () => {
  const res = await repairFromChain({
    electrumIO: {},
    walletsOrPaycodes: [],
  });

  assert.equal(res.repairedState, null);
  assertDiagnosticsSpine(res.diagnostics);

  assert.equal(res.diagnostics.status, 'stub');
  assert.equal(res.diagnostics.version, 1);
  assert.equal(res.diagnostics.received.scanWindowProvided, false);
  assert.equal(res.diagnostics.received.walletsOrPaycodesType, 'object');
});

test('repairFromChain reports scanWindowProvided when scanWindow is present', async () => {
  const res = await repairFromChain({
    electrumIO: {},
    walletsOrPaycodes: [],
    scanWindow: { fromHeight: 0 },
  });

  assert.equal(res.repairedState, null);
  assertDiagnosticsSpine(res.diagnostics);

  assert.equal(res.diagnostics.received.scanWindowProvided, true);
});