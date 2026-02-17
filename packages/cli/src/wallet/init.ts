// packages/cli/src/wallet/init.ts
import { bytesToHex, sha256, ensureEvenYPriv } from '@bch-stealth/utils';
import type { Command } from 'commander';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import type * as ElectrumNS from '@bch-stealth/electrum';

import { NETWORK } from '../config.js';
import { readConfig, writeConfig, ensureConfigDefaults, upsertProfile } from '../config_store.js';
import { getWalletFromConfig, generateMnemonicV1, walletJsonFromMnemonic } from '../wallets.js';
import { generatePaycode } from '../paycodes.js';
import { estimateBirthdayHeightFromAddress } from './birthday.js';
import { deriveSpendPriv32FromScanPriv32 } from '@bch-stealth/rpa-derive';

export type GetActivePaths = () => {
  configFile: string;
  profile: string;
  stateFile: string;
  logFile: string;
  walletFile: string;
};

function safePub33FromPriv32(priv32?: Uint8Array): Uint8Array | null {
  if (!(priv32 instanceof Uint8Array) || priv32.length !== 32) return null;
  return secp256k1.getPublicKey(priv32, true);
}

function printWalletInitSummary(args: {
  profile: string;
  configFile: string;
  stateFile: string;
  logFile: string;
  network: string;
  birthdayHeight: number;
  address: string;
  paycode: string;
  all?: boolean;

  basePub33?: Uint8Array;
  baseH160Hex?: string;

  scanPub33?: Uint8Array | null;
  spendPub33?: Uint8Array | null;

  note?: string | null;
}) {
  const {
    profile,
    configFile,
    stateFile,
    logFile,
    network,
    birthdayHeight,
    address,
    paycode,
    all,
    basePub33,
    baseH160Hex,
    scanPub33,
    spendPub33,
    note,
  } = args;

  console.log(`profile:        ${profile}`);
  console.log(`config file:    ${configFile}`);
  console.log(`state file:     ${stateFile}`);
  console.log(`log file:       ${logFile}`);
  console.log(`network:        ${network}`);
  console.log(`birthdayHeight: ${birthdayHeight}`);
  console.log(`address:        ${address}`);
  console.log(`paycode:        ${paycode}`);

  if (all) {
    if (basePub33) console.log(`base.pub33Hex:  ${bytesToHex(basePub33)}`);
    if (baseH160Hex) console.log(`base.hash160:   ${baseH160Hex}`);
    if (scanPub33) console.log(`scan.pub33Hex:  ${bytesToHex(scanPub33)}`);
    if (spendPub33) console.log(`spend.pub33Hex: ${bytesToHex(spendPub33)}`);
  } else {
    console.log(`\nℹ Tip: run "bchctl --profile ${profile} wallet show --all" to view pubkeys/hash160.\n`);
  }

  if (note) console.log(note);
}

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
    .option('--all', 'also print pubkeys/hash160 (hex identifiers)', false)
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
      const all = !!opts.all;

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
          (typeof (existingWallet as any).mnemonic === 'string' &&
            String((existingWallet as any).mnemonic).trim().length > 0) ||
          (typeof (existingWallet as any).scanPrivHex === 'string' &&
            typeof (existingWallet as any).spendPrivHex === 'string' &&
            typeof prof0?.birthdayHeight === 'number')
        );

      const walletNeedsHydration =
        !!existingWallet &&
        !walletLooksComplete &&
        typeof (existingWallet as any).privHex === 'string' &&
        String((existingWallet as any).privHex).trim().length > 0;

      if (existingWallet && force) {
        console.error(`warning: overwriting existing wallet in config: ${configFile} (profile=${profile})`);
      }

      // ------------------------------------------------------------
      // Case A: Existing complete wallet, refresh birthday metadata only
      // ------------------------------------------------------------
      if (existingWallet && walletLooksComplete && !force) {
        const hasBirthdayInConfig =
          typeof prof0?.birthdayHeight === 'number' && Number.isFinite(prof0.birthdayHeight);

        let finalBirthday: number;

        if (birthdayFlagProvided) {
          finalBirthday = birthdayHeight;
        } else if (!hasBirthdayInConfig || prof0.birthdayHeight === 0) {
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
          finalBirthday = prof0.birthdayHeight as number;
        }

        if (hasBirthdayInConfig && prof0.birthdayHeight === finalBirthday) {
          const me = getWalletFromConfig({ configFile, profile });
          if (!me) throw new Error(`[wallets] failed to load wallet from config (profile=${profile})`);

          const paycodeKey = (me as any).scanPrivBytes ?? me.privBytes;
          const paycode = generatePaycode(paycodeKey);
          const scanPub33 = safePub33FromPriv32(me.scanPrivBytes);
          const spendPriv32 =
            me.spendPrivBytes ?? (me.scanPrivBytes ? deriveSpendPriv32FromScanPriv32(me.scanPrivBytes) : undefined);
          const spendPub33 = safePub33FromPriv32(spendPriv32);

          printWalletInitSummary({
            profile,
            configFile,
            stateFile,
            logFile,
            network: String(prof0?.network ?? network),
            birthdayHeight: finalBirthday,
            address: me.address,
            paycode,
            all,
            basePub33: me.pubBytes,
            baseH160Hex: bytesToHex(me.hash160),
            scanPub33,
            spendPub33,
            note: `ℹ wallet already initialized; birthdayHeight unchanged`,
          });
          return;
        }

        const cfg1 = upsertProfile(cfg0, profile, {
          network: String(prof0?.network ?? network),
          birthdayHeight: finalBirthday,
          wallet: existingWallet,
        });

        cfg1.currentProfile = profile;
        writeConfig({ configFile, config: cfg1 });

        const me = getWalletFromConfig({ configFile, profile });
        if (!me) throw new Error(`[wallets] failed to load wallet from config after birthday refresh (profile=${profile})`);

        const paycodeKey = (me as any).scanPrivBytes ?? me.privBytes;
        const paycode = generatePaycode(paycodeKey);
        const scanPub33 = safePub33FromPriv32(me.scanPrivBytes);
        const spendPriv32 =
          me.spendPrivBytes ?? (me.scanPrivBytes ? deriveSpendPriv32FromScanPriv32(me.scanPrivBytes) : undefined);
        const spendPub33 = safePub33FromPriv32(spendPriv32);

        printWalletInitSummary({
          profile,
          configFile,
          stateFile,
          logFile,
          network: String(prof0?.network ?? network),
          birthdayHeight: finalBirthday,
          address: me.address,
          paycode,
          all,
          basePub33: me.pubBytes,
          baseH160Hex: bytesToHex(me.hash160),
          scanPub33,
          spendPub33,
          note: `\nℹ refreshed birthdayHeight (keys preserved)\n`,
        });
        return;
      }

      // ------------------------------------------------------------
      // Case B: Hydration mode (old wallet format)
      // ------------------------------------------------------------
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

        const paycodeKey = (me as any).scanPrivBytes ?? me.privBytes;
        const paycode = generatePaycode(paycodeKey);
        const scanPub33 = safePub33FromPriv32(me.scanPrivBytes);
        const spendPriv32 =
          me.spendPrivBytes ?? (me.scanPrivBytes ? deriveSpendPriv32FromScanPriv32(me.scanPrivBytes) : undefined);
        const spendPub33 = safePub33FromPriv32(spendPriv32);

        printWalletInitSummary({
          profile,
          configFile,
          stateFile,
          logFile,
          network,
          birthdayHeight: finalBirthday,
          address: me.address,
          paycode,
          all,
          basePub33: me.pubBytes,
          baseH160Hex: bytesToHex(me.hash160),
          scanPub33,
          spendPub33,
          note: `\nℹ hydrated existing wallet in config (no overwrite)\n`,
        });
        return;
      }

      // ------------------------------------------------------------
      // Case C: Create / overwrite mode
      // ------------------------------------------------------------
      if (existingWallet && !force && !walletNeedsHydration) {
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

      const paycodeKey = (me as any).scanPrivBytes ?? me.privBytes;
      const paycode = generatePaycode(paycodeKey);
      const scanPub33 = safePub33FromPriv32(me.scanPrivBytes);
      const spendPriv32 =
        me.spendPrivBytes ?? (me.scanPrivBytes ? deriveSpendPriv32FromScanPriv32(me.scanPrivBytes) : undefined);
      const spendPub33 = safePub33FromPriv32(spendPriv32);

      printWalletInitSummary({
        profile,
        configFile,
        stateFile,
        logFile,
        network,
        birthdayHeight: birthdayFlagProvided ? birthdayHeight : 0,
        address: me.address,
        paycode,
        all,
        basePub33: me.pubBytes,
        baseH160Hex: bytesToHex(me.hash160),
        scanPub33,
        spendPub33,
        note: `\n⚠️  save this mnemonic (unencrypted for now):\n${mnemonic}\n`,
      });
    });
}