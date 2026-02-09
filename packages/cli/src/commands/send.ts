// packages/cli/src/commands/send.ts
//
// Drop-in replacement (Phase 2 UX):
// - Adds optional sender-side grinding controls that affect paycode sends.
// - Defaults to "auto grind" for paycode destinations (like Electron Cash behavior),
//   but keeps escape hatches for Phase 2 pragmatism.
//
// New flags:
//   --no-grind            Disable paycode grinding (forces index=0 derivation).
//   --grind-max <N>       Max grind attempts (default 256). 0 => disable grinding.
//   --grind-prefix <hex>  Override grind prefix byte (1 byte hex like "56").
//                         (Normally derived from receiver scanPub33 via sha256(tag||Q)[0].)

import { Command } from 'commander';

import * as Electrum from '@bch-stealth/electrum';
import { DUST, NETWORK } from '../config.js';
import { makeChainIO } from '../pool/io.js';
import type { LoadedWallet } from '../wallets.js';
import { runSend } from '../ops/send.js';

import { readConfig, ensureConfigDefaults } from '../config_store.js';
import { getWalletFromConfig } from '../wallets.js';
import { generatePaycode } from '../paycodes.js';

function stripAnsi(s: string): string {
  // Good-enough ANSI stripper for CLI piping issues
  return String(s ?? '').replace(/\u001b\[[0-9;]*m/g, '');
}

export function getTxUrl(network: string, txid: string): string {
  const n = String(network || '').toLowerCase();
  if (n.includes('chip')) return `https://chipnet.chaingraph.cash/tx/${txid}`;
  return `https://blockchair.com/bitcoin-cash/transaction/${txid}`;
}

function parseOptionalHexByte(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const x = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[0-9a-f]{2}$/.test(x)) {
    throw new Error(`send: --grind-prefix must be exactly 1 byte hex (e.g. "56"), got "${String(raw)}"`);
  }
  return Number.parseInt(x, 16);
}

function parseNonNegativeInt(raw: unknown, label: string): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`send: ${label} must be a non-negative number`);
  return Math.floor(n);
}

export function registerSendCommand(
  program: Command,
  deps: {
    loadMeWallet: () => Promise<LoadedWallet>;
    getActivePaths: () => { profile: string; configFile?: string };
    getUtxos: (...a: any[]) => Promise<any[]>;
  }
) {
  program
    .command('send')
    .description('Send sats to a cashaddr or paycode (no pool required).')
    .argument('[dest]', 'cashaddr (P2PKH) or paycode (PM...). Optional if --to-profile is used.')
    .argument('<sats>', 'amount in satoshis')
    .option('--to-profile <name>', 'Resolve destination paycode from another local profile (no copy/paste).')
    .option('--dry-run', 'Build and sign the transaction but do not broadcast.')
    .option('--no-paycode', 'Reject paycode destinations (require cashaddr).')
    .option('--all', 'Also print hex internals (hash160, raw tx hex).', false)
    // --- Phase 2 grinding controls ---
    .option('--no-grind', 'Disable paycode grinding (forces index=0 derivation).')
    .option('--grind-max <N>', 'Max grind attempts for paycode sends (default 256). 0 disables grinding.', (v) =>
      Number(v)
    )
    .option('--grind-prefix <HH>', 'Override grind prefix byte (1 byte hex like "56"). Optional.', (v) => String(v))
    .action(
      async (
        destMaybe: string | undefined,
        satsRaw: string,
        opts: {
          toProfile?: string;
          dryRun?: boolean;
          paycode?: boolean;
          all?: boolean;
          grind?: boolean; // commander sets --no-grind => grind=false
          grindMax?: number;
          grindPrefix?: string;
        }
      ) => {
        const sats = BigInt(String(satsRaw).trim());
        const me = await deps.loadMeWallet();
        const { profile } = deps.getActivePaths();
        const all = !!opts?.all;

        let destStr = stripAnsi(String(destMaybe ?? '').trim());

        // If --to-profile is provided, resolve paycode from config and ignore dest argument
        if (opts.toProfile) {
          const active = deps.getActivePaths();
          const configFile = String(active.configFile ?? '').trim();
          if (!configFile) {
            throw new Error('send: deps.getActivePaths() must include configFile when using --to-profile');
          }

          const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);
          void cfg0; // keep lint quiet if unused in some builds

          const target = String(opts.toProfile).trim();
          if (!target) throw new Error('send: --to-profile cannot be empty');

          const w = getWalletFromConfig({ configFile, profile: target });
          if (!w) throw new Error(`send: could not find wallet for --to-profile "${target}"`);

          const paycodeKey = (w as any).scanPrivBytes ?? w.privBytes;
          destStr = generatePaycode(paycodeKey);
        }

        if (!destStr) throw new Error('send: missing <dest> (or provide --to-profile)');

        if (opts?.paycode === false && destStr.startsWith('PM')) {
          throw new Error('send: paycode destinations disabled by --no-paycode (provide a cashaddr)');
        }

        const electrum: any = Electrum as any;
        const chainIO = makeChainIO({ network: NETWORK, electrum });

        // Grinding policy defaults:
        // - Enabled for paycodes unless user passes --no-grind or --grind-max 0.
        const grindEnabled = opts.grind !== false;
        const grindMaxUser = parseNonNegativeInt(opts.grindMax, '--grind-max') ?? 256;
        const grindMax = grindEnabled ? grindMaxUser : 0;
        const grindPrefixByte = parseOptionalHexByte(opts.grindPrefix);

        const res = await runSend(
          {
            network: NETWORK,
            me,
            ownerTag: profile,
            dustSats: BigInt(DUST),
            state: null,
            chainIO,
            getUtxos: deps.getUtxos,
          },
          {
            dest: destStr,
            sats,
            dryRun: !!opts?.dryRun,
            // pass through grind policy (ops layer implements it only for paycodes)
            grind: {
              enabled: grindMax > 0,
              maxAttempts: grindMax,
              prefixByteOverride: grindPrefixByte,
            },
          } as any
        );

        console.log(`network:     ${String(NETWORK)}`);
        console.log(`profile:     ${profile}`);
        console.log(`amountSats:  ${String(sats)}`);
        console.log(`destType:    ${res.destType}`);
        console.log(`dest:        ${res.destAddress}`);

        if (all) {
          console.log(`destHash160: ${res.destHash160Hex}`);
        }

        if (res.txid) {
          console.log(`txid:        ${res.txid}`);
          console.log(`tx:          ${getTxUrl(String(NETWORK), res.txid)}`);
        } else {
          console.log(`txid:        (dry-run)`);
        }

        // Optional debug: show grind result if ops returns it
        if (all && (res as any).grind) {
          const g = (res as any).grind;
          if (g && typeof g === 'object') {
            console.log(`grind:       ${g.used ? 'yes' : 'no'}`);
            if (g.used) {
              console.log(`grindIndex:  ${String(g.index)}`);
              console.log(`grindMax:    ${String(g.maxAttempts)}`);
              if (g.prefixByte != null) {
                const b = Number(g.prefixByte) & 0xff;
                console.log(`grindByte:   ${b.toString(16).padStart(2, '0')}`);
              }
              if (g.found === false) {
                console.log(`grindFound:  no (fell back to index=0)`);
              }
            }
          }
        }

        if (all) {
          console.log(`rawHex:      ${res.rawHex}`);
        } else {
          console.log(`\nℹ Tip: add --all to print hex internals (destHash160/rawHex).\n`);
        }
      }
    );
}