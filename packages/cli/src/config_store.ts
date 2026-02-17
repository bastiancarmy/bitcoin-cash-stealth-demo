// packages/cli/src/config_store.ts
import fs from 'node:fs';
import path from 'node:path';

export type ProfileWalletMaterial = {
  // keep flexible: normalizeWallet already handles many aliases
  mnemonic?: string;
  privHex?: string;
  scanPrivHex?: string;
  spendPrivHex?: string;

  // optional metadata for future migrations
  kind?: 'mnemonic' | 'imported';
  importedFrom?: { type: 'wif' | 'privhex' | 'mnemonic'; at: string };
};

export type ProfileConfigV1 = {
  network?: string;
  birthdayHeight?: number;
  wallet?: ProfileWalletMaterial;

  // optional (don’t rely on it for correctness; paths.ts owns defaults)
  paths?: {
    stateFile?: string;
    logFile?: string;
  };
};

export type BchctlConfigV1 = {
  version: 1;
  createdAt: string;
  currentProfile: string;
  profiles: Record<string, ProfileConfigV1>;
};

function ensureParentDir(filename: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
}

export function ensureConfigDefaults(partial?: Partial<BchctlConfigV1> | null): BchctlConfigV1 {
  const now = new Date().toISOString();
  const base: BchctlConfigV1 = {
    version: 1,
    createdAt: now,
    currentProfile: 'default',
    profiles: {},
  };

  const p = (partial ?? {}) as any;

  return {
    ...base,
    ...p,
    version: 1,
    createdAt: typeof p.createdAt === 'string' && p.createdAt ? p.createdAt : base.createdAt,
    currentProfile: typeof p.currentProfile === 'string' && p.currentProfile ? p.currentProfile : base.currentProfile,
    profiles: typeof p.profiles === 'object' && p.profiles ? p.profiles : base.profiles,
  };
}

export function readConfig(args: { configFile: string }): BchctlConfigV1 | null {
  const { configFile } = args;
  if (!fs.existsSync(configFile)) return null;

  const raw = fs.readFileSync(configFile, 'utf8');
  const parsed = JSON.parse(raw);
  return ensureConfigDefaults(parsed);
}

export function writeConfig(args: { configFile: string; config: BchctlConfigV1 }): void {
  const { configFile, config } = args;
  ensureParentDir(configFile);
  const normalized = ensureConfigDefaults(config);
  fs.writeFileSync(configFile, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
}

export function upsertProfile(
  config: BchctlConfigV1,
  profile: string,
  patch: Partial<ProfileConfigV1>
): BchctlConfigV1 {
  const c = ensureConfigDefaults(config);
  const prev = c.profiles?.[profile] ?? {};
  return {
    ...c,
    profiles: {
      ...c.profiles,
      [profile]: { ...prev, ...patch },
    },
  };
}