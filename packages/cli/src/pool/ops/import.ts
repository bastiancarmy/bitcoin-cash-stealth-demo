// packages/cli/src/pool/ops/import.ts
import type { DepositRecord, PoolState } from '@bch-stealth/pool-state';
import { ensurePoolStateDefaults, getLatestUnimportedDeposit, upsertDeposit } from '@bch-stealth/pool-state';

import * as PoolShards from '@bch-stealth/pool-shards';
import { bytesToHex, hexToBytes, concat, sha256, hash160, uint32le } from '@bch-stealth/utils';
import { deriveRpaOneTimePrivReceiver } from '@bch-stealth/rpa';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import type { PoolOpContext } from '../context.js';
import { loadStateOrEmpty, saveState } from '../state.js';
import { toPoolShardsState, patchShardFromNextPoolState } from '../adapters.js';

function parseP2pkhHash160(scriptPubKey: Uint8Array | string): Uint8Array | null {
  const spk = scriptPubKey instanceof Uint8Array ? scriptPubKey : hexToBytes(scriptPubKey);
  if (spk.length === 25 && spk[0] === 0x76 && spk[1] === 0xa9 && spk[2] === 0x14 && spk[23] === 0x88 && spk[24] === 0xac) {
    return spk.slice(3, 23);
  }
  return null;
}

function pubkeyHashFromPriv(privBytes: Uint8Array): { pub: Uint8Array; h160: Uint8Array } {
  const pub = secp256k1.getPublicKey(privBytes, true);
  const h160 = hash160(pub);
  return { pub, h160 };
}

function outpointHash32(txidHex: string, vout: number): Uint8Array {
  const txid = hexToBytes(txidHex);
  const n = uint32le(vout >>> 0);
  return sha256(concat(txid, n));
}

async function importDepositToShard(args: {
  ctx: PoolOpContext;
  poolState: PoolState;
  shardIndex: number;
  depositOutpoint: DepositRecord;
}): Promise<{ txid: string }> {
  const { ctx, poolState, shardIndex, depositOutpoint } = args;
  const st = ensurePoolStateDefaults(poolState);

  const shard = st.shards[shardIndex];
  if (!shard) throw new Error(`invalid shardIndex ${shardIndex}`);

  const shardPrev = await ctx.chainIO.getPrevOutput(shard.txid, shard.vout);
  const depositPrev = await ctx.chainIO.getPrevOutput(depositOutpoint.txid, depositOutpoint.vout);

  const expectedH160 = parseP2pkhHash160(depositPrev.scriptPubKey);
  if (!expectedH160) throw new Error('deposit prevout is not P2PKH');

  const ctx2 = depositOutpoint.rpaContext;
  if (!ctx2?.senderPub33Hex || !ctx2?.prevoutHashHex) throw new Error('depositOutpoint missing rpaContext');

  const senderPub33 = hexToBytes(ctx2.senderPub33Hex);

  const receiverWallet = ctx.actors.actorBBaseWallet;

  const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
    receiverWallet.scanPrivBytes ?? receiverWallet.privBytes,
    receiverWallet.spendPrivBytes ?? receiverWallet.privBytes,
    senderPub33,
    ctx2.prevoutHashHex,
    ctx2.prevoutN,
    ctx2.index
  );

  const { h160 } = pubkeyHashFromPriv(oneTimePriv);
  if (bytesToHex(h160) !== bytesToHex(expectedH160)) {
    throw new Error(`deposit spend derivation mismatch. expected=${bytesToHex(expectedH160)} derived=${bytesToHex(h160)}`);
  }

  if (!st.categoryHex || !st.redeemScriptHex) {
    throw new Error('State missing categoryHex/redeemScriptHex. Run init first or repair state.');
  }

  const pool = toPoolShardsState(st, ctx.network);

  const shardPrevout: PoolShards.PrevoutLike = {
    txid: shard.txid,
    vout: shard.vout,
    valueSats: BigInt(shardPrev.value),
    scriptPubKey: shardPrev.scriptPubKey,
  };

  const depositPrevout: PoolShards.PrevoutLike = {
    txid: depositOutpoint.txid,
    vout: depositOutpoint.vout,
    valueSats: BigInt(depositPrev.value),
    scriptPubKey: depositPrev.scriptPubKey,
  };

  const covenantWallet: PoolShards.WalletLike = {
    signPrivBytes: receiverWallet.privBytes,
    pubkeyHash160Hex: bytesToHex(receiverWallet.hash160),
  };

  const depositWallet: PoolShards.WalletLike = {
    signPrivBytes: oneTimePriv,
    pubkeyHash160Hex: bytesToHex(h160),
  };

  const built = PoolShards.importDepositToShard({
    pool,
    shardIndex,
    shardPrevout,
    depositPrevout,
    covenantWallet,
    depositWallet,
    feeSats: BigInt(ctx.config.DEFAULT_FEE),
  } as any);

  const rawHex = bytesToHex(built.rawTx);
  const txid = await ctx.chainIO.broadcastRawTx(rawHex);

  patchShardFromNextPoolState({
    poolState: st,
    shardIndex,
    txid,
    nextPool: built.nextPoolState,
  });

  return { txid };
}

export async function runImport(
  ctx: PoolOpContext,
  opts: { shardIndex?: number | null; fresh?: boolean }
): Promise<{ txid: string; shardIndex: number } | null> {
  const { shardIndex: shardIndexOpt = null, fresh = false } = opts;

  const st0 = await loadStateOrEmpty({ store: ctx.store, networkDefault: ctx.network });
  const st = ensurePoolStateDefaults(st0);
  st.deposits ??= [];
  st.withdrawals ??= [];
  st.stealthUtxos ??= [];

  const dep =
    ((st as any).lastDeposit && !(st as any).lastDeposit.importTxid ? (st as any).lastDeposit : null) ??
    getLatestUnimportedDeposit(st, null);

  if (!dep) return null;

  if (!fresh && dep.importTxid) {
    return { txid: dep.importTxid, shardIndex: dep.importedIntoShard! };
  }

  let stillUnspent = await ctx.chainIO.isP2pkhOutpointUnspent({
    txid: dep.txid,
    vout: dep.vout,
    hash160Hex: dep.receiverRpaHash160Hex,
  });

  if (!stillUnspent) {
    stillUnspent = await ctx.chainIO.waitForP2pkhOutpointUnspent(
      { txid: dep.txid, vout: dep.vout, hash160Hex: dep.receiverRpaHash160Hex },
      { attempts: 12, delayMs: 750 }
    );
  }

  const shardCount = st.shards.length;
  const noteHash = outpointHash32(dep.txid, dep.vout);
  const derivedIndex = noteHash[0] % shardCount;
  const shardIndex =
    shardIndexOpt == null ? derivedIndex : Math.max(0, Math.min(shardCount - 1, Number(shardIndexOpt)));

  const res = await importDepositToShard({
    ctx,
    poolState: st,
    shardIndex,
    depositOutpoint: dep,
  });

  upsertDeposit(st, {
    ...dep,
    importedIntoShard: shardIndex,
    importTxid: res.txid,
  } as any);

  await saveState({ store: ctx.store, state: st, networkDefault: ctx.network });
  return { txid: res.txid, shardIndex };
}