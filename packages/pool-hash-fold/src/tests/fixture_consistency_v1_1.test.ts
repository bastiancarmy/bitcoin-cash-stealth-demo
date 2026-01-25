import test from 'node:test';
import assert from 'node:assert/strict';

import stateOutFixtures from '../fixtures/stateout32.v1_1.json' with { type: 'json' };
import importSnaps from '../fixtures/import_snapshots.v1_1.json' with { type: 'json' };

import { hexToBytes, bytesToHex } from '@bch-stealth/utils';
import { parseScriptPushes } from '@bch-stealth/pool-shards';

type StateOutFixture = {
  name: string;
  category32Hex: string;
  noteHash32Hex: string;
  expectedStateOut32Hex: string;
};

type ImportSnapshot = {
  name: string;
  stateCategory32Hex: string;
  covenantVinScriptSigHex: string;
  output0NftCommitment32Hex: string;
};

function byName<T extends { name: string }>(arr: readonly T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const x of arr) m.set(x.name, x);
  return m;
}

function assertHexLen(hex: string, bytes: number, label: string): void {
  assert.equal(
    hex.length,
    bytes * 2,
    `${label} must be ${bytes} bytes (${bytes * 2} hex chars), got ${hex.length}`
  );
  assert.ok(/^[0-9a-f]+$/i.test(hex), `${label} must be hex`);
}

test('fixtures: v1.1 import snapshots are consistent with stateOut32 fixtures', () => {
  const fixtures = stateOutFixtures as unknown as StateOutFixture[];
  const snaps = importSnaps as unknown as ImportSnapshot[];

  assert.ok(Array.isArray(fixtures) && fixtures.length > 0, 'expected at least 1 stateOut fixture');
  assert.ok(Array.isArray(snaps) && snaps.length > 0, 'expected at least 1 import snapshot');

  // const fxBy = byName(fixtures);

  const fxByExpectedOut = new Map<string, StateOutFixture>();
  for (const fx of fixtures) fxByExpectedOut.set(fx.expectedStateOut32Hex.toLowerCase(), fx);

  for (const snap of snaps) {
    const fx = fxByExpectedOut.get(snap.output0NftCommitment32Hex.toLowerCase());
    assert.ok(
      fx,
      `snapshot "${snap.name}" has no matching stateOut fixture by name\n` +
        `Add a fixture with name="${snap.name}" or rename one side to match.`
    );

    // ---- basic lengths (catch copy/paste / byte-order accidents) ----
    assertHexLen(snap.stateCategory32Hex, 32, `${snap.name}.stateCategory32Hex`);
    assertHexLen(snap.output0NftCommitment32Hex, 32, `${snap.name}.output0NftCommitment32Hex`);
    assert.ok(
      /^[0-9a-f]+$/i.test(snap.covenantVinScriptSigHex),
      `${snap.name}.covenantVinScriptSigHex must be hex`
    );

    assertHexLen(fx.category32Hex, 32, `${snap.name}.fixture.category32Hex`);
    assertHexLen(fx.noteHash32Hex, 32, `${snap.name}.fixture.noteHash32Hex`);
    assertHexLen(fx.expectedStateOut32Hex, 32, `${snap.name}.fixture.expectedStateOut32Hex`);

    // (1) noteHash32Hex equals pushes[0] from parsing vin[0].scriptSig.hex
    const scriptSigBytes = hexToBytes(snap.covenantVinScriptSigHex);
    const { pushes } = parseScriptPushes(scriptSigBytes);

    assert.equal(
      pushes.length,
      2,
      `snapshot "${snap.name}" covenant scriptSig must be [noteHash32][proofBlob32] (2 pushes), got ${pushes.length}`
    );
    assert.equal(pushes[0].length, 32, `snapshot "${snap.name}" push[0] must be 32 bytes`);
    assert.equal(pushes[1].length, 32, `snapshot "${snap.name}" push[1] must be 32 bytes`);

    const noteHashFromScriptSig = bytesToHex(pushes[0]).toLowerCase();
    assert.equal(
      noteHashFromScriptSig,
      fx.noteHash32Hex.toLowerCase(),
      [
        `noteHash mismatch for "${snap.name}"`,
        `  from scriptSig push[0]:      ${noteHashFromScriptSig}`,
        `  from fixture.noteHash32Hex:  ${fx.noteHash32Hex.toLowerCase()}`
      ].join('\n')
    );

    // (2) expectedStateOut32Hex equals output token commitment from the import tx
    assert.equal(
      fx.expectedStateOut32Hex.toLowerCase(),
      snap.output0NftCommitment32Hex.toLowerCase(),
      [
        `expectedStateOut mismatch for "${snap.name}"`,
        `  fixture.expectedStateOut32Hex: ${fx.expectedStateOut32Hex.toLowerCase()}`,
        `  importTx output0 commitment:    ${snap.output0NftCommitment32Hex.toLowerCase()}`
      ].join('\n')
    );

    // (3) category32Hex equals the state’s categoryHex
    assert.equal(
      fx.category32Hex.toLowerCase(),
      snap.stateCategory32Hex.toLowerCase(),
      [
        `category mismatch for "${snap.name}"`,
        `  fixture.category32Hex: ${fx.category32Hex.toLowerCase()}`,
        `  state.categoryHex:     ${snap.stateCategory32Hex.toLowerCase()}`
      ].join('\n')
    );
  }
});
