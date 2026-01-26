// packages/cli/src/paths.ts
import path from 'node:path';

export type ProfilePaths = {
  profile: string;
  profileDir: string;

  // New: shared config for all profiles
  configFile: string;

  walletFile: string;
  stateFile: string;
  logFile: string;
};

export function sanitizeProfileName(name: string): string {
  const n = String(name ?? '').trim();
  if (!n) return 'default';

  // Keep it simple: file-system friendly, predictable.
  if (!/^[a-zA-Z0-9_-]+$/.test(n)) {
    throw new Error(`invalid --profile "${n}" (allowed: [a-zA-Z0-9_-])`);
  }
  return n;
}

export function resolveProfilePaths(args: {
  cwd: string;
  profile: string;

  walletOverride?: string | null;
  stateOverride?: string | null;
  logOverride?: string | null;

  // Optional: allow env-based wallet override while keeping profile defaults
  envWalletPath?: string | null;
}): ProfilePaths {
  const {
    cwd,
    profile,
    walletOverride,
    stateOverride,
    logOverride,
    envWalletPath,
  } = args;

  const prof = sanitizeProfileName(profile);

  const appDir = path.resolve(cwd, '.bch-stealth');
  const baseDir = path.resolve(appDir, 'profiles', prof);

  const configFile = path.resolve(appDir, 'config.json');

  const walletFile =
    (walletOverride && path.resolve(cwd, walletOverride)) ||
    (envWalletPath && path.resolve(cwd, envWalletPath)) ||
    path.resolve(baseDir, 'wallet.json');

  const stateFile =
    (stateOverride && path.resolve(cwd, stateOverride)) ||
    path.resolve(baseDir, 'state.json');

  const logFile =
    (logOverride && path.resolve(cwd, logOverride)) ||
    path.resolve(baseDir, 'events.ndjson');

  return {
    profile: prof,
    profileDir: baseDir,
    configFile,
    walletFile,
    stateFile,
    logFile,
  };
}