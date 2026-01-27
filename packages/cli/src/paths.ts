// packages/cli/src/paths.ts
import path from 'node:path';

export type ProfilePaths = {
  profile: string;
  profileDir: string;

  // canonical DB
  configFile: string;

  // optional file locations (overrides still supported)
  walletFile: string;
  stateFile: string;
  logFile: string;
};

export function sanitizeProfileName(name: string): string {
  const n = String(name ?? '').trim();
  if (!n) return 'default';

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

  // Canonical store is shared across profiles (kubeconfig-style)
  const configFile = path.resolve(cwd, '.bch-stealth', 'config.json');

  // Profile dir is still used for state/log defaults
  const baseDir = path.resolve(cwd, '.bch-stealth', 'profiles', prof);

  // walletFile stays for override/migration (NOT the canonical store)
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