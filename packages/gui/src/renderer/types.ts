// packages/gui/src/renderer/types.ts
export type BchctlChunk = {
  opId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
};

export type ConfigJsonV1 = {
  version: 1;
  createdAt: string;
  currentProfile: string;
  profiles: Record<string, any>;
};

export type AppInfo = {
  // dev diagnostics (still returned by main)
  repoRoot: string;
  cliDist: string;
  userDataDir: string;

  // canonical GUI storage
  storageRoot: string;
  dotDir: string;

  // profile bootstrap
  launchProfile: string | null;
  activeProfile: string;

  platform?: string;
  arch?: string;
  appVersion?: string;
  isPackaged?: boolean;
};

export type WalletShowJson = {
  profile?: string;
  address?: string; // cashaddr
  paycode?: string;
};

export type WalletUtxosJson = {
  network?: string;
  profile?: string;
  address?: string;
  includeUnconfirmed?: boolean;
  utxos?: Array<{
    txid: string;
    vout: number;

    // CLI currently emits `value` in sats (number). Some other commands use `valueSats`.
    value?: number | string;
    valueSats?: number | string;
    satoshis?: number | string;
    amountSats?: number | string;

    confirmations?: number;
    height?: number;

    token?: any;
    tokenData?: any;
  }>;
};

export type WalletRpaUtxosJson = {
  totalSats?: string;
  utxos?: Array<{
    outpoint: string;
    valueSats?: string | number;
    value?: string | number;
    satoshis?: string | number;
    amountSats?: string | number;

    isSpent: boolean;
    owner?: string;
    kind?: string;
  }>;
};

export type PoolShardsJson = {
  meta?: {
    shardCount?: number;
    totalSats?: string;
    poolIdHex?: string;
    categoryHex?: string;
    stateFile?: string;
  };
  shards?: Array<{
    index?: number;
    txid?: string;
    vout?: number;
    valueSats?: string | number;
    value?: string | number;
    satoshis?: string | number;
    amountSats?: string | number;
    commitmentHex?: string;
  }>;
};

export function tryParseJson<T = unknown>(s: string): T | null {
  const trimmed = s.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function coerceSats(v: unknown): bigint {
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return 0n;
    // tolerate "1015000" style
    try {
      return BigInt(t);
    } catch {
      return 0n;
    }
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return BigInt(Math.trunc(v));
  }
  return 0n;
}

function pickValueSats(obj: Record<string, unknown>): bigint {
  // Prefer explicit sats fields first
  if ('valueSats' in obj) return coerceSats(obj.valueSats);
  if ('amountSats' in obj) return coerceSats(obj.amountSats);
  if ('satoshis' in obj) return coerceSats(obj.satoshis);

  // Fallback: `value` is used by your CLI utxos output and is already sats
  if ('value' in obj) return coerceSats(obj.value);

  return 0n;
}

/**
 * Accepts:
 * - Array<{ value | valueSats | satoshis | amountSats }>
 * - WalletUtxosJson (uses .utxos)
 * - WalletRpaUtxosJson (uses .utxos)
 * - PoolShardsJson (uses .shards)
 * - null/undefined/unknown (returns 0)
 */
export function sumUtxosSats(x: unknown): bigint {
  if (!x) return 0n;

  // Array<{ value* }>
  if (Array.isArray(x)) {
    let sum = 0n;
    for (const item of x) {
      if (!isObject(item)) continue;
      sum += pickValueSats(item);
    }
    return sum;
  }

  // WalletUtxosJson / WalletRpaUtxosJson
  if (isObject(x) && Array.isArray((x as any).utxos)) {
    return sumUtxosSats((x as any).utxos);
  }

  // PoolShardsJson
  if (isObject(x) && Array.isArray((x as any).shards)) {
    return sumUtxosSats((x as any).shards);
  }

  return 0n;
}

// Explorer helpers (unchanged)
export const CHIPNET_EXPLORER_BASE = 'https://chipnet.imaginary.cash';

export function chipnetExplorerTxUrl(txid: string): string {
  return `${CHIPNET_EXPLORER_BASE}/tx/${txid}`;
}

export function extractTxidsFromText(text: string): string[] {
  const re = /\b[a-fA-F0-9]{64}\b/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[0]);
  return [...out];
}