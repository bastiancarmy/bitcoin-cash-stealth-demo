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
} from '@bch-stealth/utils';

import { POOL_HASH_FOLD_VERSION, type PoolHashFoldVersion } from './pool_hash_fold_script.js';

export type PoolHashFoldLimb = Uint8Array | number | bigint;
export type PoolHashFoldCategoryMode =
  | 'reverse'
  | 'direct'
  | 'raw'
  | 'none'
  | 'rev'
  | 'reversed'
  | 'asis'
  | 'as-is'
  | 'as_is'
  | 'forward'
  | 'normal';

export type ComputePoolStateOutParams =
  | {
      version?: typeof POOL_HASH_FOLD_VERSION.V0 | typeof POOL_HASH_FOLD_VERSION.V1;
      limbs?: PoolHashFoldLimb[];
      // legacy versions don’t use these
    }
  | {
      version?: typeof POOL_HASH_FOLD_VERSION.V1_1;
      limbs?: PoolHashFoldLimb[];
      categoryMode?: PoolHashFoldCategoryMode;
      capByte?: number;
      stateIn32: Uint8Array;
      category32: Uint8Array;
      noteHash32: Uint8Array;
      oldCommit32?: Uint8Array; // if you carry it for callers, keep optional
    };

export type BuildPoolHashFoldUnlockingBytecodeParams =
  | {
      version?: typeof POOL_HASH_FOLD_VERSION.V0;
      limbs?: PoolHashFoldLimb[];
      oldCommit32: Uint8Array;
      expectedNewCommit32: Uint8Array;
    }
  | {
      version?: typeof POOL_HASH_FOLD_VERSION.V1;
      limbs?: PoolHashFoldLimb[];
    }
  | {
      version?: typeof POOL_HASH_FOLD_VERSION.V1_1;
      limbs?: PoolHashFoldLimb[];
      noteHash32: Uint8Array;
      proofBlob32: Uint8Array;
    };

type NormalizedCategoryMode = 'reverse' | 'direct';

function normalizeCategoryMode(mode: unknown): NormalizedCategoryMode {
  if (mode == null) return 'reverse'; // keep existing default behavior (v1.1 expects reverse by default)

  const s = String(mode).trim().toLowerCase();
  if (!s) return 'reverse';

  // "reverse" mode (common)
  if (s === 'reverse' || s === 'rev' || s === 'reversed') return 'reverse';

  // "direct" (no reverse) — accept common synonyms/aliases
  if (
    s === 'direct' ||
    s === 'raw' ||
    s === 'none' ||
    s === 'asis' ||
    s === 'as-is' ||
    s === 'as_is' ||
    s === 'forward' ||
    s === 'normal'
  ) {
    return 'direct';
  }

  throw new Error(`unknown categoryMode: ${String(mode)}`);
}

// Small helper: allow calling assertLen on values that might be undefined from destructuring
function assertLen(u8: unknown, n: number, label: string): asserts u8 is Uint8Array {
  if (!(u8 instanceof Uint8Array)) {
    throw new Error(`${label} must be Uint8Array`);
  }
  if (u8.length !== n) {
    throw new Error(`${label} must be ${n} bytes (got ${u8.length})`);
  }
}

function hash256(u8: Uint8Array): Uint8Array {
  return sha256(sha256(u8));
}

function opSmallInt(n: number): Uint8Array {
  // For small non-negative ints, CashAssembly uses opcodes, but for bytecode building
  // we just encode as minimal script number.
  return minimalScriptNumber(n);
}

function encodeLimbPush(limb: PoolHashFoldLimb): Uint8Array {
  if (limb instanceof Uint8Array) return concat(pushDataPrefix(limb.length), limb);
  return concat(pushDataPrefix(opSmallInt(Number(limb)).length), opSmallInt(Number(limb)));
}

function limbToBytesForHash(limb: PoolHashFoldLimb): Uint8Array {
  if (limb instanceof Uint8Array) return limb;
  return minimalScriptNumber(limb);
}

/**
 * v1.1 proof blob (content is currently NOT used by the covenant; only length-checked+dropped).
 * Still helpful to keep deterministic.
 *
 * Default matches the earlier demo pattern: sha256( [tagByte] || noteHash32 )
 */
export function makeProofBlobV11(noteHash32: Uint8Array, tagByte = 0x50): Uint8Array {
  assertLen(noteHash32, 32, 'noteHash32');
  if (!Number.isInteger(tagByte) || tagByte < 0 || tagByte > 255) {
    throw new Error('tagByte must be 0..255');
  }
  return sha256(concat(Uint8Array.of(tagByte), noteHash32));
}

/**
 * Compute state_out for each version.
 *
 * v0:
 *   Legacy fold (LIFO): acc starts from (oldCommit32 ?? stateIn32), then
 *     acc = H(H(acc || limbBytes)) for each limb from top..bottom.
 *
 * v1:
 *   Legacy fold (LIFO): acc starts from stateIn32 (caller-provided, often the input commitment),
 *     acc = H(H(acc || limbBytes)) for each limb from top..bottom.
 *
 * v1.1:
 *   Prehash chain + LIFO fold limbs:
 *
 *   inCatCap33 = (categoryNormalized32) || capByte
 *   h0 = H(state_in || state_in)
 *   h1 = H(h0 || state_in)
 *   h2 = H(h1 || inCatCap33)
 *   h3 = H(h2 || noteHash32)
 *   acc = h3
 *   for limb = top..bottom: acc = H(H(acc || limbBytes))
 *
 * Notes:
 * - category normalization is controlled by categoryMode:
 *     'reverse' (default) => REVERSEBYTES(category32)
 *     'none'              => category32 as-is
 * - capByte defaults to 0x01 to match the v1.1 casm header comment/pattern.
 */
