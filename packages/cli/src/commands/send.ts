// packages/cli/src/commands/send.ts
//
// Phase 2 defaults locked:
// - Default grind mode is 8-bit (handled in ops/send.ts).
// - Default grind-max is 2048 for paycode sends (high success probability).
// - 16-bit grind is opt-in via --grind-prefix16.
//
// Behavior:
// - Always resolves config/state paths via resolveProfilePaths({ cwd, profile, ... }).
// - Loads state via loadStateOrEmpty and persists it after broadcast.
// - Passes state into runSend so stealth change can allocate index + record stealthUtxos.
// - Supports --self-paycode override (temporary UX).

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';

import * as Electrum from '@bch-stealth/electrum';
import { FileBackedPoolStateStore } from '@bch-stealth/pool-state';

import { DUST, NETWORK } from '../config.js';
import { makeChainIO } from '../pool/io.js';
import { loadStateOrEmpty, saveState } from '../pool/state.js';

import type { LoadedWallet } from '../wallets.js';
import { runSend, RUNSEND_BUILD_ID } from '../ops/send.js';

import { readConfig, ensureConfigDefaults } from '../config_store.js';
import { getWalletFromConfig } from '../wallets.js';
import { generatePaycode } from '../paycodes.js';

import { resolveProfilePaths } from '../paths.js';

function stripAnsi(s: string): string {
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

function parseOptionalHex16(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const x = s.startsWith('0x') ? s.slice(2) : s;
  if (!/^[0-9a-f]{4}$/.test(x)) {
    throw new Error(`send: --grind-prefix16 must be exactly 2 bytes hex (e.g. "c272"), got "${String(raw)}"`);
  }
  return x;
}

function parseNonNegativeInt(raw: unknown, label: string): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`send: ${label} must be a non-negative number`);
  return Math.floor(n);
}

function ensureDirForFile(filename: string) {
  const dir = path.dirname(filename);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function registerSendCommand(
  program: Command,
  deps: {
    loadMeWallet: () => Promise<LoadedWallet>;
    getActivePaths: () => { profile: string };
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
    .option('--no-grind', 'Disable paycode grinding (forces non-targeted send).')
    .option(
      '--grind-max <N>',
      'Max grind attempts for paycode sends (Phase 2 default 2048 for 8-bit). 0 disables grinding.',
      (v) => Number(v)
    )
    .option(
      '--grind-prefix <HH>',
      'Override grind prefix (1 byte hex like "89"). Legacy / Phase 2 fast mode.',
      (v) => String(v)
    )
    .option(
      '--grind-prefix16 <HHHH>',
      'Override grind prefix (2 bytes hex like "8999"). Enables 16-bit mode (slow).',
      (v) => String(v)
    )
    .option('--self-paycode <pm>', 'Override: your own paycode (for stealth change).', '')
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
          grindPrefix16?: string;
          selfPaycode?: string;
        }
      ) => {
        const sats = BigInt(String(satsRaw).trim());
        const me = await deps.loadMeWallet();
        const active0 = deps.getActivePaths();
        const profile = String(active0.profile ?? '').trim() || 'default';
        const all = !!opts?.all;

        const p = resolveProfilePaths({
          cwd: process.cwd(),
          profile,
          walletOverride: null,
          stateOverride: null,
          logOverride: null,
          envWalletPath: process.env.BCH_STEALTH_WALLET ?? null,
        });

        const configFile = p.configFile;
        const stateFile = p.stateFile;

        let destStr = stripAnsi(String(destMaybe ?? '').trim());

        if (opts.toProfile) {
          const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);
          void cfg0;

          const target = String(opts.toProfile).trim();
          if (!target) throw new Error('send: --to-profile cannot be empty');

          const w = getWalletFromConfig({ configFile, profile: target });
          if (!w) throw new Error(`send: could not find wallet for --to-profile "${target}"`);

          const paycodeKey = (w as any).scanPrivBytes ?? (w as any).privBytes;
          destStr = generatePaycode(paycodeKey);
        }

        if (!destStr) throw new Error('send: missing <dest> (or provide --to-profile)');

        if (opts?.paycode === false && destStr.startsWith('PM')) {
          throw new Error('send: paycode destinations disabled by --no-paycode (provide a cashaddr)');
        }

        const chainIO = makeChainIO({ network: NETWORK, electrum: Electrum as any });

        const grindEnabled = opts.grind !== false;

        // Phase 2 default: 2048 (8-bit)
        const grindMaxUser = parseNonNegativeInt(opts.grindMax, '--grind-max') ?? 2048;
        const grindMax = grindEnabled ? grindMaxUser : 0;

        const grindPrefix16Override = parseOptionalHex16(opts.grindPrefix16);
        const grindPrefixByte = parseOptionalHexByte(opts.grindPrefix);

        const filename = path.resolve(stateFile);
        ensureDirForFile(filename);

        const store = new FileBackedPoolStateStore({ filename });
        const state = await loadStateOrEmpty({ store, networkDefault: String(NETWORK) });

        const defaultSelfPaycode = generatePaycode(((me as any).scanPrivBytes ?? (me as any).privBytes) as Uint8Array);
        const selfPaycodeOverride = String(opts.selfPaycode ?? '').trim();
        const selfPaycode = selfPaycodeOverride || defaultSelfPaycode;

        if (selfPaycode && !selfPaycode.startsWith('PM')) {
          throw new Error('send: --self-paycode must be a paycode starting with "PM"');
        }

        const ctx: any = {
          network: NETWORK,
          me,
          ownerTag: profile,
          dustSats: BigInt(DUST),
          state,
          chainIO,
          getUtxos: deps.getUtxos,
          selfPaycode,
        };

        ctx.me = ctx.me ?? {};
        ctx.me.selfPaycode = selfPaycode;

        if (String(process.env.BCH_STEALTH_DEBUG_SEND ?? '') === '1') {
          console.log(`[send:debug] command sees RUNSEND_BUILD_ID=${RUNSEND_BUILD_ID}`);
        }

        const res = await runSend(
          ctx,
          {
            dest: destStr,
            sats,
            dryRun: !!opts?.dryRun,
            grind: {
              enabled: grindMax > 0,
              maxAttempts: grindMax,
              prefixByteOverride: grindPrefixByte,
              prefixHex16Override: grindPrefix16Override,
            },
          } as any
        );

        if (!opts?.dryRun) {
          await saveState({ store, state: ctx.state, networkDefault: String(NETWORK) });
        }

        console.log(`network:     ${String(NETWORK)}`);
        console.log(`profile:     ${profile}`);
        console.log(`amountSats:  ${String(sats)}`);
        console.log(`destType:    ${res.destType}`);
        console.log(`dest:        ${res.destAddress}`);

        if (all) console.log(`destHash160: ${res.destHash160Hex}`);

        if (res.txid) {
          console.log(`txid:        ${res.txid}`);
          console.log(`tx:          ${getTxUrl(String(NETWORK), res.txid)}`);
        } else {
          console.log(`txid:        (dry-run)`);
        }

        if (all) {
          console.log(`rawHex:      ${res.rawHex}`);
          if (res.change) {
            console.log(
              `change:      vout=${res.change.vout} sats=${res.change.valueSats} h160=${res.change.hash160Hex} idx=${res.change.index}`
            );
          }
        }
        if (all && res?.grind) {
          console.log(`grind:       ${JSON.stringify(res.grind)}`);
        }
      }
    );
}