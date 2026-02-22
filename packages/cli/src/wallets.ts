// packages/cli/src/wallets.ts
import fs from 'node:fs';
import path from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import {
  hash160,
  hexToBytes,
  encodeCashAddr,
  ensureEvenYPriv,
  bytesToHex,
  sha256,
} from '@bch-stealth/utils';
import { NETWORK } from './config.js';
import { readConfig } from './config_store.js';

export type LoadedWallet = {
  address: string;
  privBytes: Uint8Array;
  pubBytes: Uint8Array;
  hash160: Uint8Array;
  scanPrivBytes?: Uint8Array;
  spendPrivBytes?: Uint8Array;

  // ✅ carry scan metadata so scan.ts can default correctly
  network?: string;
  birthdayHeight?: number;
};

export type WalletFileV1 = {
  version: 1;
  createdAt: string;

  // wallet material (unencrypted for now)
  mnemonic: string;

  // keys (hex)
  privHex: string;
  scanPrivHex: string;
  spendPrivHex: string;

  // scanning metadata
  network: string;
  birthdayHeight: number;
};

// A small, file-local word list (NOT BIP39; ok for demo/dev).
// If we ever add BIP39, this can be swapped without changing CLI UX.
const MNEMONIC_WORDS_V1: string[] = [
  'absorb','access','acid','acoustic','across','adapt','adjust','admit','adult','aerobic','affair','afford','afraid','again','agent','agree',
  'ahead','aim','air','alarm','album','alert','alien','alive','alpha','always','amateur','amazing','amount','amused','anchor','ancient',
  'angle','animal','answer','any','apart','april','arch','area','argue','arm','army','around','arrive','art','artist','ask','asset',
  'atom','attack','attend','august','auto','avoid','awake','award','axis','baby','bacon','badge','bag','balance','balcony','ball',
  'banana','banner','bar','barely','bargain','base','basic','basket','bath','battery','beach','beam','beauty','because','become','before',
  'begin','behave','behind','believe','below','benefit','best','better','between','beyond','bicycle','bid','binary','biology','bird','birth',
  'bitter','black','blade','blanket','blast','blend','bless','blind','block','blue','board','bonus','book','boost','border','borrow',
  'boss','bottom','bounce','box','brain','brand','brave','bread','breeze','brick','bridge','brief','bright','bring','broad','broken','buddy',
  'build','bullet','bundle','burn','bus','business','busy','butter','button','buyer','cable','cactus','camera','camp','canal','cancel',
  'candy','canvas','capital','captain','carbon','card','cargo','carpet','carry','cart','case','castle','casual','catch','cause','ceiling',
  'cell','center','certain','chair','chalk','champion','change','chaos','chapter','charge','chase','cheap','check','cheese','chef','cherry',
  'chess','chest','chief','choice','choose','circle','citizen','city','civil','claim','clap','clarify','class','clean','clerk','clever',
  'click','client','cliff','climb','clinic','clock','close','cloth','cloud','clown','club','clump','coach','coast','coffee','coin',
  'collect','color','column','combine','comfort','comic','common','company','concert','conduct','confirm','connect','control','convince','cook',
  'cool','copy','corner','cost','cotton','couch','country','cradle','craft','crane','crash','crazy','credit','creek','crew','crisp',
  'critic','crop','cross','crowd','crucial','crystal','cube','culture','cup','curious','current','custom','cycle','damage','dance','danger',
  'daring','data','dawn','day','deal','debate','debris','decide','deep','defense','define','degree','delay','delta','demand','deny',
  'depend','deposit','depth','derive','design','desk','detail','device','differ','dinner','direct','dirt','discover','disease','display','distance',
];

function randomInt(maxExclusive: number): number {
  // crypto-free fallback: Math.random is acceptable for demo mnemonic generation.
  // Keys are still derived via sha256 of the mnemonic (deterministic).
  return Math.floor(Math.random() * maxExclusive);
}

export function generateMnemonicV1(wordCount = 12): string {
  const n = Number(wordCount);
  if (!Number.isFinite(n) || n < 8 || n > 24) {
    throw new Error(`[wallets] invalid mnemonic wordCount=${String(wordCount)} (expected 8..24)`);
  }
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    words.push(MNEMONIC_WORDS_V1[randomInt(MNEMONIC_WORDS_V1.length)]);
  }
  return words.join(' ');
}

function normalizeMnemonic(m: string): string {
  const s = String(m ?? '').trim().replace(/\s+/g, ' ');
  if (!s) throw new Error('[wallets] mnemonic is empty');
  const words = s.split(' ');
  if (words.length < 8) throw new Error('[wallets] mnemonic must have at least 8 words');
  return words.join(' ');
}

function derivePrivFromMnemonic(tag: string, mnemonic: string): Uint8Array {
  const enc = new TextEncoder().encode(`bchctl-wallet-v1|${tag}|${mnemonic}`);
  // sha256 returns 32 bytes
  const h = sha256(enc);
  return ensureEvenYPriv(h);
}

