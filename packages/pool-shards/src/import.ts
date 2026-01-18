// packages/pool-shards/src/import.ts
import type { BuilderDeps } from './di.js';

import { makeDefaultAuthProvider } from './auth.js';
import { makeDefaultLockingTemplates } from './locking.js';

import * as txbDefault from '@bch-stealth/tx-builder';
import { bytesToHex, hexToBytes, hash160 } from '@bch-stealth/utils';

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

import type {
  ImportDepositResult,
  PoolState,
  PrevoutLike,
  WalletLike,
  CategoryMode,
  ImportDepositDiagnostics,
} from './types.js';

function ensureBytesLen(u8: Uint8Array, n: number, label: string) {
  if (!(u8 instanceof Uint8Array) || u8.length !== n) throw new Error(`${label} must be ${n} bytes`);
}

function asBigInt(v: number | string | bigint, label: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string') return BigInt(v);
  throw new Error(`${label} must be number|string|bigint`);
}

function normalizeRawTxBytes(raw: string | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  return hexToBytes(raw);
}

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
  // If explicit signers provided, they override the signing keys used by each input.
  // This keeps callsites stable while enabling correctness for stealth + covenant split.
  if (a.signers?.covenantPrivBytes) {
    if (!a.covenantWallet) a.covenantWallet = {};
    a.covenantWallet.signPrivBytes = a.signers.covenantPrivBytes;
  }
  if (a.signers?.depositPrivBytes) {
    if (!a.depositWallet) a.depositWallet = {};
    a.depositWallet.signPrivBytes = a.signers.depositPrivBytes;
  }

  // Helpful early errors (so we don’t crash on undefined.signPrivBytes)
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
  } = a;

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

  const txb = deps?.txb ?? txbDefault;
  const auth = deps?.auth ?? makeDefaultAuthProvider(txb);
  const locking = deps?.locking ?? makeDefaultLockingTemplates({ txb });

  // shard output locking script via templates
  // (p2shSpk retained for covenant prevout fallback behavior)
  const p2shSpk = txb.getP2SHScript(hash160(redeemScript));

  const tokenOut = {
    category: category32,
    nft: { capability: 'mutable' as const, commitment: stateOut32 },
  };

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
  });

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