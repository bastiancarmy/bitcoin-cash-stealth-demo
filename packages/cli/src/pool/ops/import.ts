// packages/cli/src/pool/ops/import.ts
import type { DepositRecord, PoolState, StealthUtxoRecord } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, getLatestUnimportedDeposit, upsertDeposit } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex, hexToBytes, concat, sha256, uint32le } from '@bch-stealth/utils';
import { deriveRpaOneTimePrivReceiver } from '@bch-stealth/rpa';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState } from '../state.js';
import { toPoolShardsState, patchShardFromNextPoolState } from '../adapters.js';

import { parsePrivKeyInput, decodeWifToPrivBytes, wifVersionHint } from '../wif.js';
import { pubkeyHashFromPriv } from '../../utils.js';

import { deriveSpendPriv32FromScanPriv32 } from '@bch-stealth/rpa-derive';

function shouldDebug(): boolean {
  return (
    process.env.BCH_STEALTH_DEBUG_IMPORT === '1' ||
    process.env.BCH_STEALTH_DEBUG_IMPORT === 'true' ||
    process.env.BCH_STEALTH_DEBUG_IMPORT === 'yes'
  );
}

function parseP2pkhHash160(scriptPubKey: Uint8Array | string): Uint8Array | null {
  const spk = scriptPubKey instanceof Uint8Array ? scriptPubKey : hexToBytes(scriptPubKey);
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
        `  bchctl  pool import --allow-base --deposit-wif <WIF>\n` +
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

function normalizeReceiverSpendPriv(args: {
  scanPriv32: Uint8Array;
  spendPriv32?: Uint8Array | null;
}): { spendPriv32: Uint8Array; wasDerived: boolean; wasOverridden: boolean } {
  const expected = deriveSpendPriv32FromScanPriv32(args.scanPriv32);

  // missing/invalid => derive
  if (!(args.spendPriv32 instanceof Uint8Array) || args.spendPriv32.length !== 32) {
    return { spendPriv32: expected, wasDerived: true, wasOverridden: false };
  }

  // mismatch => override
  const a = bytesToHex(args.spendPriv32).toLowerCase();
  const b = bytesToHex(expected).toLowerCase();
  if (a !== b) {
    return { spendPriv32: expected, wasDerived: false, wasOverridden: true };
  }

  // ok
  return { spendPriv32: args.spendPriv32, wasDerived: false, wasOverridden: false };
}
// --------------------------
// Stealth record bridge helpers
// --------------------------

function outpointKey(txid: string, vout: number): string {
  return `${String(txid).toLowerCase()}:${Number(vout)}`;
}

function readStealthUtxosFromAnyState(stateAny: any): StealthUtxoRecord[] {
  // New envelope (preferred)
  const a = stateAny?.data?.pool?.state?.stealthUtxos;
  if (Array.isArray(a)) return a as StealthUtxoRecord[];

  // Sometimes pool-state object itself might carry stealthUtxos
  const c = stateAny?.pool?.state?.stealthUtxos ?? stateAny?.poolState?.stealthUtxos ?? stateAny?.stealthUtxos;
  if (Array.isArray(c)) return c as StealthUtxoRecord[];

  // Legacy top-level
  const b = stateAny?.stealthUtxos;
  if (Array.isArray(b)) return b as StealthUtxoRecord[];

  return [];
}

function findStealthRecord(stateAny: any, txid: string, vout: number): StealthUtxoRecord | null {
  const k = outpointKey(txid, vout);
  for (const r of readStealthUtxosFromAnyState(stateAny)) {
    const rt = (r as any)?.txid ?? (r as any)?.txidHex;
    const rv = (r as any)?.vout ?? (r as any)?.n;
    if (outpointKey(String(rt), Number(rv)) === k) return r as StealthUtxoRecord;
  }
  return null;
}

/**
 * Attach rpaContext from the scan-recorded stealthUtxo (if present) onto the DepositRecord.
 * This is the key bridge: pool import logic needs rpaContext to derive the one-time key.
 */
function attachRpaContextFromStealthIfMissing(args: {
  stateAny: any;
  dep: DepositRecord;
}): { dep: DepositRecord; source: string } {
  const depAny: any = args.dep as any;

  // already has context
  if (depAny?.rpaContext?.senderPub33Hex && (depAny?.rpaContext?.prevoutHashHex || depAny?.rpaContext?.prevoutTxidHex)) {
    return { dep: args.dep, source: 'already_present' };
  }

  const rec = findStealthRecord(args.stateAny, args.dep.txid, args.dep.vout);
  if (!rec) return { dep: args.dep, source: 'not_found' };

  const ctx = (rec as any)?.rpaContext ?? (rec as any)?.matchedInput ?? null;
  if (!ctx) return { dep: args.dep, source: 'record_missing_context' };

  // Normalize into the fields importDepositToShardOnce expects
  depAny.rpaContext = {
    senderPub33Hex: (ctx as any).senderPub33Hex,
    prevoutHashHex: (ctx as any).prevoutHashHex,
    prevoutTxidHex: (ctx as any).prevoutTxidHex,
    prevoutN: (ctx as any).prevoutN,
    index: (ctx as any).index,
  };

  return {
    dep: depAny as DepositRecord,
    source: Array.isArray(args.stateAny?.data?.pool?.state?.stealthUtxos) ? 'envelope' : 'legacy_or_other',
  };
}

async function importDepositToShardOnce(args: {
  ctx: PoolOpContext;
  poolState: PoolState;
  shardIndex: number;
  depositOutpoint: DepositRecord;
  categoryMode?: string | null;

  baseDepositPrivBytes?: Uint8Array | null;
  allowBaseFlag: boolean;
}): Promise<{ txid: string; built: any; depositKind: 'rpa' | 'base_p2pkh'; expectedH160Hex: string }> {
  const { ctx, poolState, shardIndex, depositOutpoint, categoryMode, allowBaseFlag } = args;
  const st = ensurePoolStateDefaults(poolState);

  if (!st.categoryHex || !st.redeemScriptHex) {
    throw new Error('State missing categoryHex/redeemScriptHex. Run init first or repair state.');
  }

  const shard = st.shards[shardIndex];
  if (!shard) throw new Error(`invalid shardIndex ${shardIndex}`);

  const shardPrev = await ctx.chainIO.getPrevOutput(shard.txid, shard.vout);
  const depositPrev = await ctx.chainIO.getPrevOutput(depositOutpoint.txid, depositOutpoint.vout);

  const expectedH160 = parseP2pkhHash160(depositPrev.scriptPubKey);
  if (!expectedH160) throw new Error('deposit prevout is not P2PKH');
  const expectedH160Hex = bytesToHex(expectedH160);

  let depositKind: 'rpa' | 'base_p2pkh' = 'rpa';
  let depositSignPrivBytes: Uint8Array;
  let depositH160Hex: string;

  const rpaCtx = (depositOutpoint as any).rpaContext;

  // ✅ Fix C: accept prevoutTxidHex OR prevoutHashHex for known stealth deposits
  const hasRpa =
    !!(rpaCtx?.senderPub33Hex && (rpaCtx?.prevoutHashHex || rpaCtx?.prevoutTxidHex) && rpaCtx?.prevoutN != null && rpaCtx?.index != null);

  if (hasRpa) {
    const senderPaycodePub33 = hexToBytes(String(rpaCtx.senderPub33Hex));

    const receiverWallet = ctx.me.wallet;

    const scanPriv32 = receiverWallet.scanPrivBytes ?? receiverWallet.privBytes;
    if (!(scanPriv32 instanceof Uint8Array) || scanPriv32.length !== 32) {
      throw new Error('import: receiver scanPrivBytes must be 32 bytes');
    }
    
    const norm = normalizeReceiverSpendPriv({
      scanPriv32,
      spendPriv32: receiverWallet.spendPrivBytes ?? null,
    });
    
    if (shouldDebug()) {
      if (norm.wasDerived) console.log('[import:debug] spendKey: derived (from scan key)');
      if (norm.wasOverridden) console.log('[import:debug] spendKey: overridden (config mismatch; using derived)');
    }
    
    const prevoutHashHex = (rpaCtx.prevoutHashHex ?? rpaCtx.prevoutTxidHex) as string;
    
    const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
      scanPriv32,
      norm.spendPriv32,
      senderPaycodePub33,
      prevoutHashHex,
      rpaCtx.prevoutN,
      rpaCtx.index
    );

    const { h160 } = pubkeyHashFromPriv(oneTimePriv);
    depositH160Hex = bytesToHex(h160);

    if (depositH160Hex.toLowerCase() !== expectedH160Hex.toLowerCase()) {
      throw new Error(`deposit spend derivation mismatch. expected=${expectedH160Hex} derived=${depositH160Hex}`);
    }

    depositSignPrivBytes = oneTimePriv;
    depositKind = 'rpa';
  } else {
    depositKind = 'base_p2pkh';
    requireBaseImportUnlocks({ allowBaseFlag });

    let baseDepositPrivBytes = args.baseDepositPrivBytes ?? null;

    // If the deposit output is to MY base P2PKH, auto-use MY base key.
    const meH160Hex = bytesToHex(ctx.me.wallet.hash160).toLowerCase();
    if (!baseDepositPrivBytes && expectedH160Hex.toLowerCase() === meH160Hex) {
      baseDepositPrivBytes = ctx.me.wallet.privBytes;
      if (shouldDebug()) {
        console.log(`[import:debug] base import: using my base key (hash160 matched deposit output)`);
      }
    }

    if (!baseDepositPrivBytes) {
      throw new Error(
        `Base import requires a spend key.\n` +
          `Provide one of:\n` +
          `  --deposit-wif <WIF>\n` +
          `  --deposit-privhex <32-byte-hex>\n` +
          `Or deposit directly to your base P2PKH to allow auto-key selection.\n`
      );
    }

    const { h160 } = pubkeyHashFromPriv(baseDepositPrivBytes);
    depositH160Hex = bytesToHex(h160);

    loudBaseImportWarning({
      dep: depositOutpoint,
      expectedH160Hex,
      derivedH160Hex: depositH160Hex,
    });

    if (depositH160Hex.toLowerCase() !== expectedH160Hex.toLowerCase()) {
      throw new Error(
        `Base deposit key mismatch.\n` +
          `deposit output expects h160=${expectedH160Hex}\n` +
          `provided key derives h160=${depositH160Hex}\n`
      );
    }

    depositSignPrivBytes = baseDepositPrivBytes;
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

  const built = PoolShards.importDepositToShard({
    pool,
    shardIndex,
    shardPrevout,
    depositPrevout,
    covenantWallet: {
      signPrivBytes: ctx.me.wallet.privBytes,
      pubkeyHash160Hex: bytesToHex(ctx.me.wallet.hash160),
    },
    depositWallet: {
      signPrivBytes: depositSignPrivBytes,
      pubkeyHash160Hex: depositH160Hex,
    },
    feeSats: BigInt(ctx.config.DEFAULT_FEE),
    categoryMode: categoryMode ?? undefined,
  } as any);

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

// --------------------------
// Your updated runImport (validated + tiny narrowing improvement)
// --------------------------

export async function runImport(
  ctx: PoolOpContext,
  opts: {
    shardIndex?: number | null;
    fresh?: boolean;

    allowBase?: boolean;
    depositWif?: string | null;
    depositPrivHex?: string | null;

    // override outpoint
    depositTxid?: string | null;
    depositVout?: number;
  }
): Promise<{ txid: string; shardIndex: number } | null> {
  const {
    shardIndex: shardIndexOpt = null,
    fresh = false,

    allowBase = false,
    depositWif = null,
    depositPrivHex = null,

    depositTxid = null,
    depositVout = 0,
  } = opts;

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);

  // ensure arrays exist on the pool-state object
  st.deposits ??= [];
  st.withdrawals ??= [];
  st.stealthUtxos ??= [];

  let dep: DepositRecord | null = null;

  if (depositTxid) {
    const txid = String(depositTxid).trim().toLowerCase();
    const vout = Number(depositVout ?? 0);
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error(`invalid --deposit-txid: ${depositTxid}`);
    if (!Number.isFinite(vout) || vout < 0) throw new Error(`invalid --deposit-vout: ${depositVout}`);

    const prev = await ctx.chainIO.getPrevOutput(txid, vout);
    const h160 = parseP2pkhHash160(prev.scriptPubKey);
    if (!h160) throw new Error(`override deposit outpoint is not P2PKH: ${txid}:${vout}`);

    // ✅ non-null local, so TS is happy
    const depOverride: DepositRecord = {
      txid,
      vout,
      valueSats: String(prev.value),
      value: String(prev.value),
      receiverRpaHash160Hex: bytesToHex(h160),
      createdAt: new Date().toISOString(),
    } as any;

    const attached = attachRpaContextFromStealthIfMissing({
      stateAny: st0 as any,
      dep: depOverride,
    });

    dep = attached.dep;

    if (shouldDebug()) {
      console.log(`[import:debug] override deposit: rpaContext source=${attached.source}`);
    }
  } else {
    // ✅ make nullability explicit so TS knows we don't pass null into attachRpaContext...
    const dep0: DepositRecord | null =
      ((st as any).lastDeposit && !(st as any).lastDeposit.importTxid ? (st as any).lastDeposit : null) ??
      getLatestUnimportedDeposit(st, null);

    if (!dep0) return null;

    const attached = attachRpaContextFromStealthIfMissing({
      stateAny: st0 as any,
      dep: dep0,
    });
    dep = attached.dep;

    if (shouldDebug()) {
      console.log(`[import:debug] selected deposit: rpaContext source=${attached.source}`);
    }
  }

  if (!dep) return null;

  // ✅ narrow once for the rest of the function (prevents any lingering nullable inference)
  const depFinal: DepositRecord = dep;

  if (!fresh && (depFinal as any).importTxid) {
    return { txid: (depFinal as any).importTxid, shardIndex: (depFinal as any).importedIntoShard! };
  }

  let stillUnspent = await ctx.chainIO.isP2pkhOutpointUnspent({
    txid: depFinal.txid,
    vout: depFinal.vout,
    hash160Hex: (depFinal as any).receiverRpaHash160Hex,
  });

  if (!stillUnspent) {
    stillUnspent = await ctx.chainIO.waitForP2pkhOutpointUnspent(
      { txid: depFinal.txid, vout: depFinal.vout, hash160Hex: (depFinal as any).receiverRpaHash160Hex },
      { attempts: 12, delayMs: 750 }
    );
  }

  const shardCount = st.shards.length;
  const noteHash = outpointHash32(depFinal.txid, depFinal.vout);
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
    } catch {}
  }

  // If BCH_STEALTH_CATEGORY_MODE is set, use it. Otherwise, attempt default then two compatibility modes.
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
        const rc: any = (depFinal as any)?.rpaContext;
        const hasRpa = !!(rc?.senderPub33Hex && (rc?.prevoutHashHex || rc?.prevoutTxidHex));
        console.log(
          `\n[import:debug] attempting import with categoryMode=${mode ?? '<default>'} rpaCtx=${hasRpa ? 'yes' : 'no'}`
        );
        if (!hasRpa) {
          const rec = findStealthRecord(st0 as any, depFinal.txid, depFinal.vout);
          console.log(`[import:debug] stealthUtxos match: ${rec ? 'yes' : 'no'}`);
        }
      }

      const res = await importDepositToShardOnce({
        ctx,
        poolState: st,
        shardIndex,
        depositOutpoint: depFinal,
        categoryMode: mode,
        baseDepositPrivBytes: basePrivBytes,
        allowBaseFlag: allowBase,
      });

      // Persist deposit record so reruns are deterministic.
      upsertDeposit(st, {
        ...depFinal,
        importedIntoShard: shardIndex,
        importTxid: res.txid,
        depositKind: res.depositKind,
        baseP2pkhHash160Hex: res.depositKind === 'base_p2pkh' ? res.expectedH160Hex : undefined,
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