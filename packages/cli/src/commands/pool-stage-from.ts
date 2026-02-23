// packages/cli/src/commands/pool-stage-from.ts
import type { Command } from 'commander';

import type { DepositRecord, StealthUtxoRecord } from '@bch-stealth/pool-state';
import { FileBackedPoolStateStore, ensurePoolStateDefaults, upsertDeposit } from '@bch-stealth/pool-state';

import { NETWORK } from '../config.js';
import { loadStateOrEmpty, saveState } from '../pool/state.js';

function parseOutpointOrThrow(outpoint: string): { txid: string; vout: number } {
  const [txidRaw, voutRaw] = String(outpoint).split(':');
  const txid = String(txidRaw ?? '').trim().toLowerCase();
  const vout = Number(String(voutRaw ?? '0').trim());

  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`invalid outpoint txid (expected 64-hex): ${outpoint}`);
  if (!Number.isFinite(vout) || vout < 0) throw new Error(`invalid outpoint vout: ${outpoint}`);

  return { txid, vout };
}

function outpointKey(txid: string, vout: number): string {
  return `${String(txid).toLowerCase()}:${Number(vout)}`;
}

/**
 * The state JSON has moved around during development. This helper tolerates a few known layouts.
 */
function readStealthUtxosFromAnyState(stateAny: any): StealthUtxoRecord[] {
  const pools: any[] = [];

  const pushIfArray = (v: any) => {
    if (Array.isArray(v)) pools.push(v);
  };

  // Most common shapes we've used:
  pushIfArray(stateAny?.data?.stealthUtxos);
  pushIfArray(stateAny?.data?.pool?.state?.stealthUtxos);
  pushIfArray(stateAny?.stealthUtxos);

  // (Optional) tolerate additional nesting if introduced later:
  pushIfArray(stateAny?.data?.wallet?.stealthUtxos);
  pushIfArray(stateAny?.data?.rpa?.stealthUtxos);
  pushIfArray(stateAny?.wallet?.stealthUtxos);
  pushIfArray(stateAny?.rpa?.stealthUtxos);
  pushIfArray(stateAny?.pool?.stealthUtxos);

  // flatten
  return pools.flat() as StealthUtxoRecord[];
}

function computeOutpointFromStealthRecord(r: any): string | null {
  // Case A: explicit outpoint string on the record
  const op = typeof r?.outpoint === 'string' ? r.outpoint.trim().toLowerCase() : '';
  if (op && /^[0-9a-f]{64}:\d+$/i.test(op)) return op;

  // Case B: txid + vout/n
  const txid = String(r?.txid ?? r?.txidHex ?? '').trim().toLowerCase();
  const vout = Number(r?.vout ?? r?.n);

  if (!/^[0-9a-f]{64}$/i.test(txid)) return null;
  if (!Number.isFinite(vout) || vout < 0) return null;

  return outpointKey(txid, vout);
}

/**
 * Robust match:
 * - supports record.outpoint = "txid:vout"
 * - supports record.txid/txidHex + record.vout/n
 */
function findStealthRecord(stateAny: any, txid: string, vout: number): StealthUtxoRecord | null {
  const want = outpointKey(txid, vout);

  for (const r of readStealthUtxosFromAnyState(stateAny)) {
    const got = computeOutpointFromStealthRecord(r);
    if (got && got === want) return r as StealthUtxoRecord;
  }

  return null;
}

function sampleOutpoints(stateAny: any, limit = 12): string[] {
  const out: string[] = [];
  for (const r of readStealthUtxosFromAnyState(stateAny)) {
    const op = computeOutpointFromStealthRecord(r);
    if (op) out.push(op);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Register:
 *   pool stage-from <outpoint> [--json]
 *
 * This does NOT create a transaction.
 * It promotes a known stealth/rpa UTXO (already in stealthUtxos via scan) into state.deposits
 * so it can be ingested via `pool import`.
 */
export function registerPoolStageFrom(pool: Command, deps: { getActivePaths: () => { stateFile: string } }) {
  pool
    .command('stage-from')
    .description('Promote a scanned RPA UTXO (txid:vout) into staged deposits (no new tx).')
    .argument('<outpoint>', 'outpoint as txid:vout')
    .option('--json', 'print raw JSON', false)
    .action(async (outpointArg, opts) => {
      const { stateFile } = deps.getActivePaths();
      const store = new FileBackedPoolStateStore({ filename: stateFile });

      const { txid, vout } = parseOutpointOrThrow(String(outpointArg));

      const st0 = await loadStateOrEmpty({ store, networkDefault: String(NETWORK) });
      const st = ensurePoolStateDefaults(st0, String(NETWORK));

      // ✅ robust lookup (supports record.outpoint or record.txid/vout)
      const rec = findStealthRecord(st0 as any, txid, vout);
      if (!rec) {
        const examples = sampleOutpoints(st0 as any, 12);
        const hint = examples.length ? `\nExamples in state:\n  - ${examples.join('\n  - ')}` : '';

        throw new Error(
          `stage-from: stealthUtxo not found for ${txid}:${vout}\n` +
            `Tip: run scan --include-mempool --update-state and ensure it is recorded in state.stealthUtxos first.\n` +
            `stateFile: ${stateFile}${hint}`
        );
      }

      const valueSats = String((rec as any)?.valueSats ?? (rec as any)?.value ?? '0');
      const receiverRpaHash160Hex = String((rec as any)?.hash160Hex ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(receiverRpaHash160Hex)) {
        throw new Error(`stage-from: missing/invalid hash160Hex on stealth record for ${txid}:${vout}`);
      }

      const ctxAny = (rec as any)?.rpaContext ?? (rec as any)?.matchedInput ?? null;

      const dep: DepositRecord = {
        txid,
        vout,
        valueSats,
        value: valueSats,
        receiverRpaHash160Hex,
        createdAt: new Date().toISOString(),

        // attach rpaContext if we have it; import will use it for derivation check
        rpaContext: ctxAny
          ? {
              senderPub33Hex: (ctxAny as any).senderPub33Hex,
              prevoutHashHex: (ctxAny as any).prevoutHashHex ?? (ctxAny as any).prevoutTxidHex,
              prevoutTxidHex: (ctxAny as any).prevoutTxidHex ?? (ctxAny as any).prevoutHashHex,
              prevoutN: (ctxAny as any).prevoutN,
              index: (ctxAny as any).index,
            }
          : undefined,

        depositKind: 'rpa',
        warnings: ['PROMOTED_FROM_STEALTH_UTXO'],
      } as any;

      upsertDeposit(st, dep as any);
      await saveState({ store, state: st, networkDefault: String(NETWORK) });

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              meta: { stateFile, network: String(NETWORK) },
              deposit: dep,
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`staged deposit: ${txid}:${vout}`);
      console.log(`state saved: ${stateFile}`);
    });
}