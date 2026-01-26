// packages/cli/src/wallets.ts
import fs from 'node:fs';
import path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { hash160, hexToBytes, encodeCashAddr, ensureEvenYPriv } from '@bch-stealth/utils';
import { NETWORK } from './config.js';

export type LoadedWallet = {
  address: string;
  privBytes: Uint8Array;
  pubBytes: Uint8Array;
  hash160: Uint8Array;
  scanPrivBytes?: Uint8Array;
  spendPrivBytes?: Uint8Array;
};

function readJson(file: string): any {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function toPrivBytes(x: any, label: string): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') {
    const s = x.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]+$/.test(s) || s.length !== 64) {
      throw new Error(`[wallets] ${label} must be 32-byte hex`);
    }
    return hexToBytes(s);
  }
  throw new Error(`[wallets] ${label} must be Uint8Array or 32-byte hex`);
}

function cashaddrPrefixFromNetwork(): 'bitcoincash' | 'bchtest' {
  const n = String(NETWORK ?? '').toLowerCase();
  // chipnet/testnet/regtest all use bchtest prefix in most tooling
  return n === 'mainnet' ? 'bitcoincash' : 'bchtest';
}

function deriveAddressFromH160(h160: Uint8Array): string {
  return encodeCashAddr(cashaddrPrefixFromNetwork(), 'P2PKH', h160);
}

function normalizeWallet(raw: any, label: string): LoadedWallet {
  if (raw == null) throw new Error(`[wallets] missing wallet: ${label}`);

  // allow shorthand: "<privhex>"
  const obj = typeof raw === 'string' ? { privHex: raw } : raw;

  const priv =
    obj.privBytes ??
    obj.priv ??
    obj.privKey ??
    obj.privateKeyHex ??
    obj.privHex ??
    obj.signPrivHex ??
    obj.signPrivBytes;

  // parity with original working version
  let privBytes = toPrivBytes(priv, `${label}.priv`);
  privBytes = ensureEvenYPriv(privBytes);

  const pubBytes =
    obj.pubBytes instanceof Uint8Array
      ? obj.pubBytes
      : typeof obj.pubHex === 'string'
        ? hexToBytes(String(obj.pubHex).replace(/^0x/, ''))
        : secp256k1.getPublicKey(privBytes, true);

  const h160 = obj.hash160 instanceof Uint8Array ? obj.hash160 : hash160(pubBytes);

  // address optional; derive if missing
  const addressRaw = String(obj.address ?? obj.cashaddr ?? obj.cashAddress ?? '').trim();
  const address = addressRaw || deriveAddressFromH160(h160);

  const scanPrivBytes = obj.scanPrivHex
    ? ensureEvenYPriv(toPrivBytes(obj.scanPrivHex, `${label}.scanPrivHex`))
    : undefined;

  const spendPrivBytes = obj.spendPrivHex
    ? ensureEvenYPriv(toPrivBytes(obj.spendPrivHex, `${label}.spendPrivHex`))
    : undefined;

  return { address, privBytes, pubBytes, hash160: h160, scanPrivBytes, spendPrivBytes };
}

export function resolveDefaultWalletPath(): string {
  const env = String(process.env.BCH_STEALTH_WALLET ?? '').trim();
  if (env) return path.resolve(env);

  const single = path.resolve(process.cwd(), 'wallet.json');
  if (fs.existsSync(single)) return single;

  throw new Error(
    `[wallets] wallet.json not found in ${process.cwd()}\n` +
      `Create one with: bchctl wallet init`
  );
}

export async function getWallet(opts?: { walletFile?: string }): Promise<LoadedWallet> {
  const walletFile = path.resolve(opts?.walletFile ?? resolveDefaultWalletPath());
  const j = readJson(walletFile);
  return normalizeWallet(j, 'wallet');
}

// -------------------------------------------------------------------------------------
// Shared config.json support (kubectl-style contexts)
//   ./.bch-stealth/config.json
//   {
//     "version": 1,
//     "currentProfile": "default",
//     "profiles": {
//       "alice": { "wallet": { "privHex": "...", "scanPrivHex": "...", "spendPrivHex": "..." } }
//     }
//   }
// -------------------------------------------------------------------------------------

function readJsonIfExists(file: string): any | null {
  try {
    if (!fs.existsSync(file)) return null;
    return readJson(file);
  } catch {
    return null;
  }
}

function pickProfileFromConfig(cfg: any, profile: string): any | null {
  if (!cfg || typeof cfg !== 'object') return null;
  const profiles = cfg.profiles;
  if (!profiles || typeof profiles !== 'object') return null;
  const entry = profiles[profile];
  if (!entry || typeof entry !== 'object') return null;
  return entry;
}

export function getWalletFromConfig(args: {
  configFile: string;
  profile: string;
}): LoadedWallet | null {
  const { configFile, profile } = args;

  const cfg = readJsonIfExists(configFile);
  if (!cfg) return null;

  const entry = pickProfileFromConfig(cfg, profile);
  if (!entry) return null;

  // Support either:
  // - profiles[profile].wallet = { privHex, scanPrivHex?, spendPrivHex?, address? }
  // - profiles[profile] = { privHex, ... } (shorthand)
  const rawWallet = entry.wallet ?? entry;
  if (!rawWallet || typeof rawWallet !== 'object') return null;

  const privHex = String((rawWallet as any).privHex ?? '').trim();
  if (!privHex) return null;

  // normalizeWallet already handles privHex + optional scan/spend priv hex
  return normalizeWallet(rawWallet, `config.profiles.${profile}.wallet`);
}