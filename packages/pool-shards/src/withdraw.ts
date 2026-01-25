// packages/pool-shards/src/withdraw.ts
import type { BuilderDeps } from './di.js';

import { bytesToHex, concat, hexToBytes, sha256, uint32le } from '@bch-stealth/utils';

import { DEFAULT_CAP_BYTE, DEFAULT_CATEGORY_MODE, DEFAULT_POOL_HASH_FOLD_VERSION, DUST_SATS } from './policy.js';
import { computePoolStateOut, buildPoolHashFoldUnlockingBytecode } from '@bch-stealth/pool-hash-fold';

import type { PoolState, WithdrawDiagnostics } from './types.js';

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

export function withdrawFromShard(args: any) {
  // --- Back-compat / caller normalization ---------------------------------
  const a: any = args ?? {};

  const legacyWallet =
    a.senderWallet ?? a.ownerWallet ?? a.wallet ?? a.signerWallet ?? a.actorWallet;

  if (!a.covenantWallet && legacyWallet) a.covenantWallet = legacyWallet;
  if (!a.feeWallet && legacyWallet) a.feeWallet = legacyWallet;

  // If caller didn’t provide change destination, default change back to sender.
  if (!a.changeP2pkhHash160Hex && legacyWallet?.pubkeyHash160Hex) {
    a.changeP2pkhHash160Hex = legacyWallet.pubkeyHash160Hex;
  }
  if (!a.changeP2pkhHash160Hex && legacyWallet?.pubkeyHashHex) {
    a.changeP2pkhHash160Hex = legacyWallet.pubkeyHashHex;
  }

  // Ensure wallet objects have the fields withdraw expects
  if (a.covenantWallet && !a.covenantWallet.pubkeyHash160Hex && legacyWallet?.pubkeyHash160Hex) {
    a.covenantWallet.pubkeyHash160Hex = legacyWallet.pubkeyHash160Hex;
  }
  if (a.feeWallet && !a.feeWallet.pubkeyHash160Hex && legacyWallet?.pubkeyHash160Hex) {
    a.feeWallet.pubkeyHash160Hex = legacyWallet.pubkeyHash160Hex;
  }

  // ---- Multi-signer overlay (B3g) ----------------------------------------
  // Phase 2: covenant input is NOT signed; only fee P2PKH input is signed.
  if (a.signers?.feePrivBytes) {
    if (!a.feeWallet) a.feeWallet = {};
    a.feeWallet.signPrivBytes = a.signers.feePrivBytes;
  }

  // Helpful early errors
  if (!a.feeWallet?.signPrivBytes) {
    throw new Error(
      'withdrawFromShard: missing feeWallet.signPrivBytes (or legacy senderWallet.signPrivBytes)'
    );
  }
  if (!a.changeP2pkhHash160Hex) {
    throw new Error(
      'withdrawFromShard: missing changeP2pkhHash160Hex (or senderWallet.pubkeyHash160Hex)'
    );
  }

  // --- Now destructure from the normalized object --------------------------
  const {
    pool,
    shardIndex,
    shardPrevout,
    feePrevout,
    feeWallet,
    receiverP2pkhHash160Hex,
    amountSats,
    feeSats,
    changeP2pkhHash160Hex,
    categoryMode,
    deps,
    witnessPrevout,
    witnessPrivBytes,
  } = a;

  const { txb, auth, locking } = resolveBuilderDeps(deps);

  const shard = pool.shards[shardIndex];
  if (!shard) throw new Error(`withdrawFromShard: invalid shardIndex ${shardIndex}`);

  const category32 = hexToBytes(pool.categoryHex);
  const redeemScript = hexToBytes(pool.redeemScriptHex);
  ensureBytesLen(category32, 32, 'category32');

  const stateIn32 = hexToBytes(shard.commitmentHex);
  ensureBytesLen(stateIn32, 32, 'stateIn32');

  const receiverHash160 = hexToBytes(receiverP2pkhHash160Hex);
  ensureBytesLen(receiverHash160, 20, 'receiverHash160');

  const payment = asBigInt(amountSats, 'amountSats');
  if (payment < DUST_SATS) throw new Error('withdrawFromShard: payment is dust');

  const shardValueIn = asBigInt(shardPrevout.valueSats, 'shardPrevout.valueSats');
  const newShardValue = shardValueIn - payment;
  if (newShardValue < DUST_SATS) {
    throw new Error(
      `withdrawFromShard: shard remainder is dust; remainder=${newShardValue.toString()} sats`
    );
  }

  const fee = feeSats !== undefined ? asBigInt(feeSats, 'feeSats') : 0n;
  const feeValue = asBigInt(feePrevout.valueSats, 'feePrevout.valueSats');
  const changeValue = feeValue - fee;
  if (changeValue < DUST_SATS) throw new Error('withdrawFromShard: fee prevout too small after fee');

  // deterministic “nullifier-ish” update (Phase 2 placeholder)
  const nullifier32 = sha256(
    concat(stateIn32, receiverHash160, sha256(uint32le(Number(payment & 0xffffffffn))))
  );
  const proofBlob32 = sha256(concat(nullifier32, Uint8Array.of(0x02)));

  // v1.1 covenant expects: limbs... noteHash32 proofBlob32
  const limbs: Uint8Array[] = [];

  const effectiveCategoryMode = categoryMode ?? DEFAULT_CATEGORY_MODE;

  const stateOut32 = computePoolStateOut({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    stateIn32,
    category32,
    noteHash32: nullifier32,
    limbs,
    categoryMode: effectiveCategoryMode,
    capByte: DEFAULT_CAP_BYTE,
  });

  const shardUnlock = buildPoolHashFoldUnlockingBytecode({
    version: DEFAULT_POOL_HASH_FOLD_VERSION,
    limbs,
    noteHash32: nullifier32,
    proofBlob32,
  });

  const tokenOut = makeShardTokenOut({ category32, commitment32: stateOut32 });

  // shard output is bare covenant (token prefix + redeemScript bytes)
  const shardOutSpk = locking.shardLock({ token: tokenOut, redeemScript });

  const paySpk = locking.p2pkh(receiverHash160);

  const changeHash160 = hexToBytes(changeP2pkhHash160Hex ?? feeWallet.pubkeyHash160Hex);
  ensureBytesLen(changeHash160, 20, 'changeHash160');
  const changeSpk = locking.p2pkh(changeHash160);

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shardPrevout.txid, vout: shardPrevout.vout, sequence: 0xffffffff }, // covenant
      { txid: feePrevout.txid, vout: feePrevout.vout, sequence: 0xffffffff }, // fee P2PKH
    ],
    outputs: [
      { value: newShardValue, scriptPubKey: shardOutSpk },
      { value: payment, scriptPubKey: paySpk },
      { value: changeValue, scriptPubKey: changeSpk },
    ],
  };

  const { witnessVin, witnessPrevoutCtx } = appendWitnessInput(tx, witnessPrevout);

  // Phase 2 / v1.1 ABI: covenant input is push-only and NOT signed
  tx.inputs[0].scriptSig = shardUnlock;

  // NEW: local parse/validation of covenant pushes (debug gated)
  maybeValidateCovenantScriptSig('withdrawFromShard vin=0', tx.inputs[0].scriptSig);

  auth.authorizeP2pkhInput({
    tx,
    vin: 1,
    privBytes: feeWallet.signPrivBytes,
    prevout: {
      valueSats: feePrevout.valueSats,
      scriptPubKey: feePrevout.scriptPubKey,
    },
    witnessVin,
    witnessPrevout: witnessPrevoutCtx,
  });

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

  const diagnostics: WithdrawDiagnostics = {
    shardIndex,
    receiverHash160Hex: receiverP2pkhHash160Hex,
    amountSats: payment.toString(),
    feeSats: fee.toString(),
    changeSats: changeValue.toString(),
    category32Hex: bytesToHex(category32),
    stateIn32Hex: bytesToHex(stateIn32),
    stateOut32Hex: bytesToHex(stateOut32),
    noteHash32Hex: bytesToHex(nullifier32),
    limbsHex: limbs.map(bytesToHex),
    policy: {
      poolHashFoldVersion: 'V1_1',
      categoryMode: effectiveCategoryMode,
      capByte: DEFAULT_CAP_BYTE,
    },
  };

  return { tx, rawTx, sizeBytes, diagnostics, nextPoolState };
}