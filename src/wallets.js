// src/wallets.js
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { _hash160, hexToBytes, bytesToHex, ensureEvenYPriv } from './utils.js';
import { encodeCashAddr } from './cashaddr.js';
import { promptPrivKey, promptYesNo } from './prompts.js';
import { NETWORK } from './config.js';

import fs from 'fs';
import path from 'path';

function findRepoRoot(startDir = process.cwd()) {
  let dir = startDir;
  while (true) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // fallback
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot();
const WALLET_FILE = path.join(REPO_ROOT, 'demo_state', 'wallets.local.json');

function walletFileExists() {
  return fs.existsSync(WALLET_FILE);
}

function loadLocalWalletPrivs() {
  try {
    if (!fs.existsSync(WALLET_FILE)) return null;
    const raw = fs.readFileSync(WALLET_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.alicePriv === 'string' && typeof parsed.bobPriv === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function saveLocalWalletPrivs(alicePriv, bobPriv) {
  try {
    fs.mkdirSync(path.dirname(WALLET_FILE), { recursive: true });
    const data = { alicePriv, bobPriv };
    fs.writeFileSync(WALLET_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('Warning: could not save wallet file:', e.message);
  }
}

async function maybePersistWallets(alicePriv, bobPriv, { reason = '' } = {}) {
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

export function createWallet(name, privKeyHex) {
  if (!privKeyHex || typeof privKeyHex !== 'string') {
    throw new Error(`createWallet(${name}) requires a hex private key string`);
  }

  let privBytes = hexToBytes(privKeyHex);
  privBytes = ensureEvenYPriv(privBytes);
  privKeyHex = bytesToHex(privBytes);

  const pubBytes = secp256k1.getPublicKey(privBytes, true);
  try {
    secp256k1.Point.fromHex(bytesToHex(pubBytes));
  } catch (e) {
    throw new Error(`Invalid generated pubKey: ${e.message}`);
  }

  const pub = bytesToHex(pubBytes);
  const hash160 = _hash160(pubBytes);

  const prefix = NETWORK === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const address = encodeCashAddr(prefix, 'P2PKH', hash160);

  return { priv: privKeyHex, pub, privBytes, pubBytes, hash160, address };
}

export async function getWallets() {
  let alicePriv, bobPriv;

  // 1) Load from local file if present
  const local = loadLocalWalletPrivs();
  if (local) {
    alicePriv = local.alicePriv;
    bobPriv = local.bobPriv;
  }

  // 2) Allow override via env vars (optional)
  const envAlice = process.env.ALICE_PRIV_KEY;
  const envBob = process.env.BOB_PRIV_KEY;
  const usedEnvOverride = Boolean(envAlice || envBob);

  if (envAlice) alicePriv = envAlice;
  if (envBob) bobPriv = envBob;

  // 3) If still missing, prompt + generate
  if (!alicePriv) {
    console.log(`No Alice key found in ${WALLET_FILE}. Generating/entering one now…`);
    alicePriv = await promptPrivKey('Alice');
  }
  if (!bobPriv) {
    console.log(`No Bob key found in ${WALLET_FILE}. Generating/entering one now…`);
    bobPriv = await promptPrivKey('Bob');
  }

  // 4) Persist with safety prompts
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

  console.log('--- Obtaining Alice Wallet ---');
  console.log('Alice Pub:', alice.pub);
  console.log('Alice Address:', alice.address);

  console.log('--- Obtaining Bob Wallet ---');
  console.log('Bob Pub:', bob.pub);
  console.log('Bob Address:', bob.address);

  console.log(`\nNote: Wallet keys are stored at:\n  ${WALLET_FILE}`);
  console.log('DO NOT COMMIT demo_state/ (recommended to add to .gitignore).');
  console.log('To override without changing the file, set ALICE_PRIV_KEY and BOB_PRIV_KEY.\n');

  return { alice, bob };
}