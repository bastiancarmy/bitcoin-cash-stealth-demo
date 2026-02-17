import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bytesToHex, hexToBytes } from '@bch-stealth/utils';
import { computePoolStateOut } from '../index.js'; // adjust if computePoolStateOut is exported elsewhere

type Fixture = {
  name: string;
  version: 'v1_1';
  category32Hex: string;
  stateIn32Hex: string;
  noteHash32Hex: string;
  expectedStateOut32Hex: string;
  categoryMode: 'reverse' | 'direct';
  capByteHex: string; // 1 byte hex (e.g. "01")
  notes?: string;
};

function distDir(): string {
  return path.dirname(fileURLToPath(import.meta.url)); // .../dist/tests
}

function readFixturesFromSrc(): Fixture[] {
  // When compiled, this test runs from dist/tests; fixtures live in src/fixtures.
  const abs = path.resolve(distDir(), '..', '..', 'src', 'fixtures', 'stateout32.v1_1.json');
  const raw = fs.readFileSync(abs, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('fixtures must be an array');
  return parsed as Fixture[];
}

function assertLenHex(hex: string, bytes: number, label: string) {
  const expectedLen = bytes * 2;
  assert.equal(
    hex.length,
    expectedLen,
    `${label} must be ${bytes} bytes (${expectedLen} hex chars), got ${hex.length}`
  );
  assert.ok(/^[0-9a-f]+$/i.test(hex), `${label} must be hex`);
}

function assertNoPlaceholders(fx: Fixture) {
  const fields: Array<[string, string]> = [
    ['category32Hex', fx.category32Hex],
    ['stateIn32Hex', fx.stateIn32Hex],
    ['noteHash32Hex', fx.noteHash32Hex],
    ['expectedStateOut32Hex', fx.expectedStateOut32Hex],
    ['capByteHex', fx.capByteHex],
  ];

  for (const [k, v] of fields) {
    assert.ok(typeof v === 'string' && v.length > 0, `fixture "${fx.name}" missing ${k}`);
    assert.ok(!v.includes('REPLACE_ME'), `fixture "${fx.name}" still has placeholder in ${k}`);
  }
}

test('pool-hash-fold: stateOut32 fixtures match computePoolStateOut (v1.1)', () => {
  const fixtures = readFixturesFromSrc();
  assert.ok(fixtures.length >= 1, 'expected at least 1 fixture');

  for (const fx of fixtures) {
    assertNoPlaceholders(fx);

    assertLenHex(fx.category32Hex, 32, `${fx.name}.category32Hex`);
    assertLenHex(fx.stateIn32Hex, 32, `${fx.name}.stateIn32Hex`);
    assertLenHex(fx.noteHash32Hex, 32, `${fx.name}.noteHash32Hex`);
    assertLenHex(fx.expectedStateOut32Hex, 32, `${fx.name}.expectedStateOut32Hex`);
    assertLenHex(fx.capByteHex, 1, `${fx.name}.capByteHex`);

    const category32 = hexToBytes(fx.category32Hex);
    const stateIn32 = hexToBytes(fx.stateIn32Hex);
    const noteHash32 = hexToBytes(fx.noteHash32Hex);
    const capByte = hexToBytes(fx.capByteHex)[0]!;

    const stateOut32 = computePoolStateOut({
      version: fx.version,
      category32,
      stateIn32,
      noteHash32,
      limbs: [],
      categoryMode: fx.categoryMode,
      capByte,
    });

    const got = bytesToHex(stateOut32).toLowerCase();
    const expected = fx.expectedStateOut32Hex.toLowerCase();

    assert.equal(
      got,
      expected,
      [
        `stateOut32 mismatch for fixture "${fx.name}"`,
        `  got:      ${got}`,
        `  expected: ${expected}`,
        `  version=${fx.version} categoryMode=${fx.categoryMode} capByte=${fx.capByteHex}`,
      ].join('\n')
    );
  }
});
