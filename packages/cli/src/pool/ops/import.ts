// packages/cli/src/pool/ops/import.ts
import type { DepositRecord, PoolState } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, getLatestUnimportedDeposit, upsertDeposit } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex, hexToBytes, concat, sha256, hash160, uint32le } from '@bch-stealth/utils';
import { deriveRpaOneTimePrivReceiver } from '@bch-stealth/rpa';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState } from '../state.js';
import { toPoolShardsState, patchShardFromNextPoolState } from '../adapters.js';

import { parsePrivKeyInput, decodeWifToPrivBytes, wifVersionHint } from '../wif.js';

function shouldDebug(): boolean {
  return (
    process.env.BCH_STEALTH_DEBUG_IMPORT === '1' ||
    process.env.BCH_STEALTH_DEBUG_IMPORT === 'true' ||
    process.env.BCH_STEALTH_DEBUG_IMPORT === 'yes'
  );
}

function scriptContainsHash160(scriptPubKey: Uint8Array, h160: Uint8Array): boolean {
  const spkHex = bytesToHex(scriptPubKey).toLowerCase();
  const needle = bytesToHex(h160).toLowerCase();
  return spkHex.includes(needle);
}

function pickCovenantSignerWallet(ctx: PoolOpContext, shardScriptPubKey: Uint8Array) {
  const a = ctx.actors.actorABaseWallet;
  const b = ctx.actors.actorBBaseWallet;

  const hasA = scriptContainsHash160(shardScriptPubKey, a.hash160);
  const hasB = scriptContainsHash160(shardScriptPubKey, b.hash160);

  if (shouldDebug()) {
    console.log(`[import:debug] covenant signer search: contains(A.h160)=${hasA} contains(B.h160)=${hasB}`);
    console.log(`[import:debug] A.h160=${bytesToHex(a.hash160)} B.h160=${bytesToHex(b.hash160)}`);
  }

  if (hasA && !hasB) return { wallet: a, ownerTag: 'A' as const };
  if (hasB && !hasA) return { wallet: b, ownerTag: 'B' as const };

  if (shouldDebug()) {
    console.log(`[import:debug] WARNING: ambiguous covenant signer (both/neither h160 found). Defaulting to actor B.`);
  }
  return { wallet: b, ownerTag: 'B' as const };
}

function parseP2pkhHash160(scriptPubKey: Uint8Array | string): Uint8Array | null {
  const spk = scriptPubKey instanceof Uint8Array ? scriptPubKey : hexToBytes(scriptPubKey);
  // OP_DUP OP_HASH160 PUSH20 <20B> OP_EQUALVERIFY OP_CHECKSIG
  if (
    spk.length === 25 &&
    spk[0] === 0x76 &&
    spk[1] === 0xa9 &&
    spk[2] === 0x14 &&
    spk[23] === 0x88 &&
    spk[24] === 0xac
  ) {
    return spk.slice(3, 23);
  }
  return null;
}

function pubkeyHashFromPriv(privBytes: Uint8Array): { pub: Uint8Array; h160: Uint8Array } {
  const pub = secp256k1.getPublicKey(privBytes, true);
  const h160 = hash160(pub);
  return { pub, h160 };
}

/** Derive a stable 32-byte hash for an outpoint (demo placeholder). */
function outpointHash32(txidHex: string, vout: number): Uint8Array {
  const txid = hexToBytes(txidHex);
  const n = uint32le(vout >>> 0);
  return sha256(concat(txid, n));
}

function looksLikeOpEqualVerifyFailure(err: unknown): boolean {
  const s = String((err as any)?.message ?? err ?? '').toLowerCase();
  return (
    s.includes('op_equalverify') ||
    s.includes('mandatory-script-verify-flag-failed') ||
    s.includes('script failed') ||
    s.includes('code 16')
  );
}

function normalizeMode(mode: unknown): string | null {
  if (mode == null) return null;
  const s = String(mode).trim();
  return s.length ? s : null;
}

function parseBoolishEnv(name: string): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

function requireBaseImportUnlocks(args: { allowBaseFlag: boolean }) {
  if (!args.allowBaseFlag) {
    throw new Error(
      `Refusing to import a NON-RPA (base P2PKH) deposit without --allow-base.\n` +
        `This deposit is not stealth. If you intended to import fused coins, re-run with:\n` +
        `  bch-stealth pool import --allow-base --deposit-wif <WIF>\n` +
        `And also set:\n` +
        `  BCH_STEALTH_ALLOW_BASE_IMPORT=1`
    );
  }
  if (!parseBoolishEnv('BCH_STEALTH_ALLOW_BASE_IMPORT')) {
    throw new Error(
      `Refusing base import: missing hard env unlock.\n` +
        `Set BCH_STEALTH_ALLOW_BASE_IMPORT=1 and re-run.\n` +
        `This guard exists to prevent accidental non-stealth imports.`
    );
  }
}

