export type PoolStateSchemaVersion = 1;

export type PoolStateFile = {
  schemaVersion: PoolStateSchemaVersion;
  updatedAt: string; // ISO
  data: Record<string, unknown>;
};

export interface PoolStateStore {
  load(): Promise<void>;
  flush(): Promise<void>;

  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;

  snapshot(): Record<string, unknown>;
}