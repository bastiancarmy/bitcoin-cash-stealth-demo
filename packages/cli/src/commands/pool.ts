// packages/cli/src/commands/pool.ts
import type { Command } from 'commander';
import type { Network } from '@bch-stealth/electrum';

import { connectElectrum } from '@bch-stealth/electrum';
import {
  FileBackedPoolStateStore,
  POOL_STATE_STORE_KEY,
  ensurePoolStateDefaults,
  getLatestUnimportedDeposit,
  markStealthSpent,
} from '@bch-stealth/pool-state';
import { bytesToHex, hexToBytes, reverseBytes, sha256 } from '@bch-stealth/utils';

import { DUST, NETWORK } from '../config.js';

import { runInit } from '../pool/ops/init.js';
import { runImport } from '../pool/ops/import.js';
import { runWithdraw } from '../pool/ops/withdraw.js';

import { registerPoolWithdrawCheck } from './pool-withdraw-check.js';
import { loadStateOrEmpty, saveState } from '../pool/state.js';

export type MakePoolCtx = () => Promise<any>;
export type GetActivePaths = () => { stateFile: string };

function getOrCreateSubcommand(program: Command, name: string, description: string): Command {
  const existing = (program.commands ?? []).find((c) => c.name() === name);
  if (existing) return existing;
  return program.command(name).description(description);
}

function parseOutpointOrThrow(outpoint: string): { txid: string; vout: number } {
  const [txidRaw, voutRaw] = String(outpoint).split(':');
  const txid = String(txidRaw ?? '').trim();
  const vout = Number(String(voutRaw ?? '0').trim());

  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`invalid outpoint txid (expected 64-hex): ${outpoint}`);
  if (!Number.isFinite(vout) || vout < 0) throw new Error(`invalid outpoint vout: ${outpoint}`);

  return { txid: txid.toLowerCase(), vout };
}

