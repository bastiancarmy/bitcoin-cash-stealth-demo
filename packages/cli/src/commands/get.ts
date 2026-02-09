// packages/cli/src/commands/get.ts
import type { Command } from 'commander';

import { ensureConfigDefaults, readConfig } from '../config_store.js';
import { getWalletFromConfig } from '../wallets.js';
import { generatePaycode } from '../paycodes.js';

type GetActivePaths = () => {
  configFile: string;
  profile: string;
  stateFile: string;
  logFile: string;
};

function getOrCreateSubcommand(program: Command, name: string, description: string): Command {
  const existing = (program.commands ?? []).find((c) => c.name() === name);
  if (existing) return existing;
  return program.command(name).description(description);
}

function printWalletSurfaces(args: {
  network: string;
  transparent: string;
  paycode: string;
}) {
  console.log(`network:      ${args.network}`);
  console.log(`transparent:  ${args.transparent}`);
  console.log(`paycode:      ${args.paycode}`);
}

export function registerGetCommands(program: Command, deps: { getActivePaths: GetActivePaths }) {
  const get = getOrCreateSubcommand(program, 'get', 'Get resources');

  // bchctl get profiles
  get
    .command('profiles')
    .description('List profiles in config (marks currentProfile with *)')
    .action(async () => {
      const { configFile } = deps.getActivePaths();
      const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);

      const current = String(cfg0.currentProfile ?? 'default');
      const names = Object.keys(cfg0.profiles ?? {}).sort();

      if (names.length === 0) {
        console.log('(no profiles)');
        return;
      }

      for (const n of names) {
        const mark = n === current ? '*' : ' ';
        console.log(`${mark} ${n}`);
      }
    });

  // bchctl get wallets
  get
    .command('wallets')
    .description('List wallets across all profiles (prints surfaces where available)')
    .action(async () => {
      const { configFile } = deps.getActivePaths();
      const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);

      const current = String(cfg0.currentProfile ?? 'default');
      const names = Object.keys(cfg0.profiles ?? {}).sort();

      if (names.length === 0) {
        console.log('(no profiles)');
        return;
      }

      for (const prof of names) {
        const mark = prof === current ? '*' : ' ';
        const p = (cfg0.profiles ?? {})[prof] ?? {};
        const net = String((p as any).network ?? '');

        const w = getWalletFromConfig({ configFile, profile: prof });
        if (!w) {
          console.log(`${mark} ${prof}  (no wallet)`);
          continue;
        }

        const paycodeKey = (w as any).scanPrivBytes ?? w.privBytes;
        const paycode = generatePaycode(paycodeKey);

        console.log(`${mark} ${prof}`);
        printWalletSurfaces({
          network: net || '(unknown)',
          transparent: w.address,
          paycode,
        });
        console.log('');
      }
    });

  // bchctl get wallet [profile]
  get
    .command('wallet')
    .description('Print wallet surfaces for a profile (defaults to active profile flag)')
    .argument('[profile]', 'profile name (optional)')
    .action(async (profileArg?: string) => {
      const { configFile, profile: activeProfile } = deps.getActivePaths();
      const prof = String(profileArg ?? '').trim() || String(activeProfile ?? '').trim() || 'default';

      const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);
      const p = (cfg0.profiles ?? {})[prof] ?? {};
      const net = String((p as any).network ?? '');

      const w = getWalletFromConfig({ configFile, profile: prof });
      if (!w) {
        throw new Error(
          `[get] no wallet configured for profile "${prof}"\n` +
            `Run: bchctl --profile ${prof} wallet init`
        );
      }

      const paycodeKey = (w as any).scanPrivBytes ?? w.privBytes;
      const paycode = generatePaycode(paycodeKey);

      // keep copy/paste ready
      console.log(`profile:      ${prof}`);
      printWalletSurfaces({
        network: net || '(unknown)',
        transparent: w.address,
        paycode,
      });
    });

  return get;
}