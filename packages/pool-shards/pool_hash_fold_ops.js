// src/pool_hash_fold_ops.js
//
// Canonical JS helpers aligned to pool_hash_fold_v1_1.casm (and legacy v0/v1).
//
// v1.1 unlocking stack (in this exact order):
//   limbs... , noteHash32 , proofBlob32
// Script behavior:
//   - main program checks proofBlob32 is 32 bytes, drops it
//   - template runStateCell sets up alt stack and calls computeStateOut (0x14)
//   - computeStateOut expects main: [ limbs... noteHash32 ] and uses prehash chain + LIFO limb fold
//
// IMPORTANT: v1.1 hash uses:
//   inCatCap33 = (REVERSEBYTES(category32) OR category32) || 0x01
// Depending on how your template normalizes category, try both modes.
// Default is "reverse" per the v1.1 casm header comment you pasted.

import {
  sha256,
  concat,
  reverseBytes,
  pushDataPrefix,
  minimalScriptNumber,
} from './utils.js';

import { POOL_HASH_FOLD_VERSION } from './pool_hash_fold_script.js';

function assertLen(u8, n, label) {
  if (!(u8 instanceof Uint8Array) || u8.length !== n) {
    throw new Error(`${label} must be Uint8Array(${n})`);
  }
}

function hash256(u8) {
  return sha256(sha256(u8));
}

// Minimal script-number pushes for 0..16
function opSmallInt(n) {
  if (n === 0) return Uint8Array.of(0x00); // OP_0
  if (n >= 1 && n <= 16) return Uint8Array.of(0x50 + n); // OP_1..OP_16
  throw new Error(`opSmallInt: out of range (${n})`);
}

/**
 * Encode a limb as it will appear on the stack for OP_CAT:
 * - number 0..16 => OP_n (pushes minimal script-number encoding)
 * - number >16   => push minimalScriptNumber bytes
 * - Uint8Array   => push raw bytes
 */
function encodeLimbPush(limb) {
  if (typeof limb === 'number') {
    if (!Number.isInteger(limb) || limb < 0) throw new Error('limb number must be a non-negative integer');

    if (limb >= 0 && limb <= 16) return opSmallInt(limb);

    const b = minimalScriptNumber(BigInt(limb));
    return concat(pushDataPrefix(b.length), b);
  }

  if (limb instanceof Uint8Array) {
    return concat(pushDataPrefix(limb.length), limb);
  }

  throw new Error('unsupported limb type (must be number or Uint8Array)');
}

function limbToBytesForHash(limb) {
  if (typeof limb === 'number') {
    if (!Number.isInteger(limb) || limb < 0 || limb > 255) {
      throw new Error('number limb must fit in 1 byte (0..255) for these demos');
    }
    return Uint8Array.of(limb);
  }
  if (limb instanceof Uint8Array) return limb;
  throw new Error('unsupported limb type (must be number or Uint8Array)');
}

/**
 * v1.1 proof blob (content is currently NOT used by the covenant; only length-checked+dropped).
 * Still helpful to keep deterministic.
 *
 * Default matches the earlier demo pattern: sha256( [tagByte] || noteHash32 )
 */
export function makeProofBlobV11(noteHash32, tagByte = 0x50) {
  assertLen(noteHash32, 32, 'noteHash32');
  if (!Number.isInteger(tagByte) || tagByte < 0 || tagByte > 255) throw new Error('tagByte must be 0..255');
  return sha256(concat(Uint8Array.of(tagByte), noteHash32));
}

/**
 * Compute state_out for:
 * - v0/v1: acc = fold(oldCommit, limbs...) where fold is LIFO: acc=H(acc||limb)
 * - v1.1: prehash chain then LIFO fold limbs:
 *
 *   inCatCap33 = (categoryNormalized32) || 0x01
 *   h0 = H(state_in || state_in)
 *   h1 = H(h0 || state_in)
 *   h2 = H(h1 || inCatCap33)
 *   h3 = H(h2 || noteHash32)
 *   acc = h3
 *   for limb = top..bottom: acc = H(acc || limbBytes)
 */
