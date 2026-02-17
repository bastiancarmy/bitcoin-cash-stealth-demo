// packages/cli/src/paths.ts
import path from 'node:path';
import fs from 'node:fs';

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

/**
 * Find the nearest directory at-or-above `startCwd` containing `.bch-stealth/config.json`.
 * If not found, fall back to `startCwd`.
 */
export function findConfigRoot(startCwd: string): string {
  let dir = path.resolve(startCwd);

  while (true) {
    const candidate = path.join(dir, '.bch-stealth', 'config.json');
    if (fs.existsSync(candidate)) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return path.resolve(startCwd);
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

  // Canonical store root: find-up from cwd
  const root = findConfigRoot(cwd);

  // Canonical store is shared across profiles (kubeconfig-style)
  const configFile = path.resolve(root, '.bch-stealth', 'config.json');

  // Profile dir is still used for state/log defaults
  const baseDir = path.resolve(root, '.bch-stealth', 'profiles', prof);

  // walletFile stays for override/migration (NOT the canonical store)
  const walletFile =
    (walletOverride && path.resolve(root, walletOverride)) ||
    (envWalletPath && path.resolve(root, envWalletPath)) ||
    path.resolve(baseDir, 'wallet.json');

  const stateFile =
    (stateOverride && path.resolve(root, stateOverride)) ||
    path.resolve(baseDir, 'state.json');

  const logFile =
    (logOverride && path.resolve(root, logOverride)) ||
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