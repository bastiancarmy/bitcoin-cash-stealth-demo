// packages/cli/src/commands/pool-withdraw-check.ts
import { Command } from 'commander';

import { bytesToHex, hexToBytes, splitCashTokensPrefix, decodeCashTokensPrefix } from '@bch-stealth/utils';
import { ensurePoolStateDefaults } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { validatePoolHashFoldV11UnlockScriptSig } from '@bch-stealth/pool-shards';

import type { PoolOpContext } from '../pool/context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../pool/state.js';
import { toPoolShardsState, patchShardFromNextPoolState } from '../pool/adapters.js';

import { decodeCashAddrToHash160 } from '../pool/ops/withdraw.js';
import { deriveSelfStealthChange, recordDerivedChangeUtxo } from '../stealth/change.js';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { deriveSpendPriv32FromScanPriv32 } from '@bch-stealth/rpa-derive';

import type { Network } from '@bch-stealth/electrum';
import { connectElectrum } from '@bch-stealth/electrum';
import { outpointIsUnspentViaVerboseTx } from '../pool/electrum-unspent.js';

import { deriveStealthP2pkhLock } from '../pool/stealth.js';
import { extractPubKeyFromPaycode } from '../paycodes.js';

function normalizeMode(mode: unknown): string | null {
  if (mode == null) return null;
  const s = String(mode).trim();
  return s.length ? s : null;
}

function debugHeader(title: string) {
  console.log(`\n==================== ${title} ====================`);
}

function getCommitment32FromShardPrevoutScript(scriptPubKey: Uint8Array): Uint8Array {
  const { prefix } = splitCashTokensPrefix(scriptPubKey);
  if (!prefix) throw new Error('shard prevout missing CashTokens prefix (expected tokenized covenant UTXO)');

  const d = decodeCashTokensPrefix(prefix);
  if (!d.commitment || d.commitment.length !== 32) {
    throw new Error(`expected 32-byte NFT commitment in token prefix, got ${d.commitment?.length ?? 0}`);
  }
  return d.commitment;
}

function envFeeMode(): 'from-shard' | 'external' {
  const v = String(process.env.BCH_STEALTH_WITHDRAW_FEE_MODE ?? '').trim().toLowerCase();
  return v === 'external' ? 'external' : 'from-shard';
}

function parseDestToPub33OrH160(dest: string): { paycodePub33?: Uint8Array; p2pkhH160?: Uint8Array } {
  const s = String(dest ?? '').trim();
  if (!s) throw new Error('withdraw-check dest is required');

  if (s.startsWith('PM')) return { paycodePub33: extractPubKeyFromPaycode(s) };
  return { p2pkhH160: decodeCashAddrToHash160(s) };
}