export function computePoolStateOut({
  version = POOL_HASH_FOLD_VERSION.V1_1,
  // common:
  stateIn32,
  category32,
  limbs = [],
  // v1.1:
  noteHash32,
  categoryMode = 'reverse', // 'reverse' (default) or 'none'
  capByte = 0x01,
  // v0-only:
  oldCommit32,
} = {}) {
  if (version === POOL_HASH_FOLD_VERSION.V0) {
    // legacy: oldCommit provided explicitly
    const acc0 = oldCommit32 ?? stateIn32;
    assertLen(acc0, 32, 'oldCommit32/stateIn32');
    let acc = acc0;
    for (let i = limbs.length - 1; i >= 0; i--) {
      const limbBytes = limbToBytesForHash(limbs[i]);
      acc = hash256(concat(acc, limbBytes));
    }
    return acc;
  }

  if (version === POOL_HASH_FOLD_VERSION.V1) {
    // legacy: fold starting from stateIn32 (which caller should set to NFT commitment)
    assertLen(stateIn32, 32, 'stateIn32');
    let acc = stateIn32;
    for (let i = limbs.length - 1; i >= 0; i--) {
      const limbBytes = limbToBytesForHash(limbs[i]);
      acc = hash256(concat(acc, limbBytes));
    }
    return acc;
  }

  if (version === POOL_HASH_FOLD_VERSION.V1_1) {
    assertLen(stateIn32, 32, 'stateIn32');
    assertLen(category32, 32, 'category32');
    assertLen(noteHash32, 32, 'noteHash32');

    if (!Number.isInteger(capByte) || capByte < 0 || capByte > 255) {
      throw new Error('capByte must be 0..255');
    }

    const catNorm =
      categoryMode === 'none'
        ? category32
        : categoryMode === 'reverse'
          ? reverseBytes(category32)
          : (() => { throw new Error(`unknown categoryMode: ${categoryMode}`); })();

    const inCatCap33 = concat(catNorm, Uint8Array.of(capByte));

    const h0 = hash256(concat(stateIn32, stateIn32));
    const h1 = hash256(concat(h0, stateIn32));
    const h2 = hash256(concat(h1, inCatCap33));
    let acc = hash256(concat(h2, noteHash32));

    // fold limbs LIFO
    for (let i = limbs.length - 1; i >= 0; i--) {
      const limbBytes = limbToBytesForHash(limbs[i]);
      acc = hash256(concat(acc, limbBytes));
    }

    return acc;
  }

  throw new Error(`computePoolStateOut: unknown version ${version}`);
}

/**
 * Build unlocking bytecode for each version.
 *
 * v0:
 *   limbs... oldCommit32 expectedNewCommit32
 * v1:
 *   limbs...
 * v1.1:
 *   limbs... noteHash32 proofBlob32
 */
export function buildPoolHashFoldUnlockingBytecode({
  version = POOL_HASH_FOLD_VERSION.V1_1,
  limbs = [],

  // v0:
  oldCommit32,
  expectedNewCommit32,

  // v1.1:
  noteHash32,
  proofBlob32,
} = {}) {
  const pushes = [];

  // limbs first (in order)
  for (const limb of limbs) pushes.push(encodeLimbPush(limb));

  if (version === POOL_HASH_FOLD_VERSION.V0) {
    assertLen(oldCommit32, 32, 'oldCommit32');
    assertLen(expectedNewCommit32, 32, 'expectedNewCommit32');
    pushes.push(concat(pushDataPrefix(32), oldCommit32));
    pushes.push(concat(pushDataPrefix(32), expectedNewCommit32));
    return concat(...pushes);
  }

  if (version === POOL_HASH_FOLD_VERSION.V1) {
    // v1 pushes only limbs
    return concat(...pushes);
  }

  if (version === POOL_HASH_FOLD_VERSION.V1_1) {
    assertLen(noteHash32, 32, 'noteHash32');
    assertLen(proofBlob32, 32, 'proofBlob32');

    // IMPORTANT ORDER: noteHash32 THEN proofBlob32
    // (proofBlob must be on top so v1.1 main program can size-check and drop it)
    pushes.push(concat(pushDataPrefix(32), noteHash32));
    pushes.push(concat(pushDataPrefix(32), proofBlob32));

    return concat(...pushes);
  }

  throw new Error(`buildPoolHashFoldUnlockingBytecode: unknown version ${version}`);
}