function shortHex(x: any, n = 10): string {
  const s = String(x ?? '');
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function isOutpointUnspentByLockingScript(args: {
  network: Network;
  txid: string;
  vout: number;
  lockingBytecodeHex: string;
}): Promise<boolean> {
  const script = hexToBytes(args.lockingBytecodeHex);
  const scripthash = bytesToHex(reverseBytes(sha256(script)));

  const c = await connectElectrum(args.network);
  try {
    const utxos = await c.request('blockchain.scripthash.listunspent', scripthash);
    if (!Array.isArray(utxos)) return false;

    const wantTxid = args.txid.toLowerCase();
    const wantVout = Number(args.vout);

    return utxos.some(
      (u: any) => String(u?.tx_hash ?? '').toLowerCase() === wantTxid && Number(u?.tx_pos) === wantVout
    );
  } finally {
    await c.disconnect().catch(() => {});
  }
}

export function registerPoolCommands(
  program: Command,
  deps: {
    assertChipnet: () => void;
    makePoolCtx: MakePoolCtx;
    getActivePaths: GetActivePaths;
  }
) {
  const pool = getOrCreateSubcommand(program, 'pool', 'Pool (optional vault/policy layer)');

  // pool shards
  pool
    .command('shards')
    .description('List pool shards from the active profile state.')
    .option('--json', 'print raw JSON', false)
    .action(async (opts) => {
      const { stateFile } = deps.getActivePaths();

      const store = new FileBackedPoolStateStore({ filename: stateFile });
      const st0 = await loadStateOrEmpty({ store, networkDefault: String(NETWORK) });
      const poolState = ensurePoolStateDefaults(st0, String(NETWORK));

      // Preserve prior UX: show "no shards" if not initialized
      const shards: any[] = Array.isArray((poolState as any).shards) ? (poolState as any).shards : [];
      if (!shards.length) {
        console.log('no shards');
        return;
      }

      // Compute total (BigInt-safe)
      let totalSats = 0n;
      for (const s of shards) {
        const vRaw = s?.valueSats ?? s?.value ?? '0';
        try {
          totalSats += BigInt(String(vRaw));
        } catch {
          // ignore malformed entries
        }
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              meta: {
                stateFile,
                poolIdHex: String((poolState as any).poolIdHex ?? ''),
                categoryHex: String((poolState as any).categoryHex ?? ''),
                shardCount: Number((poolState as any).shardCount ?? shards.length),
                totalSats: totalSats.toString(),
              },
              shards,
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`state: ${stateFile}`);
      console.log(`poolId: ${shortHex((poolState as any).poolIdHex, 40)}`);
      console.log(`category: ${shortHex((poolState as any).categoryHex, 40)}`);
      console.log(`shardCount: ${String((poolState as any).shardCount ?? shards.length)}`);
      console.log(`total: ${totalSats.toString()} sats`);
      console.log('');

      for (const s of shards) {
        const idx = Number(s?.index ?? -1);
        const txid = String(s?.txid ?? '');
        const vout = Number(s?.vout ?? -1);
        const valueSats = String(s?.valueSats ?? s?.value ?? '');
        const comm = String(s?.commitmentHex ?? '');

        console.log(
          `[${Number.isFinite(idx) ? idx : '?'}] ` +
            `value=${valueSats || '?'} ` +
            `outpoint=${txid && Number.isFinite(vout) ? `${txid}:${vout}` : '?'} ` +
            `commit=${comm ? shortHex(comm, 12) : ''}`
        );
      }
    });

  // pool init
  pool
    .command('init')
    .option('--shards <n>', 'number of shards', '8')
    .option('--fresh', 'force a new init (creates new shards)', false)
    .action(async (opts) => {
      deps.assertChipnet();

      const shards = Number(opts.shards);
      if (!Number.isFinite(shards) || shards < 2) throw new Error('shards must be >= 2');

      const ctx = await deps.makePoolCtx();
      const res = await runInit(ctx, { shards, fresh: !!opts.fresh });

      const { stateFile } = deps.getActivePaths();

      console.log(`init txid: ${res.txid ?? res.state?.txid ?? '<unknown>'}`);
      console.log(`shards: ${shards}`);
      console.log(`fresh: ${!!opts.fresh}`);
      console.log(`state saved: ${stateFile} (${POOL_STATE_STORE_KEY})`);
    });

  // pool import
  pool
    .command('import')
    .description('Import a deposit UTXO into the pool.')
    .argument('[outpoint]', 'deposit outpoint as txid:vout (optional if using --txid or --latest)')
    .option('--txid <txid>', 'deposit txid (optional; pairs with --vout or defaults vout=0)', '')
    .option('--vout <n>', 'deposit vout (default 0 if used with --txid)', '0')
    .option('--latest', 'use the most recently-saved stealthUtxo from state file', false)
    .option('--shard <i>', 'shard index (default: derived)', '')
    .option('--fresh', 'force a new import even if already marked imported', false)
    .option(
      '--allow-base',
      'ALLOW importing a non-RPA base P2PKH deposit (requires BCH_STEALTH_ALLOW_BASE_IMPORT=1).',
      false
    )
    .option('--deposit-wif <wif>', 'WIF for base P2PKH deposit key (optional).', '')
    .option('--deposit-privhex <hex>', 'Hex private key for base P2PKH deposit key (optional).', '')
    .action(async (outpointArg, opts) => {
      deps.assertChipnet();

      const { stateFile } = deps.getActivePaths();

      let depositTxid = '';
      let depositVout = 0;

      if (outpointArg) {
        const p = parseOutpointOrThrow(String(outpointArg));
        depositTxid = p.txid;
        depositVout = p.vout;
      } else if (opts.txid && String(opts.txid).trim()) {
        // Strict parsing for user-provided input (do not "continue" here)
        const txid = String(opts.txid).trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txid)) {
          throw new Error(`invalid --txid (expected 64-hex): ${String(opts.txid)}`);
        }

        const vout = Number(String(opts.vout ?? '0').trim());
        if (!Number.isFinite(vout) || vout < 0) {
          throw new Error(`invalid --vout: ${String(opts.vout)}`);
        }

        depositTxid = txid;
        depositVout = vout;
      } else if (opts.latest) {
        // ✅ single source of truth: load via store helpers
        const store = new FileBackedPoolStateStore({ filename: stateFile });
        const st0 = await loadStateOrEmpty({ store, networkDefault: String(NETWORK) });
        const st = ensurePoolStateDefaults(st0, String(NETWORK));

        // 1) Prefer: latest unimported deposit (canonical intent)
        const latestDep = getLatestUnimportedDeposit(st, null);
        if (latestDep && /^[0-9a-fA-F]{64}$/.test(String(latestDep.txid ?? ''))) {
          depositTxid = String(latestDep.txid).toLowerCase();
          depositVout = Number(latestDep.vout ?? 0);
          if (!Number.isFinite(depositVout) || depositVout < 0) {
            throw new Error(`pool import --latest: malformed vout in latest deposit record`);
          }
          console.log(`ℹ using latest unimported deposit: ${depositTxid}:${depositVout}`);
        } else {
        // 2) Fallback: latest stealthUtxo that is NOT change AND is unspent
        const utxos = Array.isArray(st.stealthUtxos) ? st.stealthUtxos : [];

        const isChange = (r: any): boolean => {
          const p = String(r?.purpose ?? '').toLowerCase();
          return p.includes('change'); // covers pool_withdraw_change, send_change, etc.
        };

        // iterate newest -> oldest so "latest" means most recent eligible
        let chosen: { txid: string; vout: number } | null = null;

        for (let i = utxos.length - 1; i >= 0; i--) {
          const r = utxos[i];

          if (!r || isChange(r)) continue;

          const txid = String(r?.txid ?? '').trim();
          const vout = Number(r?.vout ?? 0);

          // NOTE: lockingBytecodeHex is currently present in your stored records but not in the type,
          // so we access it via `any` to avoid TS errors.
          const lockingBytecodeHex = String((r as any)?.lockingBytecodeHex ?? '').trim();

          if (!/^[0-9a-fA-F]{64}$/.test(txid)) continue;
          if (!Number.isFinite(vout) || vout < 0) continue;
          if (!lockingBytecodeHex) continue;

          const unspent = await isOutpointUnspentByLockingScript({
            network: String(st.network ?? NETWORK ?? 'chipnet'),
            txid,
            vout,
            lockingBytecodeHex,
          });

          if (!unspent) {
            // ✅ mark as spent-ish so it stops being confusing; we don't know the spending txid here
            markStealthSpent(st, txid.toLowerCase(), vout, 'unknown');
            continue;
          }

          chosen = { txid: txid.toLowerCase(), vout };
          break;
        }

        if (!chosen) {
          // Persist any "spent" markings we made while filtering
          await saveState({ store, state: st, networkDefault: String(st.network ?? NETWORK ?? 'chipnet') });

          throw new Error(
            `pool import --latest: no deposit candidates found.\n` +
              `Tip: --latest prefers state.deposits; fallback excludes *change* stealthUtxos and requires unspent.\n` +
              `stateFile=${stateFile}`
          );
        }

        // Persist any "spent" markings we made while filtering (and keep state tidy)
        await saveState({ store, state: st, networkDefault: String(st.network ?? NETWORK ?? 'chipnet') });

        depositTxid = chosen.txid;
        depositVout = chosen.vout;
        console.log(`ℹ using latest deposit-candidate stealthUtxo: ${depositTxid}:${depositVout}`);
        }
      } else {
        throw new Error('pool import: provide <outpoint> or --txid (optionally --vout) or --latest');
      }

      const shardIndexOpt: number | null = opts.shard === '' ? null : Number(opts.shard);
      if (opts.shard !== '' && !Number.isFinite(shardIndexOpt)) {
        throw new Error(`invalid --shard: ${String(opts.shard)}`);
      }

      const ctx = await deps.makePoolCtx();

      const res = await runImport(ctx, {
        shardIndex: shardIndexOpt,
        fresh: !!opts.fresh,
        allowBase: !!opts.allowBase,
        depositWif: typeof opts.depositWif === 'string' && opts.depositWif.trim() ? String(opts.depositWif).trim() : null,
        depositPrivHex:
          typeof opts.depositPrivhex === 'string' && opts.depositPrivhex.trim()
            ? String(opts.depositPrivhex).trim()
            : null,
        depositTxid,
        depositVout,
      });

      if (!res) {
        console.log('ℹ no import performed (no matching deposit found / already imported).');
        return;
      }

      console.log(`import txid: ${res.txid}`);
      console.log(`shard: ${res.shardIndex}`);
      console.log(`state saved: ${stateFile} (${POOL_STATE_STORE_KEY})`);
    });

  // pool withdraw
  pool
    .command('withdraw')
    .description('Withdraw from pool to a destination (paycode or cashaddr).')
    .argument('<dest>', 'destination: paycode (PM...) or cashaddr')
    .argument('<sats>', 'amount in sats')
    .option('--shard <i>', 'shard index (default: auto)')
    .option('--require-shard', 'fail if --shard not provided (no auto selection)', false)
    .option('--fresh', 'force a new withdrawal even if already recorded', false)
    .action(async (dest, sats, opts) => {
      deps.assertChipnet();

      const amountSats = Number(sats);
      if (!Number.isFinite(amountSats) || amountSats < Number(DUST)) {
        throw new Error(`amount must be >= dust (${DUST})`);
      }

      const shardIndex = opts.shard == null ? undefined : Number(opts.shard);
      if (shardIndex != null && (!Number.isFinite(shardIndex) || shardIndex < 0)) {
        throw new Error(`invalid --shard: ${String(opts.shard)}`);
      }

      const ctx = await deps.makePoolCtx();
      const res = await runWithdraw(ctx, {
        dest: String(dest),
        shardIndex,
        amountSats,
        fresh: !!opts.fresh,
        requireShard: !!opts.requireShard,
      });

      const { stateFile } = deps.getActivePaths();

      console.log(`withdraw txid: ${res.txid}`);
      console.log(`state saved: ${stateFile} (${POOL_STATE_STORE_KEY})`);
    });

  // This registers: `pool withdraw-check <dest> <amountSats> [--shard] [--broadcast] [--category-mode]`
  registerPoolWithdrawCheck(pool, deps.makePoolCtx);

  return pool;
}