export function registerPoolWithdrawCheck(cmd: Command, getCtx: () => Promise<PoolOpContext>) {
  cmd
    .command('withdraw-check')
    .description(
      'Preflight covenant withdraw: prints shard token prefix + unlock stack. Supports fee-from-shard (default) or external fee input.'
    )
    .argument('<dest>', 'destination: paycode (PM...) or cashaddr (P2PKH)')
    .argument('<amountSats>', 'amount in sats')
    .option('--shard <n>', 'shard index', (v) => Number(v))
    .option('--broadcast', 'broadcast if preflight passes (default: false)', false)
    .option('--category-mode <mode>', 'override category mode (e.g. reverse, direct)')
    .action(async (dest: string, amountSats: string, opts: any) => {
      const ctx = await getCtx();
      console.log(`[cfg] DUST=${ctx.config.DUST} DEFAULT_FEE=${ctx.config.DEFAULT_FEE}`);

      // Must match scan/update-state which records stealthUtxos.owner = <profile>
      const ownerTag = String((ctx as any)?.profile ?? (ctx as any)?.ownerTag ?? '').trim();
      if (!ownerTag) throw new Error('withdraw-check: missing active profile (ownerTag)');

      const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
      const st = ensurePoolStateDefaults(st0);

      if (!st.categoryHex || !st.redeemScriptHex) {
        throw new Error('State missing redeemScriptHex/categoryHex. Run pool init first.');
      }

      const shardIndex = typeof opts.shard === 'number' && Number.isFinite(opts.shard) ? opts.shard : 0;
      const shard = st.shards?.[shardIndex];
      if (!shard) throw new Error(`Unknown shard index ${shardIndex}`);

      const shardPrev = await ctx.chainIO.getPrevOutput(shard.txid, shard.vout);

      debugHeader('WITHDRAW CHECK: SHARD OUTPOINT UNPENT (ELECTRUM)');
      {
        const c = await connectElectrum(ctx.network as unknown as Network);
        try {
          const res = await outpointIsUnspentViaVerboseTx({ c, txid: shard.txid, vout: shard.vout });

          console.log(`[shard ${shardIndex}] ${shard.txid}:${shard.vout} -> ${res.ok ? '✅ unspent' : '❌ spent'}`);
          if (!res.ok && (res as any).spentByTxid) console.log(`  spentBy=${(res as any).spentByTxid}`);
          if ((res as any).spkHex) console.log(`  locking/full spk prefix: ${(res as any).spkHex.slice(0, 16)}…`);

          if (!res.ok) {
            throw new Error(
              `withdraw-check: shard outpoint is spent per history scan: ${shard.txid}:${shard.vout}` +
                ((res as any).spentByTxid ? ` (spentBy=${(res as any).spentByTxid})` : '')
            );
          }
        } finally {
          await c.disconnect().catch(() => {});
        }
      }

      const pool = toPoolShardsState(st, ctx.network);

      const shardPrevout: PoolShards.PrevoutLike = {
        txid: shard.txid,
        vout: shard.vout,
        valueSats: BigInt(shardPrev.value),
        scriptPubKey: shardPrev.scriptPubKey,
      };

      const forcedMode = normalizeMode(opts.categoryMode ?? process.env.BCH_STEALTH_CATEGORY_MODE);

      debugHeader('WITHDRAW CHECK: ON-CHAIN TOKEN PREFIX');
      {
        const { prefix, locking } = splitCashTokensPrefix(shardPrevout.scriptPubKey);
        console.log(`tokenPrefixed=${!!prefix} prefixLen=${prefix?.length ?? 0}`);
        console.log(`locking[0..60]=${bytesToHex(locking).slice(0, 120)}`);
        if (prefix) {
          const d = decodeCashTokensPrefix(prefix);
          console.log(`category32=${bytesToHex(d.category)}`);
          console.log(
            `bitfield=0x${d.bitfield.toString(16)} hasNft=${d.hasNft} hasCommitment=${d.hasCommitment} hasAmount=${d.hasAmount} cap=${d.capability}`
          );
          console.log(`commitmentLen=${d.commitment?.length ?? 0}`);
          if (d.commitment) console.log(`commitment32=${bytesToHex(d.commitment)}`);
        }
      }

      const onchainStateIn32 = getCommitment32FromShardPrevoutScript(shardPrevout.scriptPubKey);

      debugHeader('WITHDRAW CHECK: STATE-IN / STATE-FILE COMPARISON');
      console.log(`stateIn32(on-chain)=${bytesToHex(onchainStateIn32)}`);
      try {
        const stCommit = hexToBytes((shard as any).commitmentHex);
        console.log(`stateIn32(state-file)=${bytesToHex(stCommit)}`);
        if (bytesToHex(stCommit).toLowerCase() !== bytesToHex(onchainStateIn32).toLowerCase()) {
          console.warn('WARNING: state-file commitmentHex differs from on-chain token commitment');
        }
      } catch {
        console.warn('WARNING: could not parse shard.commitmentHex from state');
      }

      const payment = (() => {
        const s = String(amountSats ?? '').trim();
        if (!/^\d+$/.test(s)) throw new Error(`withdraw-check: invalid amountSats "${amountSats}" (expected integer)`);
        return BigInt(s);
      })();

      const feeMode = envFeeMode();
      const useExternalFee = feeMode === 'external';

      debugHeader('WITHDRAW CHECK: FEE MODE');
      console.log(`feeMode=${feeMode} (set BCH_STEALTH_WITHDRAW_FEE_MODE=external to require a fee UTXO)`);

      let feePrevout: PoolShards.PrevoutLike | null = null;
      let feeUtxo: any = null;

      let selfChange: any | null = null;

      // Anchor used for paycode derivations (matches runWithdraw):
      // - fee-from-shard: shard outpoint
      // - external fee: fee outpoint
      let anchorTxidHex = shardPrevout.txid;
      let anchorVout = shardPrevout.vout;

      const feeSats = BigInt(ctx.config.DEFAULT_FEE);

      if (useExternalFee) {
        debugHeader('WITHDRAW CHECK: SELECT EXTERNAL FEE UTXO (Option B: burn dust change)');
        feeUtxo = await selectFundingUtxo({
          mode: 'pool-op',
          state: st,
          wallet: ctx.me.wallet,
          ownerTag,
          minSats: feeSats, // allow fee-sized UTXOs; dust remainder can be burned
          chainIO: ctx.chainIO,
          getUtxos: ctx.getUtxos,
          network: ctx.network,
          dustSats: BigInt(ctx.config.DUST),
        });

        feePrevout = {
          txid: feeUtxo.txid,
          vout: feeUtxo.vout,
          valueSats: BigInt(feeUtxo.prevOut.value),
          scriptPubKey: feeUtxo.prevOut.scriptPubKey,
        };

        anchorTxidHex = feePrevout.txid;
        anchorVout = feePrevout.vout;

        debugHeader('WITHDRAW CHECK: DERIVE SELF-STEALTH CHANGE (EXTERNAL FEE MODE)');
        if (!(ctx.me.paycodePub33 instanceof Uint8Array) || ctx.me.paycodePub33.length !== 33) {
          throw new Error('withdraw-check: ctx.me.paycodePub33 missing/invalid (expected 33 bytes)');
        }

        const selfSpendPriv32 =
          (ctx.me.wallet as any).spendPrivBytes ??
          deriveSpendPriv32FromScanPriv32((ctx.me.wallet as any).scanPrivBytes ?? (ctx.me.wallet as any).privBytes);
        const selfSpendPub33 = secp256k1.getPublicKey(selfSpendPriv32, true);

        selfChange = deriveSelfStealthChange({
          st,
          senderPrivBytes: (ctx.me.wallet as any).privBytes,
          selfPaycodePub33: ctx.me.paycodePub33,
          selfSpendPub33,
          anchorTxidHex,
          anchorVout,
          purpose: 'pool_withdraw_check_change',
          fundingOutpoint: { txid: anchorTxidHex, vout: anchorVout },
        });

        console.log(`change(self-stealth) index=${selfChange.index} anchor=${anchorTxidHex}:${anchorVout}`);
        console.log(`changeHash160Hex=${selfChange.changeHash160Hex}`);
      } else {
        debugHeader('WITHDRAW CHECK: DERIVE SELF-STEALTH CHANGE');
        console.log('fee-from-shard mode → no external fee input and no change output (best privacy).');
        console.log(`anchor(for paycode derivations, if any)=${anchorTxidHex}:${anchorVout}`);
      }

      // -------- destination parsing (PAYCODE OR CASHADDR) --------
      const { paycodePub33, p2pkhH160 } = parseDestToPub33OrH160(dest);

      let receiverH160: Uint8Array | null = null;
      let receiverLockingScript: Uint8Array | undefined;
      let payContext: any = null;

      if (paycodePub33) {
        // Match runWithdraw: use anchor outpoint (fee or shard) for derivation.
        const { intent: payIntent, rpaContext } = deriveStealthP2pkhLock({
          senderWallet: ctx.me.wallet as any,
          receiverPaycodePub33: paycodePub33,
          prevoutTxidHex: anchorTxidHex,
          prevoutN: anchorVout,
          index: 0,
        });

        if (payIntent?.scriptPubKey instanceof Uint8Array) {
          receiverLockingScript = payIntent.scriptPubKey;
          receiverH160 = null;
        } else {
          receiverH160 = payIntent.childHash160;
          receiverLockingScript = undefined;
        }

        payContext = rpaContext;
      } else if (p2pkhH160) {
        receiverH160 = p2pkhH160;
      } else {
        throw new Error('withdraw-check: unable to parse dest (expected paycode or cashaddr)');
      }

      debugHeader('WITHDRAW CHECK: DESTINATION');
      if (paycodePub33) {
        console.log(`destType=paycode`);
        console.log(`receiverPaycodePub33Hex=${bytesToHex(paycodePub33)}`);
        console.log(`anchor=${anchorTxidHex}:${anchorVout}`);
        if (receiverLockingScript) console.log(`receiverLockingScript[0..24]=${bytesToHex(receiverLockingScript).slice(0, 50)}…`);
        if (receiverH160) console.log(`receiverHash160Hex=${bytesToHex(receiverH160)}`);
        if (payContext) console.log(`rpaContext=${JSON.stringify(payContext)}`);
      } else {
        console.log(`destType=cashaddr`);
        console.log(`receiverHash160Hex=${bytesToHex(receiverH160!)}`);
      }

      debugHeader('WITHDRAW CHECK: BUILD TX (NO BROADCAST YET)');
      const built: any = PoolShards.withdrawFromShard({
        pool,
        shardIndex,
        shardPrevout,

        ...(useExternalFee
          ? {
              feePrevout: feePrevout!,
              feeWallet: {
                signPrivBytes: feeUtxo.signPrivBytes,
                pubkeyHash160Hex: bytesToHex(ctx.me.wallet.hash160),
              },
              changeP2pkhHash160Hex: selfChange!.changeHash160Hex, // ok even if change burns/omits
            }
          : {}),

        covenantWallet: {
          signPrivBytes: (ctx.me.wallet as any).privBytes,
          pubkeyHash160Hex: bytesToHex(ctx.me.wallet.hash160),
        },

        ...(receiverLockingScript ? { receiverLockingScript } : { receiverP2pkhHash160Hex: bytesToHex(receiverH160!) }),

        amountSats: payment,
        feeSats,
        categoryMode: forcedMode ?? undefined,
      } as any);

      console.log(`txBytes=${built.rawTx?.length ?? 0}`);
      console.log(`categoryMode=${forcedMode ?? '<default>'}`);
      console.log(`feeMode=${feeMode}`);
      console.log(`built.changeVout=${built.changeVout ?? 'null'}`);

      debugHeader('WITHDRAW CHECK: COVENANT UNLOCK SCRIPT SHAPE');
      {
        const scriptSig: Uint8Array = built.tx?.inputs?.[0]?.scriptSig ?? built.tx?.inputs?.[0]?.unlockingBytecode;
        if (!(scriptSig instanceof Uint8Array)) throw new Error('missing covenant scriptSig bytes');

        validatePoolHashFoldV11UnlockScriptSig(scriptSig, {
          debugPrint: true,
          label: 'withdraw-check vin=0',
        });

        console.log('✅ covenant unlocking stack matches expected v1.1 shape');
      }

      debugHeader('WITHDRAW CHECK: NEXT POOL STATE SUMMARY');
      if (built?.nextPoolState?.shards?.[shardIndex]) {
        console.log(`next.shard[${shardIndex}].commitmentHex=${built.nextPoolState.shards[shardIndex].commitmentHex}`);
        console.log(`next.shard[${shardIndex}].valueSats=${built.nextPoolState.shards[shardIndex].valueSats}`);
      } else {
        console.log('nextPoolState missing shard index');
      }

      if (!opts.broadcast) {
        console.log('\n✅ Preflight complete (no broadcast). Re-run with --broadcast to submit.');
        return;
      }

      debugHeader('BROADCAST');
      const rawHex = bytesToHex(built.rawTx);
      const txid = await ctx.chainIO.broadcastRawTx(rawHex);
      console.log(`✅ broadcast txid=${txid}`);

      // Record stealth change ONLY if builder actually created a change output.
      if (useExternalFee && feePrevout && selfChange && typeof built?.changeVout === 'number') {
        debugHeader('RECORD STEALTH CHANGE (STATE)');

        const changeVout = built.changeVout as number;
        const outVal = built.outputs?.[changeVout]?.value;

        let changeValueSats = 0n;
        if (typeof outVal === 'bigint') changeValueSats = outVal;
        else if (typeof outVal === 'number' && Number.isFinite(outVal)) changeValueSats = BigInt(outVal);
        else if (typeof outVal === 'string' && /^\d+$/.test(outVal)) changeValueSats = BigInt(outVal);

        if (changeValueSats > 0n) {
          recordDerivedChangeUtxo({
            st,
            txid,
            vout: changeVout,
            valueSats: changeValueSats,
            derived: selfChange,
            owner: ownerTag,
            fundingOutpoint: { txid: feePrevout.txid, vout: feePrevout.vout },
          });
          console.log(`✅ recorded stealth change: ${txid}:${changeVout} valueSats=${changeValueSats.toString()}`);
        } else {
          console.log('ℹ change output exists but value is 0; nothing to record');
        }
      } else {
        debugHeader('RECORD STEALTH CHANGE (STATE)');
        console.log('no change output (or fee-from-shard) → nothing to record.');
      }

      patchShardFromNextPoolState({ poolState: st, shardIndex, txid, nextPool: built.nextPoolState });
      await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });

      console.log('✅ state saved');
    });
}