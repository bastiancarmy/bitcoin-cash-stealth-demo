// src/prompts.ts
import { AMOUNT, FEE, DUST, NETWORK } from './config.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@bch-stealth/utils';
import readline from 'node:readline/promises';

export async function promptYesNo(question: string, defaultNo = true): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultNo ? ' [y/N] ' : ' [Y/n] ';
    const ans = (await rl.question(`${question}${suffix}`)).trim().toLowerCase();
    if (!ans) return !defaultNo;
    return ans === 'y' || ans === 'yes';
  } finally {
    rl.close();
  }
}

export async function promptFundAddress(address: string): Promise<void> {
  console.log(`Please fund this ${NETWORK} address with at least ${AMOUNT + FEE + DUST} sat: ${address}`);
  console.log('Use your wallet or exchange to send BCH.');
  console.log('Press Enter after funding...');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
}

export async function promptPrivKey(role: string): Promise<string> {
  console.log(`Enter ${role} private key (hex) or press Enter to generate new:`);
  return new Promise<string>((resolve) => {
    process.stdin.once('data', (input) => {
      const privHex = input.toString().trim();
      resolve(privHex || bytesToHex(secp256k1.utils.randomSecretKey()));
    });
  });
}