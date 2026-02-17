// packages/cli/src/profile/commands.ts
import { Command } from 'commander';
import { readConfig, writeConfig, ensureConfigDefaults } from '../config_store.js';
import { sanitizeProfileName } from '../paths.js';

export type GetActivePaths = () => { configFile: string; profile: string };

function normalizeNetwork(x: string): 'chipnet' | 'mainnet' {
  const n = String(x ?? '').trim().toLowerCase();
  if (n === 'chipnet' || n === 'mainnet') return n;
  throw new Error(`invalid network "${x}" (expected: chipnet|mainnet)`);
}

/**
 * Build the "profile" command as a standalone command, then the caller adds it to the program:
 *   program.addCommand(makeProfileCommand(...))
 */
export function makeProfileCommand(deps: { getActivePaths: GetActivePaths }): Command {
  const profile = new Command('profile').description('Profile commands');

  profile
    .command('set')
    .description('Set the current profile in .bch-stealth/config.json')
    .argument('<name>', 'profile name')
    .action(async (name: string) => {
      const { configFile } = deps.getActivePaths();
      const prof = sanitizeProfileName(name);

      const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);
      cfg0.currentProfile = prof;

      cfg0.profiles = cfg0.profiles ?? {};
      cfg0.profiles[prof] = cfg0.profiles[prof] ?? {};

      writeConfig({ configFile, config: cfg0 });

      console.log(`currentProfile: ${prof}`);
      console.log(`config file:    ${configFile}`);
    });

  profile
    .command('set-network')
    .description('Set network for a profile (chipnet|mainnet)')
    .argument('<network>', 'chipnet|mainnet')
    .option('--profile <name>', 'profile name (defaults to current)', '')
    .action(async (networkRaw: string, opts: { profile?: string }) => {
      const { configFile, profile: activeProfile } = deps.getActivePaths();
      const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);

      const targetProfileRaw = String(opts.profile ?? '').trim();
      const targetProfile = sanitizeProfileName(
        targetProfileRaw || activeProfile || String(cfg0.currentProfile ?? 'default')
      );

      const network = normalizeNetwork(networkRaw);

      cfg0.profiles = cfg0.profiles ?? {};
      cfg0.profiles[targetProfile] = cfg0.profiles[targetProfile] ?? {};
      cfg0.profiles[targetProfile].network = network;

      writeConfig({ configFile, config: cfg0 });

      console.log(`profile:  ${targetProfile}`);
      console.log(`network:  ${network}`);
      console.log(`config:   ${configFile}`);
      console.log(`note:     pool commands currently require chipnet (assertChipnet).`);
    });

  profile
    .command('get')
    .description('Print the current profile')
    .action(async () => {
      const { configFile } = deps.getActivePaths();
      const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);
      console.log(String(cfg0.currentProfile ?? 'default'));
    });

  profile
    .command('ls')
    .description('List profiles in config')
    .action(async () => {
      const { configFile } = deps.getActivePaths();
      const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);
      const names = Object.keys(cfg0.profiles ?? {}).sort();
      for (const n of names) console.log(n);
    });

  return profile;
}

/**
 * Backwards-compatible wrapper: if callers still want "registerProfileCommands(program, deps)".
 * This guarantees the command is added to the actual root program.
 */
export function registerProfileCommands(program: Command, deps: { getActivePaths: GetActivePaths }) {
  program.addCommand(makeProfileCommand(deps));
}