function loudBaseImportWarning(args: { dep: DepositRecord; expectedH160Hex: string; derivedH160Hex: string }) {
  console.warn(
    `\n⚠️  BASE P2PKH IMPORT (NOT STEALTH)\n` +
      `  deposit: ${args.dep.txid}:${args.dep.vout}\n` +
      `  expected P2PKH h160: ${args.expectedH160Hex}\n` +
      `  provided key h160:   ${args.derivedH160Hex}\n` +
      `  This path is intended for advanced workflows (e.g. importing CashFusion outputs).\n` +
      `  You are responsible for ensuring your coins are adequately mixed BEFORE deposit/import.\n`
  );
}

/**
 * Minimal debug helper:
 * - prints prefix of scriptPubKey hex
 * - searches for known substrings (categoryHex, commitmentHex) in the scriptPubKey hex
 */
function debugScriptSearch(args: {
  label: string;
  scriptPubKey: Uint8Array;
  categoryHex?: string | null;
  commitmentHex?: string | null;
  extraNeedleHex?: string | null;
}) {
  if (!shouldDebug()) return;

  const spkHex = bytesToHex(args.scriptPubKey).toLowerCase();
  const cat = (args.categoryHex ?? '').toLowerCase();
  const com = (args.commitmentHex ?? '').toLowerCase();
  const extra = (args.extraNeedleHex ?? '').toLowerCase();

  const loc = (needle: string) => {
    if (!needle) return -1;
    return spkHex.indexOf(needle);
  };

  console.log(`\n[import:debug] ${args.label}`);
  console.log(`[import:debug]   spkHex[0..160): ${spkHex.slice(0, 160)}${spkHex.length > 160 ? '…' : ''}`);

  if (cat) console.log(`[import:debug]   contains categoryHex? idx=${loc(cat)}`);
  if (com) console.log(`[import:debug]   contains commitmentHex? idx=${loc(com)}`);
  if (extra) console.log(`[import:debug]   contains extraNeedleHex? idx=${loc(extra)}`);
}