export function walletJsonFromMnemonic(args: {
  mnemonic: string;
  network: string;
  birthdayHeight: number;
}): WalletFileV1 {
  const mnemonic = normalizeMnemonic(args.mnemonic);
  const network = String(args.network ?? '').trim() || String(NETWORK ?? '').trim() || 'chipnet';

  const birthdayHeight = Number(args.birthdayHeight ?? 0);
  if (!Number.isFinite(birthdayHeight) || birthdayHeight < 0 || !Number.isInteger(birthdayHeight)) {
    throw new Error(`[wallets] birthdayHeight must be a non-negative integer (got ${String(args.birthdayHeight)})`);
  }

  const privBytes = derivePrivFromMnemonic('base', mnemonic);
  const scanPrivBytes = derivePrivFromMnemonic('scan', mnemonic);
  const spendPrivBytes = derivePrivFromMnemonic('spend', mnemonic);

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    mnemonic,
    privHex: bytesToHex(privBytes),
    scanPrivHex: bytesToHex(scanPrivBytes),
    spendPrivHex: bytesToHex(spendPrivBytes),
    network,
    birthdayHeight,
  };
}

function readJson(file: string): any {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function toPrivBytes(x: any, label: string): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') {
    const s = x.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]+$/.test(s) || s.length !== 64) {
      throw new Error(`[wallets] ${label} must be 32-byte hex`);
    }
    return hexToBytes(s);
  }
  throw new Error(`[wallets] ${label} must be Uint8Array or 32-byte hex`);
}

function cashaddrPrefixFromNetwork(networkMaybe?: string): 'bitcoincash' | 'bchtest' {
  const n = String(networkMaybe ?? NETWORK ?? '').toLowerCase();
  // chipnet/testnet/regtest all use bchtest prefix in most tooling
  return n === 'mainnet' ? 'bitcoincash' : 'bchtest';
}

function deriveAddressFromH160(h160: Uint8Array, networkMaybe?: string): string {
  return encodeCashAddr(cashaddrPrefixFromNetwork(networkMaybe), 'P2PKH', h160);
}

function normalizeWallet(raw: any, label: string, meta?: { network?: string; birthdayHeight?: number }): LoadedWallet {
  if (raw == null) throw new Error(`[wallets] missing wallet: ${label}`);

  // allow shorthand: "<privhex>"
  const obj = typeof raw === 'string' ? { privHex: raw } : raw;

  const priv =
    obj.privBytes ??
    obj.priv ??
    obj.privKey ??
    obj.privateKeyHex ??
    obj.privHex ??
    obj.signPrivHex ??
    obj.signPrivBytes;

  // parity with original working version
  let privBytes = toPrivBytes(priv, `${label}.priv`);
  privBytes = ensureEvenYPriv(privBytes);

  const pubBytes =
    obj.pubBytes instanceof Uint8Array
      ? obj.pubBytes
      : typeof obj.pubHex === 'string'
        ? hexToBytes(String(obj.pubHex).replace(/^0x/, ''))
        : secp256k1.getPublicKey(privBytes, true);

  const h160 = obj.hash160 instanceof Uint8Array ? obj.hash160 : hash160(pubBytes);

  // network + birthdayHeight (wallet.json may contain these; config attaches them too)
  const network = String(obj.network ?? meta?.network ?? '').trim() || undefined;
  const birthdayHeightRaw = obj.birthdayHeight ?? meta?.birthdayHeight;
  const birthdayHeight =
    Number.isInteger(Number(birthdayHeightRaw)) && Number(birthdayHeightRaw) >= 0
      ? Number(birthdayHeightRaw)
      : undefined;

  // address optional; derive if missing
  const addressRaw = String(obj.address ?? obj.cashaddr ?? obj.cashAddress ?? '').trim();
  const address = addressRaw || deriveAddressFromH160(h160, network);

  const scanPrivBytes = obj.scanPrivHex
    ? ensureEvenYPriv(toPrivBytes(obj.scanPrivHex, `${label}.scanPrivHex`))
    : undefined;

  const spendPrivBytes = obj.spendPrivHex
    ? ensureEvenYPriv(toPrivBytes(obj.spendPrivHex, `${label}.spendPrivHex`))
    : undefined;

  return { address, privBytes, pubBytes, hash160: h160, scanPrivBytes, spendPrivBytes, network, birthdayHeight };
}

export function resolveDefaultWalletPath(): string {
  const env = String(process.env.BCH_STEALTH_WALLET ?? '').trim();
  if (env) return path.resolve(env);

  const single = path.resolve(process.cwd(), 'wallet.json');
  if (fs.existsSync(single)) return single;

  throw new Error(
    `[wallets] wallet.json not found in ${process.cwd()}\n` +
      `Create one with: bchctl wallet init`
  );
}

export function getWalletFromConfig(args: { configFile: string; profile: string }): LoadedWallet | null {
  const { configFile, profile } = args;

  const cfg = readConfig({ configFile });
  if (!cfg) return null;

  const prof = String(profile ?? '').trim() || String(cfg.currentProfile ?? '').trim() || 'default';

  const entry = cfg.profiles?.[prof] ?? null;
  if (!entry) return null;

  // Canonical: embedded wallet object
  const rawWallet = entry.wallet ?? null;
  if (!rawWallet) return null;

  // Attach profile-level scanning metadata
  const meta = {
    network: String(entry.network ?? NETWORK ?? '').trim() || undefined,
    birthdayHeight:
      Number.isInteger(Number(entry.birthdayHeight)) && Number(entry.birthdayHeight) >= 0
        ? Number(entry.birthdayHeight)
        : undefined,
  };

  return normalizeWallet(rawWallet, `config.profiles.${prof}.wallet`, meta);
}

export async function getWallet(opts?: { walletFile?: string }): Promise<LoadedWallet> {
  const walletFile = path.resolve(opts?.walletFile ?? resolveDefaultWalletPath());
  const j = readJson(walletFile);

  // wallet.json (WalletFileV1) contains network + birthdayHeight; keep them
  return normalizeWallet(j, 'wallet');
}