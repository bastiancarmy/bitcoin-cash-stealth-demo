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

/**
 * Exported so index.ts can reuse it without duplicating logic.
 * NOTE: This finds the first ancestor directory containing a package.json.
 */
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

// Preferred “drop it here” override (repo-local, should be gitignored)
const CLI_WALLET_FILE = path.join(REPO_ROOT, 'packages', 'cli', 'wallets.local.json');

// Existing “state dir” location
const STATE_DIR = path.join(REPO_ROOT, '.bch-stealth');
const STATE_WALLET_FILE = path.join(STATE_DIR, 'wallets.local.json');

// Legacy location (older demo)
const LEGACY_WALLET_FILE = path.join(REPO_ROOT, 'demo_state', 'wallets.local.json');

function safeParseWalletPrivFile(filepath: string): WalletPrivFile | null {
  try {
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, 'utf8');
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

/**
 * Returns the *active* wallet file if one exists.
 * Priority:
 *  1) packages/cli/wallets.local.json
 *  2) .bch-stealth/wallets.local.json
 *  3) demo_state/wallets.local.json (legacy)
 */
function findExistingWalletFile(): { filepath: string; privs: WalletPrivFile } | null {
  const candidates = [CLI_WALLET_FILE, STATE_WALLET_FILE, LEGACY_WALLET_FILE];
  for (const fp of candidates) {
    const privs = safeParseWalletPrivFile(fp);
    if (privs) return { filepath: fp, privs };
  }
  return null;
}

function ensureDirForFile(filepath: string): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
}

function writeWalletFile(filepath: string, alicePriv: string, bobPriv: string): void {
  ensureDirForFile(filepath);
  const data: WalletPrivFile = { alicePriv, bobPriv };
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * If legacy exists and no newer file exists, optionally migrate (copy) it.
 * This is PROMPTED and never overwrites.
 */
async function maybeMigrateLegacy(): Promise<void> {
  // If a preferred file already exists, do nothing.
  if (fs.existsSync(CLI_WALLET_FILE) || fs.existsSync(STATE_WALLET_FILE)) return;
  if (!fs.existsSync(LEGACY_WALLET_FILE)) return;

  const legacyPrivs = safeParseWalletPrivFile(LEGACY_WALLET_FILE);
  if (!legacyPrivs) return;

  const ok = await promptYesNo(
    `Found legacy wallet file:\n  ${LEGACY_WALLET_FILE}\n\nCopy it to the new preferred location?\n  ${CLI_WALLET_FILE}\n`,
    true
  );

  if (!ok) return;

  // Copy (not move), and never overwrite
  if (fs.existsSync(CLI_WALLET_FILE)) return;
  writeWalletFile(CLI_WALLET_FILE, legacyPrivs.alicePriv, legacyPrivs.bobPriv);
}

/**
 * Enforce your rule:
 * - never overwrite without prompt
 * - never create/save without prompt
 */
async function maybePersistWallets(
  alicePriv: string,
  bobPriv: string,
  opts: { reason?: string; defaultTarget?: string } = {}
): Promise<{ saved: boolean; filepath?: string }> {
  const reason = opts.reason ? `${opts.reason}\n\n` : '';
  const defaultTarget = opts.defaultTarget ?? CLI_WALLET_FILE;

  const existing = findExistingWalletFile();

  // If a file exists already (any location), NEVER overwrite silently.
  if (existing) {
    const same = existing.privs.alicePriv === alicePriv && existing.privs.bobPriv === bobPriv;
    if (same) return { saved: false, filepath: existing.filepath };

    const ok = await promptYesNo(
      `${reason}Wallet file already exists at:\n  ${existing.filepath}\n\nOverwrite it with the current keys?`,
      false
    );
    if (!ok) return { saved: false, filepath: existing.filepath };

    // Overwrite the file that is currently “active”
    writeWalletFile(existing.filepath, alicePriv, bobPriv);
    return { saved: true, filepath: existing.filepath };
  }

  // No file exists anywhere: prompt before creating one.
  const ok = await promptYesNo(
    `${reason}No local wallet file found.\n\nSave these keys to:\n  ${defaultTarget}\n?`,
    true
  );
  if (!ok) return { saved: false };

  // Never overwrite (should be absent here, but be defensive)
  if (fs.existsSync(defaultTarget)) {
    // If it exists unexpectedly, refuse unless user re-confirms.
    const ok2 = await promptYesNo(
      `Target file already exists:\n  ${defaultTarget}\n\nOverwrite it?`,
      false
    );
    if (!ok2) return { saved: false, filepath: defaultTarget };
  }

  writeWalletFile(defaultTarget, alicePriv, bobPriv);
  return { saved: true, filepath: defaultTarget };
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
  // Optional legacy copy prompt (won’t overwrite anything)
  await maybeMigrateLegacy();

  let alicePriv: string | undefined;
  let bobPriv: string | undefined;

  // Load from file if present (repo-local wins)
  const existing = findExistingWalletFile();
  if (existing) {
    alicePriv = existing.privs.alicePriv;
    bobPriv = existing.privs.bobPriv;
  }

  // Env override (prompted later; never silent persistence/overwrite)
  const envAlice = typeof process.env.ALICE_PRIV_KEY === 'string' ? process.env.ALICE_PRIV_KEY : undefined;
  const envBob = typeof process.env.BOB_PRIV_KEY === 'string' ? process.env.BOB_PRIV_KEY : undefined;
  const haveEnv = Boolean(envAlice || envBob);

  if (haveEnv) {
    const okUseEnv = await promptYesNo(
      `Keys were provided via environment variables.\nUse them for this run?`,
      true
    );
    if (okUseEnv) {
      if (envAlice) alicePriv = envAlice;
      if (envBob) bobPriv = envBob;
    }
  }

  // Prompt (your promptPrivKey already supports “press Enter to generate new”)
  if (!alicePriv) alicePriv = await promptPrivKey('Alice');
  if (!bobPriv) bobPriv = await promptPrivKey('Bob');

  // Prompted persistence behavior (never silent create/overwrite)
  await maybePersistWallets(alicePriv, bobPriv, {
    reason: haveEnv ? 'Env vars were provided.' : '',
    defaultTarget: CLI_WALLET_FILE, // your preferred drop-in path
  });

  const alice = createWallet('Alice', alicePriv);
  const bob = createWallet('Bob', bobPriv);

  return { alice, bob };
}