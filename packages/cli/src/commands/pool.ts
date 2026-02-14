// packages/cli/src/commands/pool.ts
import type { Command } from 'commander';
import fs from 'node:fs';

import { POOL_STATE_STORE_KEY } from '@bch-stealth/pool-state';
import { DUST } from '../config.js';

import { runInit } from '../pool/ops/init.js';
import { runImport } from '../pool/ops/import.js';
import { runWithdraw } from '../pool/ops/withdraw.js';

// ✅ already present in your file
import { registerPoolWithdrawCheck } from './pool-withdraw-check.js';

export type MakePoolCtx = () => Promise<any>;
export type GetActivePaths = () => { stateFile: string };

function getOrCreateSubcommand(program: Command, name: string, description: string): Command {
  const existing = (program.commands ?? []).find((c) => c.name() === name);
  if (existing) return existing;
  return program.command(name).description(description);
}

function readJsonOrNull(p: string): any | null {
  try {
    if (!p) return null;
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// NOTE: your state file is currently wrapped like:
// { schemaVersion, updatedAt, data: { pool: { state: {...} } } }
function extractPoolStateFromStateFileJson(stFileJson: any): any | null {
  if (!stFileJson || typeof stFileJson !== 'object') return null;

  // Preferred: current wrapper shape
  const wrapped = stFileJson?.data?.pool?.state;
  if (wrapped && typeof wrapped === 'object') return wrapped;

  // Alternate: if a store writes by key at top-level
  const byKey = stFileJson?.[POOL_STATE_STORE_KEY];
  if (byKey && typeof byKey === 'object') return byKey;

  // Legacy-ish: stFileJson.pool?.state
  const legacy = stFileJson?.pool?.state;
  if (legacy && typeof legacy === 'object') return legacy;

  return null;
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
      const stFile = readJsonOrNull(stateFile);

      const poolState = extractPoolStateFromStateFileJson(stFile);
      if (!poolState) {
        throw new Error(`pool shards: no pool state found in ${stateFile} (did you run "bchctl pool init"?)`);
      }

      const shards: any[] = Array.isArray(poolState.shards) ? poolState.shards : [];
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
                poolIdHex: String(poolState.poolIdHex ?? ''),
                categoryHex: String(poolState.categoryHex ?? ''),
                shardCount: Number(poolState.shardCount ?? shards.length),
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

      // pretty output
      console.log(`state: ${stateFile}`);
      console.log(`poolId: ${shortHex(poolState.poolIdHex, 40)}`);
      console.log(`category: ${shortHex(poolState.categoryHex, 40)}`);
      console.log(`shardCount: ${String(poolState.shardCount ?? shards.length)}`);
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
        const txid = String(opts.txid).trim();
        if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error(`invalid --txid (expected 64-hex): ${txid}`);
        const vout = Number(String(opts.vout ?? '0').trim());
        if (!Number.isFinite(vout) || vout < 0) throw new Error(`invalid --vout: ${String(opts.vout)}`);
        depositTxid = txid.toLowerCase();
        depositVout = vout;
      } else if (opts.latest) {
        const stFile = readJsonOrNull(stateFile);
        const poolState = extractPoolStateFromStateFileJson(stFile);
        if (!poolState) throw new Error(`pool import --latest: no pool state found in ${stateFile}`);

        const utxos = Array.isArray(poolState.stealthUtxos) ? poolState.stealthUtxos : [];
        if (utxos.length === 0) {
          throw new Error(`pool import --latest: no stealthUtxos found in state file: ${stateFile}`);
        }
        const last = utxos[utxos.length - 1];
        const txid = String(last.txid ?? last.txidHex ?? '').trim();
        const vout = Number(last.vout ?? last.n ?? 0);
        if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
          throw new Error(`pool import --latest: malformed txid in last stealthUtxo record`);
        }
        if (!Number.isFinite(vout) || vout < 0) {
          throw new Error(`pool import --latest: malformed vout in last stealthUtxo record`);
        }
        depositTxid = txid.toLowerCase();
        depositVout = vout;
        console.log(`ℹ using latest stealthUtxo: ${depositTxid}:${depositVout}`);
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