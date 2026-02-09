// packages/cli/src/commands/wallet.ts
import type { Command } from 'commander';
import * as Electrum from '@bch-stealth/electrum';

import { bytesToHex } from '@bch-stealth/utils';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { registerWalletInit, type GetActivePaths } from '../wallet/init.js';
import { getWalletFromConfig } from '../wallets.js';
import { decodePaycode, generatePaycode } from '../paycodes.js';

import { deriveSpendPriv32FromScanPriv32 } from '@bch-stealth/rpa-derive';

function getOrCreateSubcommand(program: Command, name: string, description: string): Command {
  const existing = (program.commands ?? []).find((c) => c.name() === name);
  if (existing) return existing;
  return program.command(name).description(description);
}

function safePub33FromPriv32(priv32?: Uint8Array): Uint8Array | null {
  if (!(priv32 instanceof Uint8Array) || priv32.length !== 32) return null;
  return secp256k1.getPublicKey(priv32, true);
}

export function registerWalletCommands(program: Command, deps: { getActivePaths: GetActivePaths }) {
  const wallet = getOrCreateSubcommand(program, 'wallet', 'Wallet commands (single-user)');

  // Existing: wallet init
  registerWalletInit(wallet, { getActivePaths: deps.getActivePaths, Electrum });

  // New: wallet show
  wallet
    .command('show')
    .description(
      'Show active profile wallet identifiers (address + paycode). Use --all for full key material identifiers.'
    )
    .option('--all', 'include all derived identifiers (pubkeys/hash160). Never prints private keys.', false)
    .option('--json', 'print as JSON (machine-friendly)', false)
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const { profile, configFile } = deps.getActivePaths();

      const me = getWalletFromConfig({ configFile, profile });
      if (!me) {
        throw new Error(
          `[wallet] no wallet found for profile "${profile}"\n` + `Try: bchctl --profile ${profile} wallet init`
        );
      }

      const scanPriv = (me as any).scanPrivBytes;
      if (!scanPriv) {
        throw new Error(
          `[wallet] scanPrivHex is required to generate a paycode.\n` +
            `Your config appears to be missing scanPrivHex for this profile.\n` +
            `Fix: run "bchctl --profile ${profile} wallet init" again (or migrate the profile to include scanPrivHex).`
        );
      }
      const paycode = generatePaycode(scanPriv);

      // Optional: scan/spend pubs
      const scanPriv32: Uint8Array | undefined = (me as any).scanPrivBytes;
      const spendPriv32: Uint8Array | undefined =
        (me as any).spendPrivBytes ?? (scanPriv32 ? deriveSpendPriv32FromScanPriv32(scanPriv32) : undefined);

      const scanPub33 = safePub33FromPriv32(scanPriv32);
      const spendPub33 = safePub33FromPriv32(spendPriv32);

      // NEW: under --all, print the paycode-embedded pubkey so we can verify it matches scan.pub33Hex
      let paycodePub33Hex: string | null = null;
      if (opts.all) {
        try {
          const decoded = decodePaycode(paycode);
          paycodePub33Hex = bytesToHex(decoded.pubkey33);
        } catch {
          paycodePub33Hex = null;
        }
      }

      // Default (most user-friendly): just identifiers needed for using the wallet.
      const baseOut = {
        profile,
        address: (me as any).address,
        paycode,
      };

      // --all: include everything devs commonly want during debugging
      const allOut = !opts.all
        ? null
        : {
            base: {
              pub33Hex: bytesToHex((me as any).pubBytes),
              hash160Hex: bytesToHex((me as any).hash160),
            },
            paycode: paycodePub33Hex ? { pub33Hex: paycodePub33Hex } : null,
            scan: scanPub33 ? { pub33Hex: bytesToHex(scanPub33) } : null,
            spend: spendPub33 ? { pub33Hex: bytesToHex(spendPub33) } : null,
          };

      if (opts.json) {
        const out = allOut ? { ...baseOut, ...allOut } : baseOut;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return;
      }

      console.log(`profile: ${baseOut.profile}`);
      console.log(`address: ${baseOut.address}`);
      console.log(`paycode: ${baseOut.paycode}`);

      if (allOut) {
        console.log(`base.pub33Hex:     ${allOut.base.pub33Hex}`);
        console.log(`base.hash160:      ${allOut.base.hash160Hex}`);
        if (allOut.paycode) console.log(`paycode.pub33Hex:  ${allOut.paycode.pub33Hex}`);
        if (allOut.scan) console.log(`scan.pub33Hex:     ${allOut.scan.pub33Hex}`);
        if (allOut.spend) console.log(`spend.pub33Hex:    ${allOut.spend.pub33Hex}`);

        // Helpful hint if things are inconsistent
        if (allOut.paycode?.pub33Hex && allOut.scan?.pub33Hex && allOut.paycode.pub33Hex !== allOut.scan.pub33Hex) {
          console.log('');
          console.log('⚠️  warning: paycode.pub33Hex != scan.pub33Hex');
          console.log('   This means the paycode is not being derived from the scan key you are using to scan.');
        }
      }
    });

  // New: wallet paycode (script-friendly; prints ONLY the paycode + newline)
  wallet
    .command('paycode')
    .description('Print the active profile paycode (single line; safe for scripts).')
    .action(() => {
      const { profile, configFile } = deps.getActivePaths();

      const me = getWalletFromConfig({ configFile, profile });
      if (!me) {
        throw new Error(
          `[wallet] no wallet found for profile "${profile}"\n` + `Try: bchctl --profile ${profile} wallet init`
        );
      }

      const paycodeKey = (me as any).scanPrivBytes ?? (me as any).privBytes;
      const paycode = generatePaycode(paycodeKey);

      // IMPORTANT: emit ONLY the paycode, no labels/logs (so $(...) works)
      process.stdout.write(paycode + '\n');
    });

  return wallet;
}