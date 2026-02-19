// packages/gui/electron/main.ts
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

type BchctlChunk = { opId: string; stream: 'stdout' | 'stderr'; chunk: string };
type BchctlExit = { opId: string; code: number };

type RunningOp = {
  child: ReturnType<typeof spawn>;
  stdout: string;
  stderr: string;
};

type ConfigJsonV1 = {
  version: 1;
  createdAt: string;
  currentProfile: string;
  profiles: Record<string, any>;
};

let mainWindow: BrowserWindow | null = null;
const running = new Map<string, RunningOp>();

function log(...args: any[]) {
  // emojis allowed only in console logs
  console.log('🙂 [gui]', ...args);
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
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

function writeTextAtomic(p: string, text: string) {
  mkdirp(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

function isDev(): boolean {
  return !app.isPackaged;
}

// --- repo root is ONLY for locating CLI dist in dev ---
function resolveCliDistEntry(repoRoot: string): string {
  return path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
}

function hasRepoMarker(dir: string): boolean {
  return exists(path.join(dir, 'packages', 'cli', 'package.json'));
}

function walkUpFindRepoRoot(startDir: string): string | null {
  let cur = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
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
    app.getPath('userData')
  );
}

// --- storage root (deterministic) ---
function getStorageRoot(): string {
  // packaged + dev both use userData, not repo root
  return path.join(app.getPath('userData'), 'bch-stealth');
}

function getDotDir(storageRoot: string): string {
  return path.join(storageRoot, '.bch-stealth');
}

function getConfigPath(storageRoot: string): string {
  return path.join(getDotDir(storageRoot), 'config.json');
}

function listProfileDirs(storageRoot: string): string[] {
  const profilesDir = path.join(getDotDir(storageRoot), 'profiles');
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
      // fall through to init
    }
  }

  // Init a minimal config. If profile dirs exist, seed from them (placeholders).
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
  const configPath = getConfigPath(storageRoot);
  writeTextAtomic(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

function ensureProfileInConfig(cfg: ConfigJsonV1, profile: string) {
  cfg.profiles[profile] = cfg.profiles[profile] ?? { network: 'chipnet' };
}

function resolveActiveProfile(storageRoot: string): { launchProfile: string | null; activeProfile: string } {
  const launchProfile = parseLaunchProfileArg(process.argv) ?? null;

  const cfg = loadOrInitConfig(storageRoot);

  if (launchProfile) {
    ensureProfileInConfig(cfg, launchProfile);
    cfg.currentProfile = launchProfile;
    saveConfig(storageRoot, cfg);
    return { launchProfile, activeProfile: launchProfile };
  }

  const current = String(cfg.currentProfile ?? '').trim();
  if (current) return { launchProfile: null, activeProfile: current };

  const first = Object.keys(cfg.profiles).sort()[0] ?? 'default';
  cfg.currentProfile = first;
  ensureProfileInConfig(cfg, first);
  saveConfig(storageRoot, cfg);
  return { launchProfile: null, activeProfile: first };
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

function sendExit(msg: BchctlExit) {
  if (!mainWindow) return;
  mainWindow.webContents.send('bchctl:exit', msg);
}

// ---- Single instance lock (important for macOS dock icon behavior) ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Ensure storage exists on startup
    const storageRoot = getStorageRoot();
    mkdirp(storageRoot);
    mkdirp(getDotDir(storageRoot));
    loadOrInitConfig(storageRoot);

    createMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

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

    // dev-only-ish diagnostics
    repoRoot,
    cliDist,

    // new canonical storage
    userDataDir: app.getPath('userData'),
    storageRoot,
    dotDir,

    // profile bootstrap
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
  return { ok: true, config: cfg, path: getConfigPath(storageRoot) };
});

ipcMain.handle('setCurrentProfile', async (_evt, args: { profile: string }) => {
  const storageRoot = getStorageRoot();
  const prof = String(args?.profile ?? '').trim();
  if (!prof) return { ok: false, error: 'profile is required' };

  const cfg = loadOrInitConfig(storageRoot);
  ensureProfileInConfig(cfg, prof);
  cfg.currentProfile = prof;
  saveConfig(storageRoot, cfg);
  return { ok: true };
});

ipcMain.handle('listProfiles', async () => {
  const storageRoot = getStorageRoot();
  const cfg = loadOrInitConfig(storageRoot);
  return Object.keys(cfg.profiles ?? {}).sort();
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

    // Always pass --profile. Always force deterministic storage.
    const profile = String(args.profile ?? '').trim() || 'default';
    const fullArgv = [cliEntry, '--profile', profile, ...(args.argv ?? [])];

    // NOTE: In Electron, process.execPath is the Electron binary.
    // Set ELECTRON_RUN_AS_NODE=1 so it behaves like "node".
    log('spawn', process.execPath, ...fullArgv, '(ELECTRON_RUN_AS_NODE=1)', '(BCH_STEALTH_HOME)', storageRoot);

    const child = spawn(process.execPath, fullArgv, {
      // A) cwd sets where .bch-stealth is created (even if CLI ignored env)
      cwd: storageRoot,
      // B) env is the preferred explicit path override
      env: {
        ...process.env,
        ...(args.env ?? {}),
        ELECTRON_RUN_AS_NODE: '1',
        BCH_STEALTH_HOME: storageRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const op: RunningOp = { child, stdout: '', stderr: '' };
    running.set(opId, op);

    child.stdout?.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      op.stdout += chunk;
      sendChunk({ opId, stream: 'stdout', chunk });
    });

    child.stderr?.on('data', (buf) => {
      const chunk = buf.toString('utf8');
      op.stderr += chunk;
      sendChunk({ opId, stream: 'stderr', chunk });
    });

    child.on('close', (code) => {
      sendExit({ opId, code: Number(code ?? 1) });
      setTimeout(() => running.delete(opId), 60_000);
    });

    child.on('error', (err) => {
      const msg = String((err as any)?.message ?? err);
      op.stderr += msg + '\n';
      sendChunk({ opId, stream: 'stderr', chunk: msg + '\n' });
      sendExit({ opId, code: 1 });
      setTimeout(() => running.delete(opId), 60_000);
    });

    return { opId };
  }
);

ipcMain.handle('getBchctlResult', async (_evt, args: { opId: string }) => {
  const op = running.get(args.opId);
  if (!op) return { ok: false, error: 'unknown opId (expired)' };
  return { ok: true, stdout: op.stdout, stderr: op.stderr };
});

ipcMain.handle('killBchctl', async (_evt, args: { opId: string }) => {
  const op = running.get(args.opId);
  if (!op) return { ok: false, error: 'unknown opId' };
  try {
    op.child.kill('SIGTERM');
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});