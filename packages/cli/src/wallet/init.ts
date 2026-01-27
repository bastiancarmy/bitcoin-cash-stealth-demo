// packages/cli/src/wallet/init.ts
import { bytesToHex, sha256, ensureEvenYPriv } from '@bch-stealth/utils';
import type { Command } from 'commander';

import type * as ElectrumNS from '@bch-stealth/electrum';

import { NETWORK } from '../config.js';
import { readConfig, writeConfig, ensureConfigDefaults, upsertProfile } from '../config_store.js';
import {
  getWalletFromConfig,
  generateMnemonicV1,
  walletJsonFromMnemonic,
} from '../wallets.js';
import { generatePaycode } from '../paycodes.js';
import { estimateBirthdayHeightFromAddress } from './birthday.js';

export type GetActivePaths = () => {
  configFile: string;
  profile: string;
  stateFile: string;
  logFile: string;
  walletFile: string;
};

export function registerWalletInit(
  wallet: Command,
  deps: { getActivePaths: GetActivePaths; Electrum: typeof ElectrumNS }
) {
  const { getActivePaths, Electrum } = deps;

  wallet
    .command('init')
    .description('Create wallet material for the active profile (stored in .bch-stealth/config.json).')
    .option('--mnemonic <m>', 'provide a mnemonic (otherwise generate one)')
    .option('--birthday-height <h>', 'wallet birthday height for scanning (omit to auto-estimate if possible)')
    .option('--chipnet', 'set wallet network to chipnet', false)
    .option('--mainnet', 'set wallet network to mainnet', false)
    .option('--force', 'overwrite existing wallet in config', false)
    .action(async (opts) => {
      const { configFile, profile, stateFile, logFile } = getActivePaths();

      const wantChipnet = !!opts.chipnet;
      const wantMainnet = !!opts.mainnet;
      if (wantChipnet && wantMainnet) throw new Error('choose only one: --chipnet or --mainnet');

      const network =
        wantMainnet ? 'mainnet' :
        wantChipnet ? 'chipnet' :
        String(NETWORK ?? '').trim() || 'chipnet';

      const force = !!opts.force;

      // If flag provided, validate. If omitted, we can estimate later.
      const birthdayFlagProvided = opts.birthdayHeight != null && String(opts.birthdayHeight).trim() !== '';
      const birthdayHeight = birthdayFlagProvided ? Number(String(opts.birthdayHeight).trim()) : NaN;

      if (birthdayFlagProvided) {
        if (!Number.isFinite(birthdayHeight) || birthdayHeight < 0 || !Number.isInteger(birthdayHeight)) {
          throw new Error(`invalid --birthday-height: ${String(opts.birthdayHeight)} (expected non-negative integer)`);
        }
      }

      const cfg0 = ensureConfigDefaults(readConfig({ configFile }) ?? null);

      const prof0 = cfg0.profiles?.[profile] ?? null;
      const existingWallet = prof0?.wallet ?? null;

      const walletLooksComplete =
        !!existingWallet &&
        (
          // mnemonic implies initialized
          (typeof (existingWallet as any).mnemonic === 'string' &&
            String((existingWallet as any).mnemonic).trim().length > 0) ||
          // or scan/spend + birthday implies initialized
          (typeof (existingWallet as any).scanPrivHex === 'string' &&
            typeof (existingWallet as any).spendPrivHex === 'string' &&
            typeof prof0?.birthdayHeight === 'number')
        );

      const walletNeedsHydration =
        !!existingWallet &&
        !walletLooksComplete &&
        typeof (existingWallet as any).privHex === 'string' &&
        String((existingWallet as any).privHex).trim().length > 0;

      // If user is forcing, warn (we may overwrite keys in create/overwrite mode).
      if (existingWallet && force) {
        console.error(`warning: overwriting existing wallet in config: ${configFile} (profile=${profile})`);
      }

      // -------------------------
      // Existing wallet (complete): refresh birthdayHeight (metadata-only) without changing keys
      // -------------------------
      if (existingWallet && walletLooksComplete && !force) {
        const hasBirthdayInConfig =
          typeof prof0?.birthdayHeight === 'number' && Number.isFinite(prof0.birthdayHeight);

        let finalBirthday: number;

        if (birthdayFlagProvided) {
          finalBirthday = birthdayHeight;
        } else if (!hasBirthdayInConfig || prof0.birthdayHeight === 0) {
          // Auto-estimate if missing/0 and user didn't provide a birthday
          try {
            const me0 = getWalletFromConfig({ configFile, profile });
            const addr = me0?.address;
            finalBirthday = addr
              ? await estimateBirthdayHeightFromAddress({
                  Electrum,
                  address: addr,
                  network,
                  safetyMargin: 12,
                })
              : 0;
          } catch {
            finalBirthday = 0;
          }
        } else {
          // Nothing to do; keep existing birthday
          finalBirthday = prof0.birthdayHeight as number;
        }

        // If nothing changed, be explicit and exit cleanly
        if (hasBirthdayInConfig && prof0.birthdayHeight === finalBirthday) {
          console.log(`profile:         ${profile}`);
          console.log(`config file:     ${configFile}`);
          console.log(`network:         ${String(prof0?.network ?? network)}`);
          console.log(`birthdayHeight:  ${finalBirthday}`);
          console.log(`ℹ wallet already initialized; birthdayHeight unchanged`);
          return;
        }

        const cfg1 = upsertProfile(cfg0, profile, {
          // keep whatever network is already in config if present, otherwise use resolved network
          network: String(prof0?.network ?? network),
          birthdayHeight: finalBirthday,
          wallet: existingWallet, // IMPORTANT: preserve keys
        });

        cfg1.currentProfile = profile;
        writeConfig({ configFile, config: cfg1 });

        const me = getWalletFromConfig({ configFile, profile });
        if (!me) throw new Error(`[wallets] failed to load wallet from config after birthday refresh (profile=${profile})`);

        const paycode = generatePaycode(me.privBytes);

        console.log(`profile:         ${profile}`);
        console.log(`config file:     ${configFile}`);
        console.log(`state file:      ${stateFile}`);
        console.log(`log file:        ${logFile}`);
        console.log(`network:         ${String(prof0?.network ?? network)}`);
        console.log(`birthdayHeight:  ${finalBirthday}`);
        console.log(`base (P2PKH):    ${me.address}`);
        console.log(`paycode:         ${paycode}`);
        console.log(`pubkey33:        ${bytesToHex(me.pubBytes)}`);

        console.log(`\nℹ refreshed birthdayHeight (keys preserved)\n`);
        return;
      }

      // -------------------------
      // Hydration mode (wallet exists but missing scan/spend/birthday, etc.)
      // -------------------------
      if (walletNeedsHydration && !force) {
        const privHex = String((existingWallet as any).privHex).trim();

        const deriveTaggedPrivHex = (tag: string, basePrivHex: string) => {
          const enc = new TextEncoder().encode(`bchctl-wallet-seed-v1|${tag}|${basePrivHex.toLowerCase()}`);
          const h = sha256(enc);
          return bytesToHex(ensureEvenYPriv(h));
        };

        const scanPrivHex =
          (typeof (existingWallet as any).scanPrivHex === 'string' && String((existingWallet as any).scanPrivHex).trim()) ||
          deriveTaggedPrivHex('scan', privHex);

        const spendPrivHex =
          (typeof (existingWallet as any).spendPrivHex === 'string' && String((existingWallet as any).spendPrivHex).trim()) ||
          deriveTaggedPrivHex('spend', privHex);

        let finalBirthday: number;

        if (birthdayFlagProvided) {
          finalBirthday = birthdayHeight;
        } else if (typeof prof0?.birthdayHeight === 'number' && Number.isFinite(prof0.birthdayHeight)) {
          finalBirthday = prof0.birthdayHeight;
        } else {
          // estimate from address history (best effort)
          try {
            const me0 = getWalletFromConfig({ configFile, profile });
            const addr = me0?.address;
            finalBirthday = addr
              ? await estimateBirthdayHeightFromAddress({
                  Electrum,
                  address: addr,
                  network,
                  safetyMargin: 12,
                })
              : 0;
          } catch {
            finalBirthday = 0;
          }
        }

        const cfg1 = upsertProfile(cfg0, profile, {
          network,
          birthdayHeight: finalBirthday,
          wallet: { ...(existingWallet as any), privHex, scanPrivHex, spendPrivHex },
        });

        cfg1.currentProfile = profile;
        writeConfig({ configFile, config: cfg1 });

        const me = getWalletFromConfig({ configFile, profile });
        if (!me) throw new Error(`[wallets] failed to load wallet from config after hydrate (profile=${profile})`);

        const paycode = generatePaycode(me.privBytes);

        console.log(`profile:         ${profile}`);
        console.log(`config file:     ${configFile}`);
        console.log(`state file:      ${stateFile}`);
        console.log(`log file:        ${logFile}`);
        console.log(`network:         ${network}`);
        console.log(`birthdayHeight:  ${finalBirthday}`);
        console.log(`base (P2PKH):    ${me.address}`);
        console.log(`paycode:         ${paycode}`);
        console.log(`pubkey33:        ${bytesToHex(me.pubBytes)}`);
        console.log(`\nℹ hydrated existing wallet in config (no overwrite)\n`);
        return;
      }

      // -------------------------
      // Create / overwrite mode
      // -------------------------
      if (existingWallet && !force && !walletNeedsHydration) {
        // This is the only remaining path where a wallet exists but:
        // - it's NOT complete (walletLooksComplete=false)
        // - and it does NOT qualify for hydration (walletNeedsHydration=false)
        // Safer to stop than overwrite unexpectedly.
        throw new Error(
          `[wallets] wallet exists but is not in a recognized format: ${configFile} (profile=${profile})\n` +
            `Re-run with --force to overwrite.`
        );
      }

      const mnemonicRaw = typeof opts.mnemonic === 'string' ? String(opts.mnemonic).trim() : '';
      const mnemonic = mnemonicRaw || generateMnemonicV1(12);

      const walletJson = walletJsonFromMnemonic({
        mnemonic,
        network,
        birthdayHeight: birthdayFlagProvided ? birthdayHeight : 0,
      });

      const cfg1 = upsertProfile(cfg0, profile, {
        network,
        birthdayHeight: birthdayFlagProvided ? birthdayHeight : 0,
        wallet: {
          kind: 'mnemonic',
          mnemonic,
          privHex: String(walletJson.privHex),
          scanPrivHex: String(walletJson.scanPrivHex),
          spendPrivHex: String(walletJson.spendPrivHex),
        },
      });

      cfg1.currentProfile = profile;
      writeConfig({ configFile, config: cfg1 });

      const me = getWalletFromConfig({ configFile, profile });
      if (!me) throw new Error(`[wallets] failed to load wallet from config after write (profile=${profile})`);

      const paycode = generatePaycode(me.privBytes);

      console.log(`profile:         ${profile}`);
      console.log(`config file:     ${configFile}`);
      console.log(`state file:      ${stateFile}`);
      console.log(`log file:        ${logFile}`);
      console.log(`network:         ${network}`);
      console.log(`birthdayHeight:  ${birthdayFlagProvided ? birthdayHeight : 0}`);
      console.log(`base (P2PKH):    ${me.address}`);
      console.log(`paycode:         ${paycode}`);
      console.log(`pubkey33:        ${bytesToHex(me.pubBytes)}`);

      console.log(`\n⚠️  save this mnemonic (unencrypted for now):\n${mnemonic}\n`);
    });
}