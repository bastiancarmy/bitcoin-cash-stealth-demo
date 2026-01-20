// packages/cli/scripts/smoke_pool_run.ts
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function run(cmd: string[], input = '\n\n') {
  const res = spawnSync(cmd[0]!, cmd.slice(1), {
    stdio: ['pipe', 'inherit', 'inherit'],
    input,
    encoding: 'utf8',
  });

  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd.join(' ')}`);
  }
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`Smoke assertion failed: ${msg}`);
}

function readState(stateFile: string) {
  const raw = readFileSync(stateFile, 'utf8');
  return JSON.parse(raw);
}

const stateFile = path.join(os.tmpdir(), `bch-stealth.smoke.${Date.now()}.pool.json`);
const shards = 8;
const deposit = 120000;
const withdraw = 50000;

// Always feed two newlines so interactive wallet prompts "generate new" for Alice and Bob.
const stdin = '\n\n';

console.log(`[smoke] using state file: ${stateFile}`);

run(['yarn', 'workspace', '@bch-stealth/cli', 'build']);

// init
run(
  ['node', 'packages/cli/dist/index.js', '--state-file', stateFile, 'pool', 'init', '--shards', String(shards)],
  stdin
);

let st = readState(stateFile);
assert(st.network, 'state.network exists');
assert(Array.isArray(st.shards), 'state.shards is array');
assert(st.shards.length === shards, `state.shards.length === ${shards}`);
assert(typeof st.categoryHex === 'string' && st.categoryHex.length > 0, 'state.categoryHex set');
assert(typeof st.redeemScriptHex === 'string' && st.redeemScriptHex.length > 0, 'state.redeemScriptHex set');


// deposit
run(
  ['node', 'packages/cli/dist/index.js', '--state-file', stateFile, 'pool', 'deposit', '--amount', String(deposit)],
  stdin
);

st = readState(stateFile);
assert(st.lastDeposit && st.lastDeposit.txid, 'state.lastDeposit.txid exists');
assert(Array.isArray(st.deposits) && st.deposits.length >= 1, 'state.deposits has >= 1');


// import
run(['node', 'packages/cli/dist/index.js', '--state-file', stateFile, 'pool', 'import'], stdin);

st = readState(stateFile);
assert(st.lastImport && st.lastImport.txid, 'state.lastImport.txid exists');


// withdraw
run(
  ['node', 'packages/cli/dist/index.js', '--state-file', stateFile, 'pool', 'withdraw', '--amount', String(withdraw)],
  stdin
);

st = readState(stateFile);
assert(st.lastWithdraw && st.lastWithdraw.txid, 'state.lastWithdraw.txid exists');
assert(Array.isArray(st.withdrawals) && st.withdrawals.length >= 1, 'state.withdrawals has >= 1');

console.log('[smoke] ✅ passed');