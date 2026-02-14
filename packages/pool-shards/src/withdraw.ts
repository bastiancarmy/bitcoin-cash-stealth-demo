// packages/pool-shards/src/withdraw.ts
import type { BuilderDeps } from './di.js';

import { bytesToHex, concat, hexToBytes, sha256, uint32le } from '@bch-stealth/utils';

import { DEFAULT_CAP_BYTE, DEFAULT_CATEGORY_MODE, DEFAULT_POOL_HASH_FOLD_VERSION, DUST_SATS, POOL_HASH_FOLD_VERSION } from './policy.js';
import { computePoolStateOut, buildPoolHashFoldUnlockingBytecode } from '@bch-stealth/pool-hash-fold';

import type { PoolState, WithdrawDiagnostics } from './types.js';

import { decodeCashTokensPrefix, splitCashTokensPrefix } from '@bch-stealth/utils';

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

function getCommitment32FromShardPrevoutScript(scriptPubKey: Uint8Array): Uint8Array {
  const { prefix } = splitCashTokensPrefix(scriptPubKey);
  if (!prefix) {
    throw new Error('withdrawFromShard: shard prevout missing CashTokens prefix (expected tokenized covenant UTXO)');
  }
  const decoded = decodeCashTokensPrefix(prefix);

  const commitment = decoded.commitment;
  if (!(commitment instanceof Uint8Array) || commitment.length !== 32) {
    throw new Error(
      `withdrawFromShard: expected 32-byte commitment in token prefix, got ${commitment?.length ?? 0}`
    );
  }
  return commitment;
}

function debugShardTokenPrefix(scriptPubKey: Uint8Array) {
  const debug = process.env.BCH_STEALTH_DEBUG_WITHDRAW === '1' || process.env.BCH_STEALTH_DEBUG_WITHDRAW === 'true';
  if (!debug) return;

  const { prefix, locking } = splitCashTokensPrefix(scriptPubKey);

  console.log(`[withdraw:debug] shardPrevout tokenPrefixed=${!!prefix} prefixLen=${prefix?.length ?? 0}`);
  console.log(`[withdraw:debug] shardPrevout locking[0..12]=${bytesToHex(locking).slice(0, 24)}`);

  if (!prefix) return;

  const d = decodeCashTokensPrefix(prefix);
  console.log(`[withdraw:debug] shardToken.category=${bytesToHex(d.category)}`);
  console.log(
    `[withdraw:debug] shardToken.bitfield=0x${d.bitfield.toString(16)} hasNft=${d.hasNft} hasCommitment=${d.hasCommitment} hasAmount=${d.hasAmount} cap=${d.capability}`
  );
  console.log(`[withdraw:debug] shardToken.commitmentLen=${d.commitment?.length ?? 0}`);
  if (d.commitment) console.log(`[withdraw:debug] shardToken.commitment=${bytesToHex(d.commitment)}`);
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

    // (optional):
    // - 'keep': always keep shard output (old behavior)
    // - 'close-if-dust': if remainder is 0 or < dust, omit shard output and close shard
    remainderPolicy,
  } = a;

  const policy: 'keep' | 'close-if-dust' =
    remainderPolicy === 'close-if-dust' ? 'close-if-dust' : 'keep';

  if (policy === 'close-if-dust' && process.env.BCH_STEALTH_DEBUG_WITHDRAW === '1') {
    console.warn(
      '[withdrawFromShard] NOTE: remainderPolicy=close-if-dust ignored (close path disabled until covenant supports it)'
    );
  }

  const { txb, auth, locking } = resolveBuilderDeps(deps);

  const shard = pool.shards[shardIndex];
  if (!shard) throw new Error(`withdrawFromShard: invalid shardIndex ${shardIndex}`);

  const category32 = hexToBytes(pool.categoryHex);
  const redeemScript = hexToBytes(pool.redeemScriptHex);
  ensureBytesLen(category32, 32, 'category32');

// Derive stateIn from the ON-CHAIN shard prevout token prefix commitment.
// This eliminates state-file drift and is required for deterministic covenant validity.
debugShardTokenPrefix(shardPrevout.scriptPubKey);

const stateIn32 = getCommitment32FromShardPrevoutScript(shardPrevout.scriptPubKey);
ensureBytesLen(stateIn32, 32, 'stateIn32');

if (process.env.BCH_STEALTH_DEBUG_WITHDRAW === '1') {
  console.log(`[withdraw:debug] stateIn32(from on-chain token commitment)=${bytesToHex(stateIn32)}`);
}

