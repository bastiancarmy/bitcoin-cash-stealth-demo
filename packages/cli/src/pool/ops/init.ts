// packages/cli/src/pool/ops/init.ts
import type { PoolState, ShardPointer } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex, hash160, hexToBytes } from '@bch-stealth/utils';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState, selectFundingUtxo } from '../state.js';

function cleanHexMaybe(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const s = x.trim();
  if (!s) return null;
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (h.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  return h.toLowerCase();
}

function cleanHexLenMaybe(x: unknown, bytesLen: number): string | null {
  const h = cleanHexMaybe(x);
  if (!h) return null;
  return h.length === bytesLen * 2 ? h : null;
}

// 20 bytes => 40 hex chars
function cleanHex20Maybe(x: unknown): string | null {
  const h = cleanHexMaybe(x);
  if (!h) return null;
  return h.length === 40 ? h : null;
}

// This is used by init to fetch the redeem script bytecode.
async function getPoolHashFoldBytecode(poolVersion: any): Promise<Uint8Array> {
  const m: any = await import('@bch-stealth/pool-hash-fold');

  const toBytes = (x: any): Uint8Array | null => {
    if (x instanceof Uint8Array) return x;
    if (typeof x === 'string') {
      const h = x.startsWith('0x') ? x.slice(2) : x;
      if (/^[0-9a-f]+$/i.test(h) && h.length % 2 === 0) return hexToBytes(h);
    }
    return null;
  };

  const tryCall = async (fnName: string): Promise<Uint8Array | null> => {
    const fn = m?.[fnName];
    if (typeof fn !== 'function') return null;
    const r = await fn(poolVersion);
    return toBytes(r);
  };

  // Preferred → legacy → common alternates
  return (
    (await tryCall('getPoolHashFoldBytecode')) ??
    (await tryCall('getRedeemScriptBytecode')) ??
    (await tryCall('getPoolHashFoldScript')) ??
    (await tryCall('getRedeemScript')) ??
    (await tryCall('loadPoolHashFoldBytecode')) ??
    (() => {
      throw new Error(
        `[init] Unable to load pool-hash-fold bytecode. Available: ${Object.keys(m ?? {}).sort().join(', ')}`
      );
    })()
  );
}

export async function runInit(
  ctx: PoolOpContext,
  opts: { shards: number; fresh?: boolean }
): Promise<{ state: PoolState; txid?: string }> {
  const { shards, fresh = false } = opts;

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);

  // covenant signer is always "me" in single-user mode
  const defaultSigner = {
    actorId: 'me',
    pubkeyHash160Hex: bytesToHex(ctx.me.wallet.hash160),
  };
  if (fresh) st.covenantSigner = defaultSigner;
  else st.covenantSigner = st.covenantSigner ?? defaultSigner;

  const alreadyInitialized =
    Array.isArray(st.shards) &&
    st.shards.length > 0 &&
    typeof st.categoryHex === 'string' &&
    st.categoryHex.length > 0 &&
    typeof st.redeemScriptHex === 'string' &&
    st.redeemScriptHex.length > 0;

  if (!fresh && alreadyInitialized) {
    await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });
    return { state: st };
  }

  const shardCount = Number(shards);
  if (!Number.isFinite(shardCount) || shardCount <= 0) throw new Error(`[init] invalid shards: ${String(shards)}`);

  const DUST = BigInt(ctx.config.DUST);
  const SHARD_VALUE = BigInt(ctx.config.SHARD_VALUE);
  const shardsTotal = SHARD_VALUE * BigInt(shardCount);

  // single-user: signer is always me
  const signer = { wallet: ctx.me.wallet, ownerTag: 'me' as const };

  const funding = await selectFundingUtxo({
    mode: 'pool-op',
    // default prefer is ['base','stealth']
    state: st,
    wallet: signer.wallet,
    ownerTag: signer.ownerTag,
    minSats: shardsTotal + DUST + 20_000n,
    chainIO: ctx.chainIO,
    getUtxos: ctx.getUtxos,
    network: ctx.network,
    dustSats: DUST,
  });
  
  if (funding.vout !== 0) {
    throw new Error(
      `[init] CashTokens category genesis requires spending a UTXO at vout=0, but selected ${funding.txid}:${funding.vout}.\n` +
      `Fix: send a fresh self-transfer that creates an unspent vout=0 to your base address, then re-run:\n` +
      `  bchctl pool init --shards ${shardCount} --fresh\n`
    );
  }

  // ---- poolIdHex (MUST be 20 bytes / 40 hex) --------------------------------
  const statePoolIdHex = cleanHexLenMaybe((st as any)?.poolIdHex, 20);

  const fundingTxidHex = cleanHexLenMaybe(funding.txid, 32);
  if (!fundingTxidHex) {
    throw new Error(
      `[init] funding txid is not a 32-byte hex string: ${String(funding.txid)}\n` +
      `This usually means your Electrum/getUtxos wiring is returning placeholder data.\n` +
      `Fix electrum connectivity or getUtxos adapter before running init.`
    );
  }

  // Deterministic fallback: poolId = HASH160(fundingTxid)
  const fallbackPoolIdHex = bytesToHex(hash160(hexToBytes(fundingTxidHex)));

  const poolIdHex = statePoolIdHex ?? fallbackPoolIdHex;
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
  console.log(`[init] funding outpoint: ${funding.txid}:${funding.vout}`);

  const owner: PoolShards.WalletLike = {
    signPrivBytes: funding.signPrivBytes,
    pubkeyHash160Hex: bytesToHex(signer.wallet.hash160),
  };

  const built = PoolShards.initShardsTx({
    cfg,
    shardCount,
    funding: fundingPrevout,
    ownerWallet: owner,
  });

  const rawHex = bytesToHex(built.rawTx);
  const txid = await ctx.chainIO.broadcastRawTx(rawHex);

  const shardsPtrs: ShardPointer[] = built.nextPoolState.shards.map((s: any, i: number) => ({
    index: i,
    txid,
    vout: i + 1,
    valueSats: String(s.valueSats),
    commitmentHex: s.commitmentHex,
  }));

  // Preserve existing arrays if we’re re-initializing a partially populated file (unless you want to wipe them).
  const next: PoolState = ensurePoolStateDefaults({
    ...st,
    schemaVersion: 1,
    covenantSigner: st.covenantSigner, // keep explicit signer
    network: built.nextPoolState.network,
    poolIdHex: built.nextPoolState.poolIdHex,
    poolVersion: built.nextPoolState.poolVersion,
    categoryHex: built.nextPoolState.categoryHex,
    redeemScriptHex: built.nextPoolState.redeemScriptHex,
    shardCount: built.nextPoolState.shardCount,
    shards: shardsPtrs,
    createdAt: (st as any).createdAt ?? new Date().toISOString(),
    txid,
  } as any);

  await saveState({ store: ctx.store, state: next, networkDefault: ctx.network });
  return { state: next, txid };
}