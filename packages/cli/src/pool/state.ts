// packages/cli/src/pool/state.ts

import type {
  PoolState,
  StealthUtxoRecord,
  FileBackedPoolStateStore,
} from '@bch-stealth/pool-state';

import {
  ensurePoolStateDefaults,
  markStealthSpent,
  readPoolState,
  writePoolState,
} from '@bch-stealth/pool-state';

import type { WalletLike } from './context.js';

import { bytesToHex, hexToBytes, hash160 } from '@bch-stealth/utils';
import { deriveRpaOneTimePrivReceiver } from '@bch-stealth/rpa';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/**
 * Create an empty PoolState shell.
 * Keep callable with no args for backwards-compat with older CLI call sites.
 */
export function emptyPoolState(networkDefault: string = 'chipnet'): PoolState {
  return ensurePoolStateDefaults({
    schemaVersion: 1,
    network: networkDefault,
    createdAt: new Date().toISOString(),
  } as any);
}

/**
 * Load state via pool-state store helpers; return an empty state if missing.
 * NOTE: uses @bch-stealth/pool-state readPoolState/writePoolState to avoid coupling
 * to FileBackedPoolStateStore method names.
 */
export async function loadStateOrEmpty(args: {
  store: FileBackedPoolStateStore;
  networkDefault: string;
}): Promise<PoolState> {
  const { store, networkDefault } = args;

  const st = await readPoolState({ store, networkDefault });
  if (!st) return emptyPoolState(networkDefault);

  return ensurePoolStateDefaults(st);
}

export async function saveState(args: {
  store: FileBackedPoolStateStore;
  state: PoolState;
  networkDefault: string;
}): Promise<void> {
  const { store, state, networkDefault } = args;

  const st = ensurePoolStateDefaults(state);
  await writePoolState({ store, state: st, networkDefault });
}

// -------------------------------------------------------------------------------------
// Funding selection helper (moved from index.ts)
// -------------------------------------------------------------------------------------

function parseP2pkhHash160(scriptPubKey: Uint8Array | string): Uint8Array | null {
  const spk = scriptPubKey instanceof Uint8Array ? scriptPubKey : hexToBytes(scriptPubKey);

  // OP_DUP OP_HASH160 PUSH20 <20B> OP_EQUALVERIFY OP_CHECKSIG
  if (
    spk.length === 25 &&
    spk[0] === 0x76 &&
    spk[1] === 0xa9 &&
    spk[2] === 0x14 &&
    spk[23] === 0x88 &&
    spk[24] === 0xac
  ) {
    return spk.slice(3, 23);
  }
  return null;
}

function pubkeyHashFromPriv(privBytes: Uint8Array): { pub: Uint8Array; h160: Uint8Array } {
  const pub = secp256k1.getPublicKey(privBytes, true);
  const h160 = hash160(pub);
  return { pub, h160 };
}

function toBigIntSats(x: any): bigint {
  return typeof x === 'bigint' ? x : BigInt(x);
}

export async function selectFundingUtxo(args: {
  state?: PoolState | null;
  wallet: WalletLike;
  ownerTag: string;
  minSats?: bigint;
  chainIO: {
    isP2pkhOutpointUnspent: (o: { txid: string; vout: number; hash160Hex: string }) => Promise<boolean>;
    getPrevOutput: (txid: string, vout: number) => Promise<any>;
  };
  getUtxos: (address: string, network: string, includeUnconfirmed: boolean) => Promise<any[]>;
  network: string;
  dustSats: bigint;
}): Promise<{
  txid: string;
  vout: number;
  prevOut: any;
  signPrivBytes: Uint8Array;
  source: 'stealth' | 'base';
  record?: StealthUtxoRecord;
}> {
  const {
    state,
    wallet,
    ownerTag,
    minSats = args.dustSats,
    chainIO,
    getUtxos,
    network,
  } = args;

  const st = ensurePoolStateDefaults(state);

  const stealthRecs = (st?.stealthUtxos ?? [])
    .filter((r) => r && r.owner === ownerTag && !r.spentInTxid)
    .sort((a, b) =>
      toBigIntSats(b.valueSats ?? b.value ?? 0) > toBigIntSats(a.valueSats ?? a.value ?? 0) ? 1 : -1
    );

  for (const r of stealthRecs) {
    const unspent = await chainIO.isP2pkhOutpointUnspent({
      txid: r.txid,
      vout: r.vout,
      hash160Hex: r.hash160Hex,
    });

    if (!unspent) {
      markStealthSpent(st, r.txid, r.vout, '<spent>');
      continue;
    }

    const prev = await chainIO.getPrevOutput(r.txid, r.vout);
    const value = toBigIntSats(prev.value);
    if (value < minSats) continue;

    const expectedH160 = parseP2pkhHash160(prev.scriptPubKey);
    if (!expectedH160 || bytesToHex(expectedH160) !== r.hash160Hex) {
      throw new Error(`stealth utxo prevout mismatch at ${r.txid}:${r.vout}`);
    }

    const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
      wallet.scanPrivBytes ?? wallet.privBytes,
      wallet.spendPrivBytes ?? wallet.privBytes,
      hexToBytes(r.rpaContext.senderPub33Hex),
      r.rpaContext.prevoutHashHex,
      r.rpaContext.prevoutN,
      r.rpaContext.index
    );

    const { h160 } = pubkeyHashFromPriv(oneTimePriv);
    if (bytesToHex(h160) !== r.hash160Hex) {
      throw new Error(`stealth utxo derivation mismatch at ${r.txid}:${r.vout}`);
    }

    return {
      txid: r.txid,
      vout: r.vout,
      prevOut: prev,
      signPrivBytes: oneTimePriv,
      source: 'stealth',
      record: r,
    };
  }

  const utxos = await getUtxos(wallet.address, network, true);
  const base = (utxos ?? [])
    .filter((u) => u && !u.token_data)
    .sort((a, b) =>
      toBigIntSats(b.valueSats ?? b.value ?? 0) > toBigIntSats(a.valueSats ?? a.value ?? 0) ? 1 : -1
    );

  for (const u of base) {
    const prev = await chainIO.getPrevOutput(u.txid, u.vout);
    const value = toBigIntSats(prev.value);
    if (value < minSats) continue;

    if (!parseP2pkhHash160(prev.scriptPubKey)) continue;

    return {
      txid: u.txid,
      vout: u.vout,
      prevOut: prev,
      signPrivBytes: wallet.privBytes,
      source: 'base',
    };
  }

  throw new Error(`No funding UTXO available for ${ownerTag}. Fund ${wallet.address} on chipnet.`);
}