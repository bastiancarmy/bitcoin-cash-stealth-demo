// packages/cli/src/pool/ops/init.ts
import type { PoolState, ShardPointer } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex, hash160, hexToBytes } from '@bch-stealth/utils';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../state.js';

// This is used by init to fetch the redeem script bytecode.
async function getPoolHashFoldBytecode(poolVersion: any): Promise<Uint8Array> {
  // Keep this defensive: pool-hash-fold has varied export shapes during refactors.
  const m: any = await import('@bch-stealth/pool-hash-fold');
  if (typeof m.getPoolHashFoldBytecode === 'function') return await m.getPoolHashFoldBytecode(poolVersion);
  if (typeof m.getPoolHashFoldScript === 'function') return await m.getPoolHashFoldScript(poolVersion);
  if (typeof m.getRedeemScript === 'function') return await m.getRedeemScript(poolVersion);
  if (typeof m.loadPoolHashFoldBytecode === 'function') return await m.loadPoolHashFoldBytecode(poolVersion);

  const keys = Object.keys(m).sort().join(', ');
  throw new Error(
    `[init] Unable to load pool-hash-fold bytecode. Expected one of: ` +
      `getPoolHashFoldBytecode | getPoolHashFoldScript | getRedeemScript | loadPoolHashFoldBytecode. ` +
      `Available: ${keys}`
  );
}

export async function runInit(
  ctx: PoolOpContext,
  opts: { shards: number; fresh?: boolean }
): Promise<{ state: PoolState; txid?: string }> {
  const { shards, fresh = false } = opts;

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);

  if (!fresh && Array.isArray(st.shards) && st.shards.length > 0) {
    // already initialized
    return { state: st };
  }

  const shardCount = Number(shards);
  if (!Number.isFinite(shardCount) || shardCount <= 0) throw new Error(`[init] invalid shards: ${String(shards)}`);

  const DUST = BigInt(ctx.config.DUST);
  const SHARD_VALUE = BigInt(ctx.config.SHARD_VALUE);

  const shardsTotal = SHARD_VALUE * BigInt(shardCount);

  const funding = await selectFundingUtxo({
    state: st,
    wallet: ctx.actors.actorBBaseWallet,
    ownerTag: 'B',
    minSats: shardsTotal + DUST + 20_000n,
    chainIO: ctx.chainIO,
    getUtxos: ctx.getUtxos,
    network: ctx.network,
    dustSats: DUST,
  });

  const poolIdHex =
    (st as any)?.poolIdHex ??
    bytesToHex(hash160(hexToBytes(funding.txid))); // deterministic fallback

  const cfg: PoolShards.PoolConfig = {
    network: ctx.network,
    poolIdHex,
    poolVersion: String(ctx.poolVersion === 'v1' ? 'v1' : 'v1_1'),
    shardValueSats: SHARD_VALUE.toString(),
    defaultFeeSats: BigInt(ctx.config.DEFAULT_FEE).toString(),
    redeemScriptHex: bytesToHex(await getPoolHashFoldBytecode(ctx.poolVersion)),
  };

  const fundingPrevout: PoolShards.PrevoutLike = {
    txid: funding.txid,
    vout: funding.vout,
    valueSats: BigInt(funding.prevOut.value),
    scriptPubKey: funding.prevOut.scriptPubKey,
  };

  const owner: PoolShards.WalletLike = {
    signPrivBytes: funding.signPrivBytes,
    pubkeyHash160Hex: bytesToHex(ctx.actors.actorBBaseWallet.hash160),
  };

  const built = PoolShards.initShardsTx({
    cfg,
    shardCount,
    funding: fundingPrevout,
    ownerWallet: owner,
  });

  const rawHex = bytesToHex(built.rawTx);
  const txid = await ctx.chainIO.broadcastRawTx(rawHex);

  // pool-shards init uses output[0]=change, outputs[1..]=shards
  const shardsPtrs: ShardPointer[] = built.nextPoolState.shards.map((s: any, i: number) => ({
    index: i,
    txid,
    vout: i + 1,
    valueSats: String(s.valueSats),
    commitmentHex: s.commitmentHex,
  }));

  const next: PoolState = ensurePoolStateDefaults({
    schemaVersion: 1,

    network: built.nextPoolState.network,
    poolIdHex: built.nextPoolState.poolIdHex,
    poolVersion: built.nextPoolState.poolVersion,
    categoryHex: built.nextPoolState.categoryHex,
    redeemScriptHex: built.nextPoolState.redeemScriptHex,

    shardCount: built.nextPoolState.shardCount,
    shards: shardsPtrs,

    stealthUtxos: [],
    deposits: [],
    withdrawals: [],

    createdAt: new Date().toISOString(),
    txid,
  } as any);

  await saveState({ store: ctx.store, state: next, networkDefault: ctx.network });
  return { state: next, txid };
}