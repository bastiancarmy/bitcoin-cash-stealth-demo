// packages/pool-hash-fold/src/pool_hash_fold_script.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bytesToHex } from '@bch-stealth/utils';

export const POOL_HASH_FOLD_VERSION = {
  V0: 'v0',
  V1: 'v1',
  V1_1: 'v1_1',
} as const;

export type PoolHashFoldVersion = (typeof POOL_HASH_FOLD_VERSION)[keyof typeof POOL_HASH_FOLD_VERSION];

async function getLibauth() {
  return import('@bitauth/libauth');
}

function readTextAsset(relFromThisFile: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));

  // Works in BOTH cases:
  // - running TS from src/: here=.../src
  // - running built JS from dist/: here=.../dist
  const candidates = [
    path.join(here, relFromThisFile),                           // src/cashassembly/* OR dist/cashassembly/*
    path.join(here, '..', 'src', relFromThisFile),              // dist -> src fallback
  ];

  for (const abs of candidates) {
    if (fs.existsSync(abs)) return fs.readFileSync(abs, 'utf8');
  }

  throw new Error(
    `pool-hash-fold: missing cashassembly asset.\n` +
      `Tried:\n` +
      candidates.map((c) => `  - ${c}`).join('\n')
  );
}

async function compileCasm(src: string, label: string): Promise<Uint8Array> {
  const { cashAssemblyToBin } = await getLibauth();
  const r = cashAssemblyToBin(src);

  if (!(r instanceof Uint8Array)) {
    console.error(`❌ Error compiling ${label}`);
    console.error(r);
    throw new Error(`${label} compilation failed`);
  }

  // optional
  // console.log(`[pool-hash-fold] compiled ${label}: ${bytesToHex(r)}`);
  return r;
}

let cachedV0: Uint8Array | null = null;
let cachedV1: Uint8Array | null = null;
let cachedV11: Uint8Array | null = null;

export async function getPoolHashFoldBytecode(
  version: PoolHashFoldVersion | string = POOL_HASH_FOLD_VERSION.V1_1
): Promise<Uint8Array> {
  const v = String(version);

  if (v === POOL_HASH_FOLD_VERSION.V0 || v === 'V0') {
    if (!cachedV0) {
      const v0Casm = readTextAsset('cashassembly/pool_hash_fold_v0.casm');
      cachedV0 = await compileCasm(v0Casm, 'pool_hash_fold_v0.casm');
    }
    return cachedV0;
  }

  if (v === POOL_HASH_FOLD_VERSION.V1 || v === 'V1') {
    if (!cachedV1) {
      const v1Casm = readTextAsset('cashassembly/pool_hash_fold_v1.casm');
      cachedV1 = await compileCasm(v1Casm, 'pool_hash_fold_v1.casm');
    }
    return cachedV1;
  }

  if (v === POOL_HASH_FOLD_VERSION.V1_1 || v === 'V1_1' || v === 'v1.1') {
    if (!cachedV11) {
      const template = readTextAsset('cashassembly/state_cell_template_v1.casm');
      const v11 = readTextAsset('cashassembly/pool_hash_fold_v1_1.casm');
      cachedV11 = await compileCasm(`${template}\n\n${v11}`, 'pool_hash_fold_v1_1 (with template)');
    }
    return cachedV11;
  }

  throw new Error(`Unknown pool_hash_fold version: ${version}`);
}