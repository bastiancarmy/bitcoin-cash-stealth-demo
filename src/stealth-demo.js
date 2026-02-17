#!/usr/bin/env node
// src/stealth-demo.js
//
// Canonical repo demo story runner (B457).
//
// Usage:
//   node src/stealth-demo.js run --shards 8 --deposit 120000 --withdraw 50000
//
// This runner is responsible for narration + multi-actor orchestration.
// It invokes the compiled bch-stealth CLI with per-actor state files.
//
// Design choices (Phase 2.5 scaffolding):
// - Uses separate per-actor state stores (no omniscient shared store).
// - Uses "base" deposit mode (CashFusion-style input assumption).
//   This avoids needing RPA discovery until we add a discover/scan step.
// - Bob imports via explicit deposit outpoint overrides.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';

const program = new Command();

const REPO_ROOT = process.cwd();
const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
const DEFAULT_WALLETS = path.join(REPO_ROOT, 'wallets.json');

function mustExist(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${p}`);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function actorStateFile(actorId) {
  return path.join(REPO_ROOT, 'state', '.bch-stealth', actorId, 'state.json');
}

function runBchStealth(args, opts = {}) {
  mustExist(CLI_ENTRY);

  const env = {
    ...process.env,
    ...(opts.env || {}),
  };

  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = `${r.stdout || ''}${r.stderr || ''}`.trimEnd();
  if (opts.print !== false) process.stdout.write(out + (out.endsWith('\n') ? '' : '\n'));

  if (r.status !== 0) {
    throw new Error(`bch-stealth failed (exit=${r.status}) while running:\n  ${args.join(' ')}\n\n${out}`);
  }

  return out;
}

function parseTxid(label, text) {
  const re = new RegExp(`\\s*${label}\\s*txid:\\s*([0-9a-f]{64})`, 'i');
  const m = text.match(re);
  if (!m) throw new Error(`Unable to parse ${label} txid from output.`);
  return m[1].toLowerCase();
}

program
  .name('stealth-demo')
  .description('Repo-root story runner for bch-stealth (per-actor stores)')
  .command('run')
  .option('--shards <n>', 'number of shards', '8')
  .option('--deposit <sats>', 'deposit amount in sats', '120000')
  .option('--withdraw <sats>', 'withdraw amount in sats', '50000')
  .option('--wallets <path>', 'wallets.json path', DEFAULT_WALLETS)
  .option('--fresh', 'force a fresh init on Bob', false)
  .action(async (opts) => {
    const shards = Number(opts.shards);
    const depositSats = Number(opts.deposit);
    const withdrawSats = Number(opts.withdraw);

    if (!Number.isFinite(shards) || shards < 2) throw new Error('--shards must be >= 2');
    if (!Number.isFinite(depositSats) || depositSats <= 0) throw new Error('--deposit must be a number');
    if (!Number.isFinite(withdrawSats) || withdrawSats <= 0) throw new Error('--withdraw must be a number');

    const walletsPath = path.resolve(String(opts.wallets || DEFAULT_WALLETS));
    mustExist(walletsPath);

    const aliceState = actorStateFile('actor_a');
    const bobState = actorStateFile('actor_b');
    ensureDir(path.dirname(aliceState));
    ensureDir(path.dirname(bobState));

    console.log(`\n[demo] repoRoot: ${REPO_ROOT}`);
    console.log(`[demo] wallets: ${walletsPath}`);
    console.log(`[demo] alice state: ${aliceState}`);
    console.log(`[demo] bob   state: ${bobState}\n`);

    // 1) init shards (Bob)
    console.log(`[1/4] init shards (Bob) ...`);
    const initOut = runBchStealth([
      'pool',
      'init',
      '--shards',
      String(shards),
      ...(opts.fresh ? ['--fresh'] : []),
      '--wallets',
      walletsPath,
      '--state-file',
      bobState,
    ]);
    void initOut;

    // 2) deposit (Alice -> Bob base P2PKH)  [CashFusion-friendly]
    console.log(`\n[2/4] deposit ${depositSats} sats (Alice -> Bob BASE P2PKH) ...`);
    const depOut = runBchStealth([
      'pool',
      'deposit',
      '--amount',
      String(depositSats),
      '--deposit-mode',
      'base',
      '--wallets',
      walletsPath,
      '--state-file',
      aliceState,
    ]);
    const depositTxid = parseTxid('deposit', depOut);

    // 3) import (Bob) using explicit outpoint override
    console.log(`\n[3/4] import deposit into shard (Bob, by outpoint) ...`);
    const impOut = runBchStealth(
      [
        'pool',
        'import',
        '--wallets',
        walletsPath,
        '--state-file',
        bobState,
        '--deposit-txid',
        depositTxid,
        '--deposit-vout',
        '0',
        '--allow-base',
      ],
      {
        env: {
          // hard guard to prevent accidental non-stealth imports
          BCH_STEALTH_ALLOW_BASE_IMPORT: '1',
        },
      }
    );
    void impOut;

    // 4) withdraw (Bob -> Alice stealth payment, current behavior)
    console.log(`\n[4/4] withdraw ${withdrawSats} sats (Bob shard -> Alice stealth P2PKH) ...`);
    const wOut = runBchStealth([
      'pool',
      'withdraw',
      '--amount',
      String(withdrawSats),
      '--wallets',
      walletsPath,
      '--state-file',
      bobState,
    ]);
    void wOut;

    console.log(`\n✅ demo complete`);
    console.log(`   alice state: ${aliceState}`);
    console.log(`   bob state:   ${bobState}`);
  });

(async () => {
  await program.parseAsync(process.argv);
})().catch((err) => {
  console.error('❌', err?.stack || err?.message || err);
  process.exitCode = 1;
});