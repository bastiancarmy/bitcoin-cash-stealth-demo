export type DemoStateSchemaVersion = 1;

export type DemoStateFile = {
  schemaVersion: DemoStateSchemaVersion;
  updatedAt: string; // ISO
  data: Record<string, unknown>;
};

export interface DemoStateStore {
  load(): Promise<void>;
  flush(): Promise<void>;

  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;

  snapshot(): Record<string, unknown>;
}