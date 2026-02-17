// packages/pool-shards/src/withdraw.ts
import type { BuilderDeps } from './di.js';

import { bytesToHex, concat, hexToBytes, sha256, uint32le } from '@bch-stealth/utils';

import {
  DEFAULT_CAP_BYTE,
  DEFAULT_CATEGORY_MODE,
  DEFAULT_POOL_HASH_FOLD_VERSION,
  DUST_SATS,
  POOL_HASH_FOLD_VERSION,
} from './policy.js';
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
    throw new Error(`withdrawFromShard: expected 32-byte commitment in token prefix, got ${commitment?.length ?? 0}`);
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

// Small helper: accept either receiverHash160Hex or a full locking script.
function resolveReceiverScript(args: {
  locking: any;
  receiverP2pkhHash160Hex?: string;
  receiverLockingScript?: Uint8Array;
}): Uint8Array {
  const { locking, receiverP2pkhHash160Hex, receiverLockingScript } = args;

  if (receiverLockingScript instanceof Uint8Array) {
    if (receiverLockingScript.length === 0) throw new Error('withdrawFromShard: receiverLockingScript is empty');
    return receiverLockingScript;
  }

  if (!receiverP2pkhHash160Hex) throw new Error('withdrawFromShard: missing receiverP2pkhHash160Hex');
  const receiverHash160 = hexToBytes(receiverP2pkhHash160Hex);
  ensureBytesLen(receiverHash160, 20, 'receiverHash160');
  return locking.p2pkh(receiverHash160);
}

