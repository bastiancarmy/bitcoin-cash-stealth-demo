// packages/pool-shards/src/import.ts
import type { BuilderDeps } from './di.js';

import { bytesToHex, hexToBytes } from '@bch-stealth/utils';
import * as txbDefault from '@bch-stealth/tx-builder';

import {
  DEFAULT_CAP_BYTE,
  DEFAULT_CATEGORY_MODE,
  DEFAULT_POOL_HASH_FOLD_VERSION,
  DUST_SATS,
  outpointHash32,
} from './policy.js';

import {
  computePoolStateOut,
  buildPoolHashFoldUnlockingBytecode,
  makeProofBlobV11,
} from '@bch-stealth/pool-hash-fold';

import type { PoolState, ImportDepositDiagnostics } from './types.js';

import {
  asBigInt,
  ensureBytesLen,
  normalizeRawTxBytes,
  resolveBuilderDeps,
  makeShardTokenOut,
  appendWitnessInput,
} from './shard_common.js';

import { validatePoolHashFoldV11UnlockScriptSig } from './script_pushes.js';

function maybeValidateCovenantScriptSig(label: string, scriptSig: Uint8Array) {
  const debugPushParse = process.env.BCH_STEALTH_DEBUG_COVENANT_PUSHPARSE === '1';
  if (!debugPushParse) return;

  const allowBad = process.env.BCH_STEALTH_ALLOW_BAD_COVENANT_PUSHPARSE === '1';

  try {
    validatePoolHashFoldV11UnlockScriptSig(scriptSig, {
      debugPrint: true,
      label,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (allowBad) {
      console.warn(msg);
      return;
    }
    throw e;
  }
}

export function importDepositToShard(args: any) {
  // --- Back-compat / caller normalization ---------------------------------
  // Preferred API shapes:
  //   - { covenantWallet, depositWallet } OR
  //   - { ownerWallet } (legacy)
  // New multi-signer shape:
  //   - { signers?: { depositPrivBytes } }
  const a: any = args ?? {};

  const legacyWallet =
    a.ownerWallet ?? a.wallet ?? a.signerWallet ?? a.senderWallet ?? a.actorWallet;

  // Populate wallet aliases (existing behavior)
  if (!a.covenantWallet && legacyWallet) a.covenantWallet = legacyWallet;
  if (!a.depositWallet && legacyWallet) a.depositWallet = legacyWallet;

  // If caller only provided covenantWallet, use it for depositWallet too (parity tests).
  if (!a.depositWallet && a.covenantWallet) a.depositWallet = a.covenantWallet;

  // ---- Multi-signer overlay (B3g) ----------------------------------------
  // Phase 2: covenant input is NOT signed; only P2PKH deposit input is signed.
  if (a.signers?.depositPrivBytes) {
    if (!a.depositWallet) a.depositWallet = {};
    a.depositWallet.signPrivBytes = a.signers.depositPrivBytes;
  }

  // Helpful early errors
  if (!a.depositWallet?.signPrivBytes) {
    throw new Error(
      'importDepositToShard: missing depositWallet.signPrivBytes (or legacy ownerWallet.signPrivBytes)'
    );
  }

  // --- Now destructure from the normalized object --------------------------
  const {
    pool,
    shardIndex,
    shardPrevout,
    depositPrevout,
    depositWallet,
    feeSats,
    categoryMode,
    deps,
    witnessPrevout,
    witnessPrivBytes,
  } = a;

  const { txb, auth, locking } = resolveBuilderDeps(deps);

  const shard = pool.shards[shardIndex];
  if (!shard) throw new Error(`importDepositToShard: invalid shardIndex ${shardIndex}`);

  const category32 = hexToBytes(pool.categoryHex);
  const redeemScript = hexToBytes(pool.redeemScriptHex);
  ensureBytesLen(category32, 32, 'category32');

  const stateIn32 = hexToBytes(shard.commitmentHex);
  ensureBytesLen(stateIn32, 32, 'stateIn32');

  const fee = feeSats !== undefined ? asBigInt(feeSats, 'feeSats') : 0n;

  const shardValueIn = asBigInt(shardPrevout.valueSats, 'shardPrevout.valueSats');
  const depositValueIn = asBigInt(depositPrevout.valueSats, 'depositPrevout.valueSats');

  const newShardValue = shardValueIn + depositValueIn - fee;

  if (newShardValue < DUST_SATS) {
    throw new Error(
      `importDepositToShard: new shard value below dust; got ${newShardValue.toString()} sats`
    );
  }

  // noteHash = outpointHash32(deposit outpoint)
  const noteHash32 = outpointHash32(depositPrevout.txid, depositPrevout.vout);
  const proofBlob32 = makeProofBlobV11(noteHash32);

  // v1.1 covenant expects: limbs... noteHash32 proofBlob32
  // Phase 2: no limbs
  const limbs: Uint8Array[] = [];

  const effectiveCategoryMode = categoryMode ?? DEFAULT_CATEGORY_MODE;

  const stateOut32 = computePoolStateOut({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    stateIn32,
    category32,
    noteHash32,
    limbs,
    categoryMode: effectiveCategoryMode,
    capByte: DEFAULT_CAP_BYTE,
  });

  const shardUnlock = buildPoolHashFoldUnlockingBytecode({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    limbs,
    noteHash32,
    proofBlob32,
  });

  const tokenOut = makeShardTokenOut({ category32, commitment32: stateOut32 });

  // ✅ shard output is bare covenant (token prefix + redeemScript bytes)
  const shardOutSpk = locking.shardLock({ token: tokenOut, redeemScript });

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shardPrevout.txid, vout: shardPrevout.vout, sequence: 0xffffffff }, // covenant
      { txid: depositPrevout.txid, vout: depositPrevout.vout, sequence: 0xffffffff }, // deposit P2PKH
    ],
    outputs: [{ value: newShardValue, scriptPubKey: shardOutSpk }],
  };

  const { witnessVin, witnessPrevoutCtx } = appendWitnessInput(tx, witnessPrevout);

  // ✅ Phase 2 / v1.1 ABI: covenant input is push-only and NOT signed
  tx.inputs[0].scriptSig = shardUnlock;

  // NEW: local parse/validation of covenant pushes (debug gated)
  maybeValidateCovenantScriptSig('importDepositToShard vin=0', tx.inputs[0].scriptSig);

  // deposit spend via provider
  auth.authorizeP2pkhInput({
    tx,
    vin: 1,
    privBytes: depositWallet.signPrivBytes,
    prevout: {
      valueSats: depositPrevout.valueSats,
      scriptPubKey: depositPrevout.scriptPubKey,
    },
    witnessVin,
    witnessPrevout: witnessPrevoutCtx,
  });

  // Optional signing for witness slot
  if (witnessPrevout && witnessVin !== undefined && witnessPrivBytes && witnessPrevoutCtx) {
    auth.authorizeP2pkhInput({
      tx,
      vin: witnessVin,
      privBytes: witnessPrivBytes,
      prevout: {
        valueSats: witnessPrevoutCtx.valueSats,
        scriptPubKey: witnessPrevoutCtx.scriptPubKey,
      },
      witnessVin,
      witnessPrevout: witnessPrevoutCtx,
    });
  }

  const rawAny = (txb ?? txbDefault).buildRawTx(tx, { format: 'bytes' });
  const rawTx = normalizeRawTxBytes(rawAny);
  const sizeBytes = rawTx.length;

  const nextPoolState: PoolState = structuredClone(pool) as PoolState;
  nextPoolState.shards[shardIndex] = {
    ...shard,
    txid: '<pending>',
    vout: 0,
    valueSats: newShardValue.toString(),
    commitmentHex: bytesToHex(stateOut32),
  };

  const diagnostics: ImportDepositDiagnostics = {
    shardIndex,
    depositOutpoint: { txid: depositPrevout.txid, vout: depositPrevout.vout },
    category32Hex: bytesToHex(category32),
    stateIn32Hex: bytesToHex(stateIn32),
    stateOut32Hex: bytesToHex(stateOut32),
    noteHash32Hex: bytesToHex(noteHash32),
    limbsHex: limbs.map(bytesToHex),
    feeSats: fee.toString(),
    shardValueInSats: shardValueIn.toString(),
    depositValueInSats: depositValueIn.toString(),
    newShardValueSats: newShardValue.toString(),
    policy: {
      poolHashFoldVersion: 'V1_1',
      categoryMode: effectiveCategoryMode,
      capByte: DEFAULT_CAP_BYTE,
    },
  };

  return { tx, rawTx, sizeBytes, diagnostics, nextPoolState };
}