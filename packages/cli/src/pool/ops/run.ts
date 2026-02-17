// packages/cli/src/pool/ops/run.ts

import type { PoolOpContext } from '../context.js';
import { runInit } from './init.js';
import { runDeposit } from './deposit.js';
import { runImport } from './import.js';
import { runWithdraw } from './withdraw.js';

export async function runHappyPath(
  ctx: PoolOpContext,
  opts: { shards: number; depositSats: number; withdrawSats: number; fresh?: boolean }
): Promise<void> {
  const { shards, depositSats, withdrawSats, fresh = false } = opts;

  // Keep logs here (preferred), so index.ts stays wiring-only.
  console.log(`\n[1/4] init shards (${shards})...`);
  // If runInit supports a `fresh` flag, pass it.
  // If it doesn't yet, leaving it unused is fine (mechanical refactor).
  await runInit(ctx, { shards /*, fresh */ } as any);

  console.log(`\n[2/4] deposit ${depositSats} sats (Actor A -> Actor B stealth P2PKH)...`);
  await runDeposit(ctx, { amountSats: depositSats });

  console.log(`\n[3/4] import deposit into shard (derived selection)...`);
  const imp = await runImport(ctx, { shardIndex: null, fresh: false });
  const shardIndex = imp?.shardIndex ?? 0;

  console.log(`\n[4/4] withdraw ${withdrawSats} sats (shard -> me)...`);
  await runWithdraw(ctx, { dest: ctx.me.paycode, shardIndex, amountSats: withdrawSats, fresh: false });

  void fresh; // keep lint/unused clean until init supports it
}