export function withdrawFromShard(args: any) {
  // --- Back-compat / caller normalization ---------------------------------
  const a: any = args ?? {};

  const legacyWallet = a.senderWallet ?? a.ownerWallet ?? a.wallet ?? a.signerWallet ?? a.actorWallet;

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
  // Phase 2: covenant input is NOT signed; only fee P2PKH input is signed (when present).
  if (a.signers?.feePrivBytes) {
    if (!a.feeWallet) a.feeWallet = {};
    a.feeWallet.signPrivBytes = a.signers.feePrivBytes;
  }

  // --- Now destructure from the normalized object --------------------------
  const {
    pool,
    shardIndex,
    shardPrevout,
    feePrevout, // optional now
    feeWallet, // optional if feePrevout not provided
    covenantWallet, // retained for API compat
    receiverP2pkhHash160Hex, // optional if receiverLockingScript provided
    receiverLockingScript, // optional (e.g. paycode-derived P2PKH script)
    amountSats,
    feeSats,
    changeP2pkhHash160Hex, // used only when feePrevout is present
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

  // Derive stateIn from the ON-CHAIN shard prevout token prefix commitment.
  debugShardTokenPrefix(shardPrevout.scriptPubKey);
  const stateIn32 = getCommitment32FromShardPrevoutScript(shardPrevout.scriptPubKey);
  ensureBytesLen(stateIn32, 32, 'stateIn32');

  // Receiver script (P2PKH or direct locking script)
  const paySpk = resolveReceiverScript({
    locking,
    receiverP2pkhHash160Hex,
    receiverLockingScript,
  });

  const payment = asBigInt(amountSats, 'amountSats');
  if (payment < DUST_SATS) throw new Error('withdrawFromShard: payment is dust');

  const fee = feeSats !== undefined ? asBigInt(feeSats, 'feeSats') : 0n;
  const shardValueIn = asBigInt(shardPrevout.valueSats, 'shardPrevout.valueSats');

  // Fee mode:
  // - feePrevout present => external fee input mode
  // - else => fee-from-shard
  const feeFromShard = !feePrevout;

  // Phase 2: ALWAYS KEEP SHARD ALIVE
  const newShardValue = shardValueIn - payment - (feeFromShard ? fee : 0n);

  if (newShardValue < 0n) {
    throw new Error(
      `withdrawFromShard: insufficient shard funds. in=${shardValueIn.toString()} payment=${payment.toString()} feeFromShard=${feeFromShard ? fee.toString() : '0'}`
    );
  }

  // deterministic placeholder update
  const receiverHashForState = sha256(paySpk).slice(0, 20);
  const nullifier32 = sha256(concat(stateIn32, receiverHashForState, sha256(uint32le(Number(payment & 0xffffffffn)))));
  const proofBlob32 = sha256(concat(nullifier32, Uint8Array.of(0x02)));

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
    version: POOL_HASH_FOLD_VERSION.V1_1,
    limbs,
    noteHash32: nullifier32,
    proofBlob32,
  });

  const tokenOut = makeShardTokenOut({ category32, commitment32: stateOut32 });
  const shardOutSpk = locking.shardLock({ token: tokenOut, redeemScript });

  // Dynamic dust threshold for shard output
  function dustThresholdForSpk(spkLen: number, feeRateSatPerByte = 1): bigint {
    const inputSize = 148;
    const outputSize = 8 + 1 + spkLen;
    return BigInt(3 * feeRateSatPerByte * (inputSize + outputSize));
  }
  const shardDust = dustThresholdForSpk(shardOutSpk.length, 1);

  if (newShardValue < shardDust) {
    throw new Error(
      `withdrawFromShard: shard remainder below shard dust; remainder=${newShardValue.toString()} shardDust=${shardDust.toString()}`
    );
  }

  // Outputs:
  // vout=0 shard
  // vout=1 payment
  // vout=2 change (only if feePrevout present AND change >= dust)
  const outputs: any[] = [
    { value: newShardValue, scriptPubKey: shardOutSpk },
    { value: payment, scriptPubKey: paySpk },
  ];

  let changeVout: number | null = null;
  let changeValue: bigint | null = null;
  let feeValue: bigint | null = null;

  if (!feeFromShard) {
    if (!feeWallet?.signPrivBytes) {
      throw new Error('withdrawFromShard: missing feeWallet.signPrivBytes (required when feePrevout is provided)');
    }
    if (!changeP2pkhHash160Hex) {
      throw new Error('withdrawFromShard: missing changeP2pkhHash160Hex (required when feePrevout is provided)');
    }

    feeValue = asBigInt(feePrevout.valueSats, 'feePrevout.valueSats');
    changeValue = feeValue - fee;
    if (changeValue < 0n) throw new Error('withdrawFromShard: fee prevout too small after fee');

    // Option B: burn dust change as extra fee (omit change output)
    if (changeValue > 0n && changeValue < DUST_SATS) {
      changeValue = 0n;
      changeVout = null;
    } else if (changeValue === 0n) {
      changeVout = null;
    } else {
      const changeHash160 = hexToBytes(changeP2pkhHash160Hex);
      ensureBytesLen(changeHash160, 20, 'changeHash160');
      const changeSpk = locking.p2pkh(changeHash160);

      changeVout = outputs.length;
      outputs.push({ value: changeValue, scriptPubKey: changeSpk });
    }
  }

  // Inputs:
  const inputs: any[] = [{ txid: shardPrevout.txid, vout: shardPrevout.vout, sequence: 0xffffffff }];

  const feeVin = feeFromShard ? null : 1;
  if (!feeFromShard) {
    inputs.push({ txid: feePrevout.txid, vout: feePrevout.vout, sequence: 0xffffffff });
  }

  const tx: any = {
    version: 2,
    locktime: 0,
    inputs,
    outputs,
  };

  const { witnessVin, witnessPrevoutCtx } = appendWitnessInput(tx, witnessPrevout);

  // Covenant input: push-only, not signed
  tx.inputs[0].scriptSig = shardUnlock;
  maybeValidateCovenantScriptSig('withdrawFromShard vin=0', tx.inputs[0].scriptSig);

  // Authorize fee input only in external-fee mode
  if (!feeFromShard) {
    auth.authorizeP2pkhInput({
      tx,
      vin: feeVin!,
      privBytes: feeWallet.signPrivBytes,
      prevout: {
        valueSats: feePrevout.valueSats,
        scriptPubKey: feePrevout.scriptPubKey,
      },
      witnessVin,
      witnessPrevout: witnessPrevoutCtx,
    });
  }

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

  // next pool state
  const nextPoolState: PoolState = structuredClone(pool) as PoolState;
  nextPoolState.shards[shardIndex] = {
    ...shard,
    txid: '<pending>',
    vout: 0,
    valueSats: newShardValue.toString(),
    commitmentHex: bytesToHex(stateOut32),
  };

  // Effective fee reporting
  const burnedDustChange = !feeFromShard && changeValue === 0n && feeValue !== null && feeValue > fee;
  const effectiveFeeSats = feeFromShard ? fee : burnedDustChange ? feeValue! : fee;

  const diagnostics: WithdrawDiagnostics = {
    shardIndex,
    receiverHash160Hex: receiverP2pkhHash160Hex ?? '',
    amountSats: payment.toString(),
    feeSats: effectiveFeeSats.toString(), // ✅ FIXED
    changeSats: changeValue ? changeValue.toString() : '0',
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
      feeFromShard: feeFromShard,
      burnedDustChange: burnedDustChange ? '1' : '0',
    } as any,
  };

  return {
    tx,
    rawTx,
    sizeBytes,
    diagnostics,
    nextPoolState,
    shardVout: 0,
    paymentVout: 1,
    changeVout,
    outputs,
  };
}