async function importDepositToShardOnce(args: {
  ctx: PoolOpContext;
  poolState: PoolState;
  shardIndex: number;
  depositOutpoint: DepositRecord;
  categoryMode?: string | null;

  // base-import key material (already parsed to bytes)
  baseDepositPrivBytes?: Uint8Array | null;
  allowBaseFlag: boolean;
}): Promise<{ txid: string; built: any; depositKind: 'rpa' | 'base_p2pkh'; expectedH160Hex: string }> {
  const { ctx, poolState, shardIndex, depositOutpoint, categoryMode, baseDepositPrivBytes, allowBaseFlag } = args;
  const st = ensurePoolStateDefaults(poolState);

  const shard = st.shards[shardIndex];
  if (!shard) throw new Error(`invalid shardIndex ${shardIndex}`);

  const shardPrev = await ctx.chainIO.getPrevOutput(shard.txid, shard.vout);
  const depositPrev = await ctx.chainIO.getPrevOutput(depositOutpoint.txid, depositOutpoint.vout);

  // ✅ Covenant signer must match the h160 embedded in the shard locking script.
  const covenantSigner = pickCovenantSignerWallet(ctx, shardPrev.scriptPubKey);
  const covenantSignerWallet = covenantSigner.wallet;

  if (shouldDebug()) {
    console.log(`[import:debug] covenantSigner=${covenantSigner.ownerTag}`);
  }

  debugScriptSearch({
    label: `shard prevout ${shard.txid}:${shard.vout}`,
    scriptPubKey: shardPrev.scriptPubKey,
    categoryHex: st.categoryHex ?? null,
    commitmentHex: shard.commitmentHex ?? null,
  });

  debugScriptSearch({
    label: `deposit prevout ${depositOutpoint.txid}:${depositOutpoint.vout}`,
    scriptPubKey: depositPrev.scriptPubKey,
  });

  const expectedH160 = parseP2pkhHash160(depositPrev.scriptPubKey);
  if (!expectedH160) throw new Error('deposit prevout is not P2PKH');
  const expectedH160Hex = bytesToHex(expectedH160);

  // ------------------------------------------------------------
  // Branch A: RPA (existing behavior)
  // Branch B: BASE P2PKH (new; guarded)
  // ------------------------------------------------------------
  let depositKind: 'rpa' | 'base_p2pkh' = 'rpa';

  let depositSignPrivBytes: Uint8Array;
  let depositH160Hex: string;

  const rpaCtx = depositOutpoint.rpaContext;

  if (rpaCtx?.senderPub33Hex && rpaCtx?.prevoutHashHex) {
    // ---- RPA path ----
    // ✅ Fix discrepancy: keep senderPub33 scoped and consistently named.
    const senderPaycodePub33 = hexToBytes(rpaCtx.senderPub33Hex);

    // Receiver is the stealth recipient (Actor B) in this demo.
    const receiverWallet = ctx.actors.actorBBaseWallet;

    const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
      receiverWallet.scanPrivBytes ?? receiverWallet.privBytes,
      receiverWallet.spendPrivBytes ?? receiverWallet.privBytes,
      senderPaycodePub33,
      rpaCtx.prevoutHashHex,
      rpaCtx.prevoutN,
      rpaCtx.index
    );

    const { h160 } = pubkeyHashFromPriv(oneTimePriv);
    depositH160Hex = bytesToHex(h160);

    if (depositH160Hex !== expectedH160Hex) {
      throw new Error(`deposit spend derivation mismatch. expected=${expectedH160Hex} derived=${depositH160Hex}`);
    }

    depositSignPrivBytes = oneTimePriv;
    depositKind = 'rpa';
  } else {
    // ---- BASE P2PKH path ----
    depositKind = 'base_p2pkh';

    requireBaseImportUnlocks({ allowBaseFlag });

    if (!baseDepositPrivBytes) {
      throw new Error(
        `Base import requires a spend key.\n` +
          `Provide one of:\n` +
          `  --deposit-wif <WIF>\n` +
          `  --deposit-privhex <32-byte-hex>\n`
      );
    }

    const { h160 } = pubkeyHashFromPriv(baseDepositPrivBytes);
    depositH160Hex = bytesToHex(h160);

    loudBaseImportWarning({
      dep: depositOutpoint,
      expectedH160Hex,
      derivedH160Hex: depositH160Hex,
    });

    if (depositH160Hex !== expectedH160Hex) {
      throw new Error(
        `Base deposit key mismatch.\n` +
          `deposit output expects h160=${expectedH160Hex}\n` +
          `provided key derives h160=${depositH160Hex}\n`
      );
    }

    depositSignPrivBytes = baseDepositPrivBytes;
  }

  if (!st.categoryHex || !st.redeemScriptHex) {
    throw new Error('State missing categoryHex/redeemScriptHex. Run init first or repair state.');
  }

  const pool = toPoolShardsState(st, ctx.network);

  const shardPrevout: PoolShards.PrevoutLike = {
    txid: shard.txid,
    vout: shard.vout,
    valueSats: BigInt(shardPrev.value),
    scriptPubKey: shardPrev.scriptPubKey,
  };

  const depositPrevout: PoolShards.PrevoutLike = {
    txid: depositOutpoint.txid,
    vout: depositOutpoint.vout,
    valueSats: BigInt(depositPrev.value),
    scriptPubKey: depositPrev.scriptPubKey,
  };

  // ✅ FIX: covenantWallet must use signer matching shard script h160
  const covenantWallet: PoolShards.WalletLike = {
    signPrivBytes: covenantSignerWallet.privBytes,
    pubkeyHash160Hex: bytesToHex(covenantSignerWallet.hash160),
  };

  // Deposit wallet is constructed directly from derived (RPA) or provided (base) key.
  const depositWallet: PoolShards.WalletLike = {
    signPrivBytes: depositSignPrivBytes,
    pubkeyHash160Hex: depositH160Hex,
  };

  const built = PoolShards.importDepositToShard({
    pool,
    shardIndex,
    shardPrevout,
    depositPrevout,
    covenantWallet,
    depositWallet,
    feeSats: BigInt(ctx.config.DEFAULT_FEE),
    categoryMode: categoryMode ?? undefined,
  } as any);

  const out0 = built?.tx?.outputs?.[0];
  const out0Spk: Uint8Array | undefined = out0?.scriptPubKey;
  const stateOutHex: string | null =
    typeof built?.diagnostics?.stateOut32Hex === 'string' ? built.diagnostics.stateOut32Hex : null;

  if (out0Spk instanceof Uint8Array) {
    debugScriptSearch({
      label: `built output[0] (shard) mode=${categoryMode ?? '<default>'}`,
      scriptPubKey: out0Spk,
      categoryHex: st.categoryHex ?? null,
      commitmentHex: stateOutHex,
      extraNeedleHex: shard.commitmentHex ?? null,
    });
  }

  if (shouldDebug()) {
    console.log(`[import:debug] built diagnostics:`, {
      shardIndex,
      categoryMode: categoryMode ?? '<default>',
      category32Hex: built?.diagnostics?.category32Hex,
      stateIn32Hex: built?.diagnostics?.stateIn32Hex,
      stateOut32Hex: built?.diagnostics?.stateOut32Hex,
      noteHash32Hex: built?.diagnostics?.noteHash32Hex,
      feeSats: built?.diagnostics?.feeSats,
      newShardValueSats: built?.diagnostics?.newShardValueSats,
      depositKind,
      covenantSigner: covenantSigner.ownerTag,
    });
  }

  const rawHex = bytesToHex(built.rawTx);
  const txid = await ctx.chainIO.broadcastRawTx(rawHex);

  patchShardFromNextPoolState({
    poolState: st,
    shardIndex,
    txid,
    nextPool: built.nextPoolState,
  });

  return { txid, built, depositKind, expectedH160Hex };
}

