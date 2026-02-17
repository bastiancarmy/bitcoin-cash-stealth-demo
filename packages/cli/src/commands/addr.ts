// packages/cli/src/commands/addr.ts
import fs from 'node:fs';

import type { Command } from 'commander';

import { readConfig, ensureConfigDefaults } from '../config_store.js';
import { generatePaycode } from '../paycodes.js';

export type GetActivePaths = () => {
  configFile: string;
  profile: string;
  walletFile: string;
};

export type LoadMeWallet = () => Promise<{ address: string; privBytes: Uint8Array }>;

function getOrCreateTopCommand(program: Command, name: string, description: string): Command {
  const existing = (program.commands ?? []).find((c) => c.name() === name);
  if (existing) return existing;
  return program.command(name).description(description);
}

function readWalletFileNetwork(walletFile: string): string | null {
  try {
    if (!walletFile) return null;
    if (!fs.existsSync(walletFile)) return null;
    const raw = fs.readFileSync(walletFile, 'utf8');
    const j = JSON.parse(raw);
    const n = String(j?.network ?? '').trim().toLowerCase();
    return n ? n : null;
  } catch {
    return null;
  }
}

function resolveNetworkFromConfig(configFile: string, profile: string): string | null {
  try {
    const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);
    const n = String(cfg0?.profiles?.[profile]?.network ?? '').trim().toLowerCase();
    return n ? n : null;
  } catch {
    return null;
  }
}

export function registerAddrCommand(
  program: Command,
  deps: { getActivePaths: GetActivePaths; loadMeWallet: LoadMeWallet }
) {
  const cmd = getOrCreateTopCommand(program, 'addr', 'Print funding addresses for the active profile wallet.');

  cmd
    .option('--transparent', 'print only the transparent base address', false)
    .option('--paycode', 'print only the paycode', false)
    .action(async (opts) => {
      const { configFile, profile, walletFile } = deps.getActivePaths();

      const onlyTransparent = !!opts.transparent;
      const onlyPaycode = !!opts.paycode;

      if (onlyTransparent && onlyPaycode) {
        throw new Error('choose only one: --transparent or --paycode');
      }

      // Wallet must exist (config-first; file override supported via your loadMeWallet)
      const me = await deps.loadMeWallet();
      const paycodeKey = (me as any).scanPrivBytes ?? me.privBytes;
      const paycode = generatePaycode(paycodeKey);

      // Network must be known (prefer config; fallback to wallet file)
      const network =
        resolveNetworkFromConfig(configFile, profile) ??
        readWalletFileNetwork(walletFile);

      if (!network) {
        throw new Error(
          `[addr] network is not configured for profile "${profile}".\n` +
            `Run: bchctl --profile ${profile} wallet init --chipnet\n` +
            `Config: ${configFile}`
        );
      }

      // Copy/paste-ready output
      console.log(`network:      ${network}`);

      if (!onlyPaycode) {
        console.log(`transparent:  ${me.address}`);
      }

      if (!onlyTransparent) {
        console.log(`paycode:      ${paycode}`);
      }
    });

  return cmd;
}