export function computePoolStateOut(params: ComputePoolStateOutParams): Uint8Array {
  const version = params.version ?? POOL_HASH_FOLD_VERSION.V1_1;
  const limbs = params.limbs ?? [];

  if (version === POOL_HASH_FOLD_VERSION.V0) {
    const p = params as {
      limbs?: PoolHashFoldLimb[];
      oldCommit32?: Uint8Array;
      stateIn32?: Uint8Array;
    };

    const acc0 = p.oldCommit32 ?? p.stateIn32;
    assertLen(acc0, 32, 'oldCommit32/stateIn32');

    let acc = acc0;
    for (let i = limbs.length - 1; i >= 0; i--) {
      const limbBytes = limbToBytesForHash(limbs[i]);
      acc = hash256(concat(acc, limbBytes));
    }
    return acc;
  }

  if (version === POOL_HASH_FOLD_VERSION.V1) {
    const p = params as { stateIn32: Uint8Array };

    assertLen(p.stateIn32, 32, 'stateIn32');

    let acc = p.stateIn32;
    for (let i = limbs.length - 1; i >= 0; i--) {
      const limbBytes = limbToBytesForHash(limbs[i]);
      acc = hash256(concat(acc, limbBytes));
    }
    return acc;
  }

  // v1.1: prehash chain then LIFO fold limbs
  const p = params as Extract<ComputePoolStateOutParams, { version?: typeof POOL_HASH_FOLD_VERSION.V1_1 }>;

  assertLen(p.stateIn32, 32, 'stateIn32');
  assertLen(p.category32, 32, 'category32');
  assertLen(p.noteHash32, 32, 'noteHash32');

  const capByte = p.capByte ?? 0x01;
  if (!Number.isInteger(capByte) || capByte < 0 || capByte > 255) {
    throw new Error('capByte must be 0..255');
  }

  // v1.1 category normalization:
  // - default: "reverse"
  // - accepts aliases like "raw" => direct (no reverse)
  const mode = normalizeCategoryMode((p as any).categoryMode);

  const catNorm = mode === 'reverse' ? reverseBytes(p.category32) : p.category32;

  const inCatCap33 = concat(catNorm, Uint8Array.of(capByte));

  const h0 = hash256(concat(p.stateIn32, p.stateIn32));
  const h1 = hash256(concat(h0, p.stateIn32));
  const h2 = hash256(concat(h1, inCatCap33));
  let acc = hash256(concat(h2, p.noteHash32));

  for (let i = limbs.length - 1; i >= 0; i--) {
    const limbBytes = limbToBytesForHash(limbs[i]);
    acc = hash256(concat(acc, limbBytes));
  }

  return acc;
}

/**
 * Build unlocking bytecode for each version.
 *
 * v0 unlocking stack (top last):
 *   limbs... oldCommit32 expectedNewCommit32
 *
 * v1 unlocking stack:
 *   limbs...
 *
 * v1.1 unlocking stack (top last, MUST match covenant expectations):
 *   limbs... noteHash32 proofBlob32
 *
 * IMPORTANT (v1.1):
 * - proofBlob32 MUST be pushed last so it sits on top of the stack.
 *   The v1.1 covenant checks proofBlob32 is 32 bytes, then drops it.
 * - noteHash32 must be directly below proofBlob32 so computeStateOut sees:
 *     [ limbs... noteHash32 ] after proofBlob32 is dropped.
 */
export function buildPoolHashFoldUnlockingBytecode(
  args: BuildPoolHashFoldUnlockingBytecodeParams = {
    version: POOL_HASH_FOLD_VERSION.V1_1,
    limbs: [],
    // NOTE: v1.1 requires noteHash32/proofBlob32; callers should pass them.
    // This default exists only so TS allows omitted args in some call sites.
  } as unknown as BuildPoolHashFoldUnlockingBytecodeParams
): Uint8Array {
  const version = args.version ?? POOL_HASH_FOLD_VERSION.V1_1;
  const limbs = args.limbs ?? [];

  const pushes: Uint8Array[] = [];

  // limbs first (in the given order; last limb ends up closest to the top among limbs)
  for (const limb of limbs) pushes.push(encodeLimbPush(limb));

  if (version === POOL_HASH_FOLD_VERSION.V0) {
    const p = args as Extract<
      BuildPoolHashFoldUnlockingBytecodeParams,
      { version?: typeof POOL_HASH_FOLD_VERSION.V0 }
    >;

    assertLen(p.oldCommit32, 32, 'oldCommit32');
    assertLen(p.expectedNewCommit32, 32, 'expectedNewCommit32');

    pushes.push(concat(pushDataPrefix(32), p.oldCommit32));
    pushes.push(concat(pushDataPrefix(32), p.expectedNewCommit32));
    return concat(...pushes);
  }

  if (version === POOL_HASH_FOLD_VERSION.V1) {
    // v1 pushes only limbs
    return concat(...pushes);
  }

  // v1.1
  const p = args as Extract<
    BuildPoolHashFoldUnlockingBytecodeParams,
    { version?: typeof POOL_HASH_FOLD_VERSION.V1_1 }
  >;

  assertLen(p.noteHash32, 32, 'noteHash32');
  assertLen(p.proofBlob32, 32, 'proofBlob32');

  pushes.push(concat(pushDataPrefix(32), p.noteHash32));
  pushes.push(concat(pushDataPrefix(32), p.proofBlob32));

  return concat(...pushes);
}