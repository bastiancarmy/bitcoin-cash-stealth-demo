// src/pool_hash_fold_script.js
import { bytesToHex } from '@bch-stealth/utils';
import { loadCasm } from './casm_loader.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

function moduleUrl() {
  // 1) If this is running as a CJS bundle (dist/*.cjs), __filename exists
  // eslint-disable-next-line no-undef
  if (typeof __filename !== 'undefined') return pathToFileURL(__filename).href;

  // 2) Otherwise (ESM runtime), avoid import.meta entirely:
  // assume cwd is repo root; point at the *source* module as base
  const guess = path.resolve(process.cwd(), 'src', 'pool_hash_fold_script.js');
  if (existsSync(guess)) return pathToFileURL(guess).href;

  // 3) Fallback: repo root as a directory URL
  return pathToFileURL(path.resolve(process.cwd()) + path.sep).href;
}

export const POOL_HASH_FOLD_VERSION = {
  V0: 'v0',
  V1: 'v1',
  V1_1: 'v1_1',
};

async function getLibauth() {
  if (!getLibauth._modulePromise) getLibauth._modulePromise = import('@bitauth/libauth');
  return getLibauth._modulePromise;
}

async function compileCasm(casmSource, label) {
  const { cashAssemblyToBin } = await getLibauth();
  const result = cashAssemblyToBin(casmSource);

  const bytecode =
    result instanceof Uint8Array
      ? result
      : (result &&
          typeof result === 'object' &&
          'success' in result &&
          result.success &&
          result.bytecode instanceof Uint8Array)
        ? result.bytecode
        : (result &&
            typeof result === 'object' &&
            'bytecode' in result &&
            result.bytecode instanceof Uint8Array)
          ? result.bytecode
          : null;

  if (!bytecode) {
    const msg =
      typeof result === 'string'
        ? result
        : (result && typeof result === 'object' && 'errors' in result)
          ? JSON.stringify(result.errors)
          : String(result);
    throw new Error(`${label} compilation failed: ${msg}`);
  }

  console.log(`[pool_hash_fold] Compiled ${label}:`, bytesToHex(bytecode));
  return bytecode;
}

let cachedV0 = null;
let cachedV1 = null;
let cachedV11 = null;

let cachedV0Src = null;
let cachedV1Src = null;
let cachedV11Src = null;
let cachedTemplateSrc = null;

async function getV0Src() {
  if (!cachedV0Src) cachedV0Src = await loadCasm(moduleUrl(), './cashassembly/pool_hash_fold_v0.casm');
  return cachedV0Src;
}
async function getV1Src() {
  if (!cachedV1Src) cachedV1Src = await loadCasm(moduleUrl(), './cashassembly/pool_hash_fold_v1.casm');
  return cachedV1Src;
}
async function getV11Src() {
  if (!cachedV11Src) cachedV11Src = await loadCasm(moduleUrl(), './cashassembly/pool_hash_fold_v1_1.casm');
  return cachedV11Src;
}
async function getTemplateSrc() {
  if (!cachedTemplateSrc) cachedTemplateSrc = await loadCasm(moduleUrl(), './cashassembly/state_cell_template_v1.casm');
  return cachedTemplateSrc;
}

export async function getPoolHashFoldBytecode(version = POOL_HASH_FOLD_VERSION.V1_1) {
  if (version === POOL_HASH_FOLD_VERSION.V0) {
    if (!cachedV0) cachedV0 = await compileCasm(await getV0Src(), 'pool_hash_fold_v0.casm');
    return cachedV0;
  }

  if (version === POOL_HASH_FOLD_VERSION.V1) {
    if (!cachedV1) cachedV1 = await compileCasm(await getV1Src(), 'pool_hash_fold_v1.casm');
    return cachedV1;
  }

  if (version === POOL_HASH_FOLD_VERSION.V1_1) {
    if (!cachedV11) {
      const combined = `${await getTemplateSrc()}\n\n${await getV11Src()}`;
      cachedV11 = await compileCasm(combined, 'pool_hash_fold_v1_1 (with state_cell_template_v1)');
    }
    return cachedV11;
  }

  throw new Error(`Unknown pool_hash_fold version: ${version}`);
}