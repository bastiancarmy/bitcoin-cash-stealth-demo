// packages/cli/src/commands/status.ts
import fs from 'node:fs';
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

export function registerStatusCommand(program: Command, deps: { getActivePaths: GetActivePaths }) {
  const status = getOrCreateSubcommand(program, 'status', 'Show current context and readiness');

  status.action(async () => {
    const { configFile, profile, stateFile, logFile } = deps.getActivePaths();

    const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);
    const currentProfile = String(cfg0.currentProfile ?? 'default');

    const profCfg = (cfg0.profiles ?? {})[profile] ?? {};
    const network = String((profCfg as any).network ?? '(unknown)');
    const birthdayHeight = (profCfg as any).birthdayHeight;
    const birthdayStr =
      typeof birthdayHeight === 'number' && Number.isFinite(birthdayHeight) ? String(birthdayHeight) : '(unset)';

    const w = getWalletFromConfig({ configFile, profile });
    const walletReady = !!w;

    console.log(`profile(flag):    ${profile}`);
    console.log(`currentProfile:   ${currentProfile}`);
    console.log(`config:           ${configFile}`);
    console.log(`network:          ${network}`);
    console.log(`birthdayHeight:   ${birthdayStr}`);
    console.log(`wallet:           ${walletReady ? 'ready' : 'missing'}`);

    if (w) {
      const paycodeKey = (w as any).scanPrivBytes ?? w.privBytes;
      const paycode = generatePaycode(paycodeKey);
      console.log(`transparent:      ${w.address}`);
      console.log(`paycode:          ${paycode}`);
    } else {
      console.log(`hint:             run "bchctl --profile ${profile} wallet init"`);
    }

    console.log(`state file:       ${stateFile} ${fs.existsSync(stateFile) ? '(exists)' : '(missing)'}`);
    console.log(`events log:       ${logFile} ${fs.existsSync(logFile) ? '(exists)' : '(missing)'}`);
  });

  return status;
}