export async function runImport(
  ctx: PoolOpContext,
  opts: {
    shardIndex?: number | null;
    fresh?: boolean;

    allowBase?: boolean;
    depositWif?: string | null;
    depositPrivHex?: string | null;
  }
): Promise<{ txid: string; shardIndex: number } | null> {
  const {
    shardIndex: shardIndexOpt = null,
    fresh = false,

    allowBase = false,
    depositWif = null,
    depositPrivHex = null,
  } = opts;

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);
  st.deposits ??= [];
  st.withdrawals ??= [];
  st.stealthUtxos ??= [];

  const dep =
    ((st as any).lastDeposit && !(st as any).lastDeposit.importTxid ? (st as any).lastDeposit : null) ??
    getLatestUnimportedDeposit(st, null);

  if (!dep) return null;

  if (!fresh && dep.importTxid) {
    return { txid: dep.importTxid, shardIndex: dep.importedIntoShard! };
  }

  let stillUnspent = await ctx.chainIO.isP2pkhOutpointUnspent({
    txid: dep.txid,
    vout: dep.vout,
    hash160Hex: dep.receiverRpaHash160Hex,
  });

  if (!stillUnspent) {
    stillUnspent = await ctx.chainIO.waitForP2pkhOutpointUnspent(
      { txid: dep.txid, vout: dep.vout, hash160Hex: dep.receiverRpaHash160Hex },
      { attempts: 12, delayMs: 750 }
    );
  }

  const shardCount = st.shards.length;
  const noteHash = outpointHash32(dep.txid, dep.vout);
  const derivedIndex = noteHash[0] % shardCount;

  const shardIndex =
    shardIndexOpt == null ? derivedIndex : Math.max(0, Math.min(shardCount - 1, Number(shardIndexOpt)));

  const basePrivBytes = parsePrivKeyInput({ wif: depositWif, privHex: depositPrivHex });

  if (depositWif) {
    try {
      const decoded = decodeWifToPrivBytes(depositWif);
      if (shouldDebug()) {
        console.log(
          `[import:debug] deposit-wif version=${wifVersionHint(decoded.version)} compressed=${decoded.compressed}`
        );
      }
    } catch {
      // ignore
    }
  }

  const forcedMode = normalizeMode(process.env.BCH_STEALTH_CATEGORY_MODE);
  const modeCandidatesRaw: (string | null)[] = forcedMode ? [forcedMode] : [null, 'reverse', 'raw'];

  const seen = new Set<string>();
  const modeCandidates = modeCandidatesRaw.filter((m) => {
    const k = m == null ? '<default>' : m;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  let lastErr: unknown = null;

  for (const mode of modeCandidates) {
    try {
      if (shouldDebug()) {
        console.log(`\n[import:debug] attempting import with categoryMode=${mode ?? '<default>'}`);
      }

      const res = await importDepositToShardOnce({
        ctx,
        poolState: st,
        shardIndex,
        depositOutpoint: dep,
        categoryMode: mode,

        baseDepositPrivBytes: basePrivBytes,
        allowBaseFlag: allowBase,
      });

      const warnings: string[] = [];
      if (res.depositKind === 'base_p2pkh') {
        warnings.push('BASE_P2PKH_IMPORT_NOT_STEALTH');
        warnings.push('User asserted provenance/mixing externally (e.g. CashFusion).');
      }

      upsertDeposit(st, {
        ...dep,
        importedIntoShard: shardIndex,
        importTxid: res.txid,

        depositKind: res.depositKind,
        baseP2pkhHash160Hex: res.depositKind === 'base_p2pkh' ? res.expectedH160Hex : undefined,
        warnings: warnings.length ? warnings : (dep as any).warnings,
      } as any);

      await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });
      return { txid: res.txid, shardIndex };
    } catch (err) {
      lastErr = err;

      if (shouldDebug()) {
        console.log(`[import:debug] failed mode=${mode ?? '<default>'}: ${String((err as any)?.message ?? err)}`);
      }

      if (!looksLikeOpEqualVerifyFailure(err)) break;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}