// src/wallets.ts
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hexToBytes, bytesToHex, ensureEvenYPriv, hash160 } from '@bch-stealth/utils';
import { promptPrivKey, promptYesNo } from './prompts.js';
import { NETWORK } from './config.js';
import { encodeCashAddr } from '@bch-stealth/utils';

import fs from 'node:fs';
import path from 'node:path';

export type Wallet = {
  priv: string;
  pub: string;
  privBytes: Uint8Array;
  pubBytes: Uint8Array;
  hash160: Uint8Array;
  address: string;
  scanPrivBytes?: Uint8Array;
  spendPrivBytes?: Uint8Array;
};

type WalletPrivFile = { alicePriv: string; bobPriv: string };

// Exported so index.ts can reuse it without duplicating logic.
export function findRepoRoot(startDir = process.cwd()): string {
  let dir = startDir;
  while (true) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot();

const STATE_DIR = path.join(REPO_ROOT, '.bch-stealth');
const WALLET_FILE = path.join(STATE_DIR, 'wallets.local.json');

// legacy location
const LEGACY_WALLET_FILE = path.join(REPO_ROOT, 'demo_state', 'wallets.local.json');

function migrateWalletFileSync(): void {
  if (fs.existsSync(WALLET_FILE)) return;
  if (!fs.existsSync(LEGACY_WALLET_FILE)) return;

  fs.mkdirSync(path.dirname(WALLET_FILE), { recursive: true });
  fs.renameSync(LEGACY_WALLET_FILE, WALLET_FILE);
}

function walletFileExists(): boolean {
  migrateWalletFileSync();
  return fs.existsSync(WALLET_FILE);
}

function loadLocalWalletPrivs(): WalletPrivFile | null {
  try {
    migrateWalletFileSync();

    if (!fs.existsSync(WALLET_FILE)) return null;
    const raw = fs.readFileSync(WALLET_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    if (
      parsed &&
      typeof parsed === 'object' &&
      'alicePriv' in parsed &&
      'bobPriv' in parsed &&
      typeof (parsed as any).alicePriv === 'string' &&
      typeof (parsed as any).bobPriv === 'string'
    ) {
      return { alicePriv: (parsed as any).alicePriv, bobPriv: (parsed as any).bobPriv };
    }
    return null;
  } catch {
    return null;
  }
}

function saveLocalWalletPrivs(alicePriv: string, bobPriv: string): void {
  migrateWalletFileSync();

  fs.mkdirSync(path.dirname(WALLET_FILE), { recursive: true });
  const data: WalletPrivFile = { alicePriv, bobPriv };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function maybePersistWallets(
  alicePriv: string,
  bobPriv: string,
  { reason = '' }: { reason?: string } = {}
): Promise<boolean> {
  if (!walletFileExists()) {
    saveLocalWalletPrivs(alicePriv, bobPriv);
    return true;
  }

  const existing = loadLocalWalletPrivs();
  const same = existing?.alicePriv === alicePriv && existing?.bobPriv === bobPriv;
  if (same) return false;

  const header = reason ? `${reason}\n\n` : '';
  const ok = await promptYesNo(
    `${header}Wallet file already exists at:\n  ${WALLET_FILE}\n\nOverwrite it with the current keys?`,
    false
  );

  if (ok) {
    saveLocalWalletPrivs(alicePriv, bobPriv);
    return true;
  }
  return false;
}

export function createWallet(name: string, privKeyHex: string): Wallet {
  if (!privKeyHex || typeof privKeyHex !== 'string') {
    throw new Error(`createWallet(${name}) requires a hex private key string`);
  }

  let privBytes = hexToBytes(privKeyHex);
  privBytes = ensureEvenYPriv(privBytes);
  privKeyHex = bytesToHex(privBytes);

  const pubBytes = secp256k1.getPublicKey(privBytes, true);
  const pub = bytesToHex(pubBytes);

  const h160 = hash160(pubBytes);

  const prefix = NETWORK === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const address = encodeCashAddr(prefix, 'P2PKH', h160);

  return { priv: privKeyHex, pub, privBytes, pubBytes, hash160: h160, address };
}

export async function getWallets(): Promise<{ alice: Wallet; bob: Wallet }> {
  let alicePriv: string | undefined;
  let bobPriv: string | undefined;

  const local = loadLocalWalletPrivs();
  if (local) {
    alicePriv = local.alicePriv;
    bobPriv = local.bobPriv;
  }

  const envAlice = typeof process.env.ALICE_PRIV_KEY === 'string' ? process.env.ALICE_PRIV_KEY : undefined;
  const envBob = typeof process.env.BOB_PRIV_KEY === 'string' ? process.env.BOB_PRIV_KEY : undefined;
  const usedEnvOverride = Boolean(envAlice || envBob);

  if (envAlice) alicePriv = envAlice;
  if (envBob) bobPriv = envBob;

  if (!alicePriv) alicePriv = await promptPrivKey('Alice');
  if (!bobPriv) bobPriv = await promptPrivKey('Bob');

  if (usedEnvOverride) {
    const ok = await promptYesNo(
      `Keys were provided via environment variables.\nPersist these keys to:\n  ${WALLET_FILE}\n?`,
      false
    );
    if (ok) await maybePersistWallets(alicePriv, bobPriv, { reason: 'Persisting env-provided keys.' });
  } else {
    await maybePersistWallets(alicePriv, bobPriv);
  }

  const alice = createWallet('Alice', alicePriv);
  const bob = createWallet('Bob', bobPriv);

  return { alice, bob };
}