// Optional sanity check: warn if state file differs (don’t fail during debugging)
try {
  const stCommit = hexToBytes(shard.commitmentHex);
  if (stCommit.length === 32) {
    const a = bytesToHex(stCommit).toLowerCase();
    const b = bytesToHex(stateIn32).toLowerCase();

    if (process.env.BCH_STEALTH_DEBUG_WITHDRAW === '1') {
      console.log(`[withdraw:debug] stateIn32(state file commitmentHex)=${bytesToHex(stCommit)}`);
    }

    if (a !== b && process.env.BCH_STEALTH_DEBUG_WITHDRAW === '1') {
      console.warn(
        `[withdrawFromShard] WARNING: state.commitmentHex != onchain commitment\n  state=${a}\n  chain=${b}`
      );
    }
  }
} catch {}

  if (process.env.BCH_STEALTH_DEBUG_WITHDRAW === '1') {
    try {
      const stCommit = hexToBytes(shard.commitmentHex);
      console.log(`[withdraw:debug] stateIn32(state file commitmentHex)=${bytesToHex(stCommit)}`);
    } catch {}
  }

  const receiverHash160 = hexToBytes(receiverP2pkhHash160Hex);
  ensureBytesLen(receiverHash160, 20, 'receiverHash160');

  const payment = asBigInt(amountSats, 'amountSats');
  if (payment < DUST_SATS) throw new Error('withdrawFromShard: payment is dust');

  const shardValueIn = asBigInt(shardPrevout.valueSats, 'shardPrevout.valueSats');
  const newShardValue = shardValueIn - payment;

  if (newShardValue < 0n) {
    throw new Error(
      `withdrawFromShard: insufficient shard funds. in=${shardValueIn.toString()} payment=${payment.toString()}`
    );
  }

  // NEW: allow close shard if remainder is 0 or dust (policy-controlled)
  const canKeepShard = newShardValue >= DUST_SATS;
  const willCloseShard = !canKeepShard && policy === 'close-if-dust';

  if (!canKeepShard && !willCloseShard) {
    // old behavior (strict)
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

  if (process.env.BCH_STEALTH_DEBUG_WITHDRAW === '1') {
    console.log(`[withdraw:debug] stateIn32(from on-chain token commitment)=${bytesToHex(stateIn32)}`);
    console.log(`[withdraw:debug] noteHash32=${bytesToHex(nullifier32)}`);
    console.log(`[withdraw:debug] stateOut32(computed)=${bytesToHex(stateOut32)}`);
  }

  const shardUnlock = buildPoolHashFoldUnlockingBytecode({
    version: POOL_HASH_FOLD_VERSION.V1_1,
    limbs,
    noteHash32: nullifier32,
    proofBlob32,
  });

  const tokenOut = makeShardTokenOut({ category32, commitment32: stateOut32 });
  const shardOutSpk = locking.shardLock({ token: tokenOut, redeemScript });

  const paySpk = locking.p2pkh(receiverHash160);

  const changeHash160 = hexToBytes(changeP2pkhHash160Hex ?? feeWallet.pubkeyHash160Hex);
  ensureBytesLen(changeHash160, 20, 'changeHash160');
  const changeSpk = locking.p2pkh(changeHash160);

  // -----------------------------------------------------------------------
  // Dynamic dust threshold for the shard output (token+covenant script is larger than P2PKH)
  // We MUST keep shard output alive until covenant supports "close shard".
  // -----------------------------------------------------------------------
  function dustThresholdForSpk(spkLen: number, feeRateSatPerByte = 1): bigint {
    // Standard-ish dust heuristic: 3 * feeRate * (inputSize + outputSize)
    // Use typical P2PKH input size ~148 bytes.
    const inputSize = 148;
    // outputSize = value(8) + scriptLenVarint(1) + scriptBytes
    const outputSize = 8 + 1 + spkLen;
    return BigInt(3 * feeRateSatPerByte * (inputSize + outputSize));
  }

  const shardDust = dustThresholdForSpk(shardOutSpk.length, 1);

  // Disable close path until covenant supports it.
  // Enforce that remainder is not dust for *the shard output* (not P2PKH dust).
  if (newShardValue < shardDust) {
    throw new Error(
      `withdrawFromShard: shard remainder below shard dust; remainder=${newShardValue.toString()} shardDust=${shardDust.toString()}`
    );
  }

  // Outputs:
  // vout=0 shard (always)
  // vout=1 payment
  // vout=2 fee-change
  const outputs: any[] = [
    { value: newShardValue, scriptPubKey: shardOutSpk }, // shard alive
    { value: payment, scriptPubKey: paySpk },            // payment
    { value: changeValue, scriptPubKey: changeSpk },     // fee change
  ];

  const shardVout = 0;
  const paymentVout = 1;
  const changeVout = 2;

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs: [
      { txid: shardPrevout.txid, vout: shardPrevout.vout, sequence: 0xffffffff }, // covenant
      { txid: feePrevout.txid, vout: feePrevout.vout, sequence: 0xffffffff }, // fee P2PKH
    ],
    outputs,
  };

  const { witnessVin, witnessPrevoutCtx } = appendWitnessInput(tx, witnessPrevout);

  // Phase 2 / v1.1 ABI: covenant input is push-only and NOT signed
  tx.inputs[0].scriptSig = shardUnlock;
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

  // next pool state (close path disabled: shard always continues at vout=0)
  const nextPoolState: PoolState = structuredClone(pool) as PoolState;

  nextPoolState.shards[shardIndex] = {
    ...shard,
    txid: '<pending>',
    vout: shardVout,
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
      remainderPolicy: 'keep',
      willCloseShard: false,
      burnedShardRemainderSats: '0',
      shardDustSats: shardDust.toString(),
    } as any,
  };

  return {
    tx,
    rawTx,
    sizeBytes,
    diagnostics,
    nextPoolState,
    shardVout,
    paymentVout,
    changeVout,
    outputs,
  };
}