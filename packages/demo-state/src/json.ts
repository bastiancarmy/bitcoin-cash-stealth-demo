// demo-state/src/json.ts
import { promises as fs } from 'node:fs';

export async function readJsonFile<T>(filename: string): Promise<T> {
  const raw = await fs.readFile(filename, 'utf8');
  return JSON.parse(raw) as T;
}