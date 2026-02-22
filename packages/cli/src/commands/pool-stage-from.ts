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

function readStealthUtxosFromAnyState(stateAny: any): StealthUtxoRecord[] {
  const a = stateAny?.data?.stealthUtxos;
  if (Array.isArray(a)) return a as StealthUtxoRecord[];

  const b = stateAny?.data?.pool?.state?.stealthUtxos;
  if (Array.isArray(b)) return b as StealthUtxoRecord[];

  const c = stateAny?.stealthUtxos;
  if (Array.isArray(c)) return c as StealthUtxoRecord[];

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

      const rec = findStealthRecord(st0 as any, txid, vout);
      if (!rec) {
        throw new Error(
          `stage-from: stealthUtxo not found for ${txid}:${vout}\n` +
            `Tip: run scan (include mempool) and ensure it is recorded in state.stealthUtxos first.`
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