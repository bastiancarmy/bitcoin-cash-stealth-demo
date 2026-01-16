import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PoolStateFile, PoolStateStore } from './types.js';
import { getPath, setPath, deletePath } from './keys.js';

const DEFAULT_FILE: PoolStateFile = {
  schemaVersion: 1,
  updatedAt: new Date(0).toISOString(),
  data: {},
};

export type FileBackedStoreOptions = {
  filename: string;
};

export class FileBackedPoolStateStore implements PoolStateStore {
  public readonly filename: string; // <-- changed (was private)
  private file: PoolStateFile = structuredClone(DEFAULT_FILE);
  private loaded = false;

  constructor(opts: FileBackedStoreOptions) {
    this.filename = opts.filename;
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      const raw = await fs.readFile(this.filename, 'utf8');
      const parsed = JSON.parse(raw) as PoolStateFile;

      if (parsed.schemaVersion !== 1) {
        throw new Error(`Unsupported schemaVersion: ${String((parsed as any).schemaVersion)}`);
      }

      this.file = parsed;
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        // start new
        this.file = structuredClone(DEFAULT_FILE);
      } else {
        throw e;
      }
    }

    this.loaded = true;
  }

  get<T>(key: string): T | undefined {
    if (!this.loaded) throw new Error('State not loaded. Call load() first.');
    return getPath(this.file.data as any, key) as T | undefined;
  }

  set<T>(key: string, value: T): void {
    if (!this.loaded) throw new Error('State not loaded. Call load() first.');
    setPath(this.file.data as any, key, value);
    this.file.updatedAt = new Date().toISOString();
  }

  delete(key: string): void {
    if (!this.loaded) throw new Error('State not loaded. Call load() first.');
    deletePath(this.file.data as any, key);
    this.file.updatedAt = new Date().toISOString();
  }

  snapshot(): Record<string, unknown> {
    if (!this.loaded) throw new Error('State not loaded. Call load() first.');
    return structuredClone(this.file.data);
  }

  async flush(): Promise<void> {
    if (!this.loaded) throw new Error('State not loaded. Call load() first.');

    const dir = path.dirname(this.filename);
    await fs.mkdir(dir, { recursive: true });

    const tmp = `${this.filename}.tmp`;
    const json = JSON.stringify(this.file, null, 2);

    await fs.writeFile(tmp, json, 'utf8');
    await fs.rename(tmp, this.filename);
  }
}