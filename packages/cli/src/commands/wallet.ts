// packages/cli/src/commands/wallet.ts
import type { Command } from 'commander';
import * as Electrum from '@bch-stealth/electrum';

import { registerWalletInit, type GetActivePaths } from '../wallet/init.js';

function getOrCreateSubcommand(program: Command, name: string, description: string): Command {
  // commander stores subcommands on program.commands
  const existing = (program.commands ?? []).find((c) => c.name() === name);
  if (existing) return existing;

  return program.command(name).description(description);
}

export function registerWalletCommands(program: Command, deps: { getActivePaths: GetActivePaths }) {
  const wallet = getOrCreateSubcommand(program, 'wallet', 'Wallet commands (single-user)');
  registerWalletInit(wallet, { getActivePaths: deps.getActivePaths, Electrum });
  return wallet;
}