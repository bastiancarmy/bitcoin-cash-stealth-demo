// packages/gui/electron/main.ts
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

type ConfigJsonV1 = {
  version: 1;
  createdAt: string;
  currentProfile: string;
  profiles: Record<string, any>;
};

type BchctlChunk = { opId: string; stream: 'stdout' | 'stderr'; chunk: string };

let mainWindow: BrowserWindow | null = null;

function isDev(): boolean {
  return !app.isPackaged;
}

// Emojis allowed only in console logs.
function log(...args: any[]) {
  // eslint-disable-next-line no-console
  console.log('🧪', ...args);
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function mkdirp(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeTextAtomic(p: string, content: string) {
  const dir = path.dirname(p);
  mkdirp(dir);
  const tmp = `${p}.tmp.${randomUUID()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
}

function hasRepoMarker(dir: string): boolean {
  return exists(path.join(dir, 'package.json')) && exists(path.join(dir, 'packages'));
}

function walkUpFindRepoRoot(startDir: string): string | null {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 30; i++) {
    if (hasRepoMarker(cur)) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function guessRepoRoot(): string {
  return (
    walkUpFindRepoRoot(process.cwd()) ??
    walkUpFindRepoRoot(__dirname) ??
    walkUpFindRepoRoot(app.getAppPath()) ??
    process.cwd()
  );
}

function resolveCliDistEntry(repoRoot: string): string {
  return path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
}

/**
 * Storage root policy:
 * - Dev: repo root (so GUI uses <repo>/.bch-stealth/* by default)
 * - Packaged: userData/bch-stealth (app-owned state)
 *
 * Note: BCH_STEALTH_HOME is the "parent" dir that contains ".bch-stealth/".
 */
function getStorageRoot(): string {
  if (isDev()) return guessRepoRoot();
  return path.join(app.getPath('userData'), 'bch-stealth');
}

function getDotDir(storageRoot: string): string {
  return path.join(storageRoot, '.bch-stealth');
}

function getConfigPath(storageRoot: string): string {
  return path.join(getDotDir(storageRoot), 'config.json');
}

function getProfilesRoot(storageRoot: string): string {
  return path.join(getDotDir(storageRoot), 'profiles');
}

function listProfileDirs(storageRoot: string): string[] {
  const profilesDir = getProfilesRoot(storageRoot);
  if (!exists(profilesDir)) return [];
  const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

function parseLaunchProfileArg(argv: string[]): string | null {
  const idx = argv.findIndex((a) => a === '--profile');
  if (idx >= 0 && typeof argv[idx + 1] === 'string' && argv[idx + 1].trim()) {
    return argv[idx + 1].trim();
  }
  return null;
}

function ensureProfileInConfig(cfg: ConfigJsonV1, profile: string) {
  cfg.profiles[profile] = cfg.profiles[profile] ?? { network: 'chipnet' };
}

function loadOrInitConfig(storageRoot: string): ConfigJsonV1 {
  const configPath = getConfigPath(storageRoot);
  const raw = readText(configPath);

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.version === 1 &&
        typeof parsed.currentProfile === 'string' &&
        parsed.profiles &&
        typeof parsed.profiles === 'object'
      ) {
        return parsed as ConfigJsonV1;
      }
    } catch {
      // fallthrough to init
    }
  }

  // Seed from any existing profile dirs (dev case: repo already has .bch-stealth/profiles/*)
  const seededProfiles: Record<string, any> = {};
  for (const p of listProfileDirs(storageRoot)) {
    seededProfiles[p] = seededProfiles[p] ?? { network: 'chipnet' };
  }
  const first = Object.keys(seededProfiles).sort()[0] ?? 'default';

  const fresh: ConfigJsonV1 = {
    version: 1,
    createdAt: new Date().toISOString(),
    currentProfile: first,
    profiles: seededProfiles,
  };

  writeTextAtomic(configPath, JSON.stringify(fresh, null, 2) + '\n');
  return fresh;
}

function saveConfig(storageRoot: string, cfg: ConfigJsonV1) {
  writeTextAtomic(getConfigPath(storageRoot), JSON.stringify(cfg, null, 2) + '\n');
}

/**
 * Reconcile config <-> filesystem WITHOUT creating state.json.
 * - ensure each config profile has a directory
 * - ensure each directory has a config placeholder entry
 * - ensure currentProfile is valid
 */
function reconcileProfiles(storageRoot: string, cfg: ConfigJsonV1): { changed: boolean } {
  let changed = false;

  const profilesRoot = getProfilesRoot(storageRoot);
  mkdirp(profilesRoot);

  // Ensure dirs exist for config entries
  const cfgNames = Object.keys(cfg.profiles ?? {});
  for (const name of cfgNames) {
    const dir = path.join(profilesRoot, name);
    if (!exists(dir)) mkdirp(dir);
  }

  // Ensure config entries exist for dirs
  const dirNames = listProfileDirs(storageRoot);
  for (const name of dirNames) {
    if (!cfg.profiles?.[name]) {
      ensureProfileInConfig(cfg, name);
      changed = true;
    }
  }

  // Ensure currentProfile points somewhere real
  const cur = String(cfg.currentProfile ?? '').trim();
  const haveCur = cur && (cfg.profiles?.[cur] || dirNames.includes(cur));
  if (!haveCur) {
    const next = dirNames[0] ?? cfgNames.sort()[0] ?? 'default';
    cfg.currentProfile = next;
    ensureProfileInConfig(cfg, next);
    changed = true;
  }

  return { changed };
}

function resolveActiveProfile(storageRoot: string): { launchProfile: string | null; activeProfile: string } {
  const launchProfile = parseLaunchProfileArg(process.argv) ?? null;

  const cfg = loadOrInitConfig(storageRoot);
  const { changed } = reconcileProfiles(storageRoot, cfg);
  if (changed) saveConfig(storageRoot, cfg);

  if (launchProfile) {
    ensureProfileInConfig(cfg, launchProfile);
    cfg.currentProfile = launchProfile;
    mkdirp(path.join(getProfilesRoot(storageRoot), launchProfile));
    saveConfig(storageRoot, cfg);
    return { launchProfile, activeProfile: launchProfile };
  }

  const activeProfile = String(cfg.currentProfile ?? '').trim() || 'default';
  return { launchProfile: null, activeProfile };
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: '#050505',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev()) {
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173/';
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sendChunk(msg: BchctlChunk) {
  if (!mainWindow) return;
  mainWindow.webContents.send('bchctl:chunk', msg);
}

function sendExit(msg: { opId: string; code: number }) {
  if (!mainWindow) return;
  mainWindow.webContents.send('bchctl:exit', msg);
}

type RunningOp = {
  opId: string;
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
  code: number | null;
};

const running: Record<string, RunningOp> = {};

function bootstrap() {
  app.on('ready', () => {
    const storageRoot = getStorageRoot();
    mkdirp(storageRoot);
    mkdirp(getDotDir(storageRoot));

    const cfg = loadOrInitConfig(storageRoot);
    const { changed } = reconcileProfiles(storageRoot, cfg);
    if (changed) saveConfig(storageRoot, cfg);

    createMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

bootstrap();

// ---------------- IPC ----------------

ipcMain.handle('appInfo', async () => {
  const repoRoot = guessRepoRoot();
  const cliDist = resolveCliDistEntry(repoRoot);

  const storageRoot = getStorageRoot();
  const dotDir = getDotDir(storageRoot);

  const { launchProfile, activeProfile } = resolveActiveProfile(storageRoot);

  return {
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,

    repoRoot,
    cliDist,

    userDataDir: app.getPath('userData'),
    storageRoot,
    dotDir,

    launchProfile,
    activeProfile,
  };
});

ipcMain.handle('openPath', async (_evt, absPath: string) => {
  try {
    const res = await shell.openPath(absPath);
    if (res) return { ok: false, error: res };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle('getConfig', async () => {
  const storageRoot = getStorageRoot();
  const cfg = loadOrInitConfig(storageRoot);
  const { changed } = reconcileProfiles(storageRoot, cfg);
  if (changed) saveConfig(storageRoot, cfg);
  return { ok: true, config: cfg, path: getConfigPath(storageRoot) };
});

ipcMain.handle('setCurrentProfile', async (_evt, args: { profile: string }) => {
  const storageRoot = getStorageRoot();
  const prof = String(args?.profile ?? '').trim();
  if (!prof) return { ok: false, error: 'profile is required' };

  const cfg = loadOrInitConfig(storageRoot);
  reconcileProfiles(storageRoot, cfg);

  ensureProfileInConfig(cfg, prof);
  cfg.currentProfile = prof;

  mkdirp(path.join(getProfilesRoot(storageRoot), prof));
  saveConfig(storageRoot, cfg);

  return { ok: true };
});

/**
 * List profiles from directories (source of truth for dropdown).
 * Also ensures config has placeholder entries for any directories.
 */
ipcMain.handle('listProfiles', async () => {
  const storageRoot = getStorageRoot();
  const cfg = loadOrInitConfig(storageRoot);
  const { changed } = reconcileProfiles(storageRoot, cfg);
  if (changed) saveConfig(storageRoot, cfg);
  return listProfileDirs(storageRoot);
});

ipcMain.handle(
  'runBchctl',
  async (_evt, args: { profile: string; argv: string[]; env?: Record<string, string> }) => {
    const repoRoot = guessRepoRoot();
    const cliEntry = resolveCliDistEntry(repoRoot);

    if (!exists(cliEntry)) {
      throw new Error(`CLI dist not found at: ${cliEntry}\nRun: yarn workspace @bch-stealth/cli build`);
    }

    const storageRoot = getStorageRoot();
    mkdirp(storageRoot);
    mkdirp(getDotDir(storageRoot));

    const opId = randomUUID();

    const profile = String(args.profile ?? '').trim() || 'default';
    const fullArgv = [cliEntry, '--profile', profile, ...(args.argv ?? [])];

    log('spawn', process.execPath, ...fullArgv, '(ELECTRON_RUN_AS_NODE=1)', '(BCH_STEALTH_HOME)', storageRoot);

    const child = spawn(process.execPath, fullArgv, {
      // Ensure deterministic home behavior even if CLI uses cwd
      cwd: storageRoot,
      env: {
        ...process.env,
        ...(args.env ?? {}),
        ELECTRON_RUN_AS_NODE: '1',
        BCH_STEALTH_HOME: storageRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const op: RunningOp = { opId, child, stdout: '', stderr: '', code: null };
    running[opId] = op;

    child.stdout?.on('data', (b) => {
      const chunk = String(b ?? '');
      op.stdout += chunk;
      sendChunk({ opId, stream: 'stdout', chunk });
    });

    child.stderr?.on('data', (b) => {
      const chunk = String(b ?? '');
      op.stderr += chunk;
      sendChunk({ opId, stream: 'stderr', chunk });
    });

    child.on('close', (code) => {
      op.code = typeof code === 'number' ? code : 0;
      sendExit({ opId, code: op.code });
    });

    return { opId };
  }
);

ipcMain.handle('getBchctlResult', async (_evt, args: { opId: string }) => {
  const opId = String(args?.opId ?? '').trim();
  const op = running[opId];
  if (!op) return { ok: false, error: `op not found: ${opId}` };

  if (op.code === null) {
    return { ok: false, error: 'still running' };
  }

  const res = { ok: true, stdout: op.stdout, stderr: op.stderr, code: op.code };
  delete running[opId];
  return res;
});

ipcMain.handle('killBchctl', async (_evt, args: { opId: string }) => {
  const opId = String(args?.opId ?? '').trim();
  const op = running[opId];
  if (!op) return { ok: false, error: `op not found: ${opId}` };

  try {
    op.child.kill('SIGKILL');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});