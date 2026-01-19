// packages/pool-shards/src/import.ts
import type { BuilderDeps } from './di.js';

import { bytesToHex, hexToBytes, hash160 } from '@bch-stealth/utils';
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

export function importDepositToShard(args: any) {
  // --- Back-compat / caller normalization ---------------------------------
  // Preferred API shapes:
  //   - { covenantWallet, depositWallet } OR
  //   - { ownerWallet } (legacy)
  // New multi-signer shape:
  //   - { signers?: { covenantPrivBytes, depositPrivBytes } }
  const a: any = args ?? {};

  const legacyWallet =
    a.ownerWallet ?? a.wallet ?? a.signerWallet ?? a.senderWallet ?? a.actorWallet;

  // Populate wallet aliases (existing behavior)
  if (!a.covenantWallet && legacyWallet) a.covenantWallet = legacyWallet;
  if (!a.depositWallet && legacyWallet) a.depositWallet = legacyWallet;

  // If caller only provided covenantWallet, use it for depositWallet too (parity tests).
  if (!a.depositWallet && a.covenantWallet) a.depositWallet = a.covenantWallet;

  // ---- Multi-signer overlay (B3g) ----------------------------------------
  if (a.signers?.covenantPrivBytes) {
    if (!a.covenantWallet) a.covenantWallet = {};
    a.covenantWallet.signPrivBytes = a.signers.covenantPrivBytes;
  }
  if (a.signers?.depositPrivBytes) {
    if (!a.depositWallet) a.depositWallet = {};
    a.depositWallet.signPrivBytes = a.signers.depositPrivBytes;
  }

  // Helpful early errors
  if (!a.covenantWallet?.signPrivBytes) {
    throw new Error(
      'importDepositToShard: missing covenantWallet.signPrivBytes (or legacy ownerWallet.signPrivBytes)'
    );
  }
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
    covenantWallet,
    depositWallet,
    feeSats,
    categoryMode,
    amountCommitment,
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

  // demo convention: limbs = [noteHash32]
  const limbs: Uint8Array[] = [noteHash32];

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

  const shardUnlockPrefix = buildPoolHashFoldUnlockingBytecode({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    limbs,
    noteHash32,
    proofBlob32,
  });

  // shard output locking script via templates
  // (p2shSpk retained for covenant prevout fallback behavior)
  const p2shSpk = (deps?.txb ?? txbDefault).getP2SHScript(hash160(redeemScript));

  const tokenOut = makeShardTokenOut({ category32, commitment32: stateOut32 });
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

  // covenant unlocking via provider (provider applies extraPrefix)
  auth.authorizeCovenantInput({
    tx,
    vin: 0,
    covenantPrivBytes: covenantWallet.signPrivBytes,
    redeemScript,
    prevout: {
      valueSats: shardPrevout.valueSats,
      scriptPubKey: (shardPrevout.scriptPubKey ?? p2shSpk) as Uint8Array,
    },
    amountCommitment: amountCommitment ?? 0n,
    extraPrefix: shardUnlockPrefix,
    witnessVin,
    witnessPrevout: witnessPrevoutCtx,
  });

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

  const rawAny = txb.buildRawTx(tx, { format: 'bytes' });
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