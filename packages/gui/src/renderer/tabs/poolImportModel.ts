// packages/gui/src/renderer/tabs/poolImportModel.ts

export type DepositRow = {
  txid: string;
  vout: number;
  outpoint: string;
  valueSats: string;
  createdAt?: string;
  depositKind?: string;
  importTxid?: string;
  importedIntoShard?: number;
  warnings?: string[];
  receiverRpaHash160Hex?: string;
  chainOk?: boolean | null;
};

export type RpaUtxoRow = {
  outpoint: string;
  valueSats: string;
  spent: boolean;
  hash160Hex?: string;
  kind?: string;
};

type PoolDepositsJson = {
  meta?: {
    stateFile?: string;
    network?: string;
    total?: number;
    shown?: number;
    unimportedOnly?: boolean;
    chainChecked?: boolean;
  };
  deposits?: any[];
  chainChecks?: Record<string, { ok: boolean | null }>;
};

type WalletRpaUtxosJson = {
  utxos?: any[];
};

// ------------------------------------------------------
// Small helpers
// ------------------------------------------------------

export function chipnetTxUrl(txid: string): string {
  return `https://chipnet.chaingraph.cash/tx/${txid}`;
}

export function shortHex(hex: string, chars: number): string {
  const s = String(hex ?? '');
  if (s.length <= chars) return s;
  return `${s.slice(0, chars)}…`;
}

export function formatSats(satsStr: string): string {
  try {
    return BigInt(String(satsStr ?? '0')).toString();
  } catch {
    return String(satsStr ?? '0');
  }
}

function isHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

// ------------------------------------------------------
// Robust JSON extraction (mixed logs + JSON tail)
// ------------------------------------------------------

function extractJsonTail(s: string): string | null {
  const text = String(s ?? '');
  if (!text.trim()) return null;

  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x7b /* { */ || c === 0x5b /* [ */) starts.push(i);
  }
  if (!starts.length) return null;

  for (const start of starts) {
    const tail = text.slice(start).trim();
    if (!tail) continue;

    try {
      JSON.parse(tail);
      return tail;
    } catch {
      const endObj = tail.lastIndexOf('}');
      const endArr = tail.lastIndexOf(']');
      const end = Math.max(endObj, endArr);
      if (end < 0) continue;

      const chopped = tail.slice(0, end + 1).trim();
      try {
        JSON.parse(chopped);
        return chopped;
      } catch {
        // keep trying
      }
    }
  }

  return null;
}

function tryParseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    const tail = extractJsonTail(s);
    if (!tail) return null;
    try {
      return JSON.parse(tail) as T;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------------------
// Argv builders
// ------------------------------------------------------

export function buildScanInboundArgv(args: {
  includeMempool: boolean;
  updateState: boolean;
  windowBlocks?: number;
}): string[] {
  const argv: string[] = ['scan'];
  if (typeof args.windowBlocks === 'number' && Number.isFinite(args.windowBlocks) && args.windowBlocks > 0) {
    argv.push('--window', String(Math.floor(args.windowBlocks)));
  }
  if (args.includeMempool) argv.push('--include-mempool');
  if (args.updateState) argv.push('--update-state');
  return argv;
}

export function buildWalletRpaUtxosArgv(): string[] {
  return ['wallet', 'rpa-utxos', '--json'];
}

export function buildPoolDepositsArgv(args: { unimportedOnly: boolean; checkChain: boolean }): string[] {
  const argv = ['pool', 'deposits', '--json'];
  if (args.unimportedOnly) argv.push('--unimported');
  if (args.checkChain) argv.push('--check-chain');
  return argv;
}

export function buildPoolStageFromArgv(args: { outpoint: string }): string[] {
  return ['pool', 'stage-from', String(args.outpoint), '--json'];
}

export function buildPoolImportArgv(args: { outpoint: string }): string[] {
  return ['pool', 'import', String(args.outpoint)];
}

// ------------------------------------------------------
// Parsers
// ------------------------------------------------------

export function parseWalletRpaUtxos(stdout: string): { utxos: RpaUtxoRow[] } {
  const json = tryParseJson<WalletRpaUtxosJson>(stdout ?? '');
  const utxosAny = Array.isArray(json?.utxos) ? json!.utxos! : [];

  const out: RpaUtxoRow[] = [];
  for (const u of utxosAny) {
    const outpoint = String(u?.outpoint ?? '').trim().toLowerCase();
    if (!outpoint || !/^[0-9a-f]{64}:\d+$/i.test(outpoint)) continue;

    out.push({
      outpoint,
      valueSats: String(u?.valueSats ?? u?.value ?? '0'),
      spent: Boolean(u?.isSpent ?? false),
      hash160Hex: typeof u?.hash160Hex === 'string' ? u.hash160Hex : undefined,
      kind: typeof u?.kind === 'string' ? u.kind : undefined,
    });
  }

  return { utxos: out };
}

export function parsePoolDeposits(stdout: string): {
  deposits: DepositRow[];
  meta: { stateFile?: string; network?: string; total?: number; shown?: number } | null;
} {
  const json = tryParseJson<PoolDepositsJson>(stdout ?? '');
  const depositsAny = Array.isArray(json?.deposits) ? json!.deposits! : [];
  const chainChecks = (json?.chainChecks ?? undefined) as Record<string, { ok: boolean | null }> | undefined;

  const rows: DepositRow[] = [];

  for (const d of depositsAny) {
    const txid = String(d?.txid ?? '').trim().toLowerCase();
    const vout = Number(d?.vout ?? 0);
    if (!isHex64(txid) || !Number.isFinite(vout) || vout < 0) continue;

    const outpoint = `${txid}:${vout}`;
    const valueSats = String(d?.valueSats ?? d?.value ?? '0');

    const cc = chainChecks?.[outpoint];
    const chainOk = typeof cc?.ok === 'boolean' ? cc.ok : cc?.ok ?? null;

    rows.push({
      txid,
      vout,
      outpoint,
      valueSats,
      createdAt: typeof d?.createdAt === 'string' ? d.createdAt : undefined,
      depositKind: typeof d?.depositKind === 'string' ? d.depositKind : undefined,
      importTxid: typeof d?.importTxid === 'string' ? d.importTxid : undefined,
      importedIntoShard: Number.isFinite(Number(d?.importedIntoShard)) ? Number(d?.importedIntoShard) : undefined,
      warnings: Array.isArray(d?.warnings) ? d.warnings.map((x: any) => String(x)) : undefined,
      receiverRpaHash160Hex: typeof d?.receiverRpaHash160Hex === 'string' ? d.receiverRpaHash160Hex : undefined,
      chainOk,
    });
  }

  rows.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  const meta = json?.meta
    ? {
        stateFile: typeof json.meta.stateFile === 'string' ? json.meta.stateFile : undefined,
        network: typeof json.meta.network === 'string' ? json.meta.network : undefined,
        total: typeof json.meta.total === 'number' ? json.meta.total : undefined,
        shown: typeof json.meta.shown === 'number' ? json.meta.shown : undefined,
      }
    : null;

  return { deposits: rows, meta };
}

// ------------------------------------------------------
// Scan progress parser (from streamed chunks)
// ------------------------------------------------------

export type ScanProgressEvent =
  | { kind: 'progress'; cur: number; total: number }
  | { kind: 'done' }
  | { kind: 'found'; found: number };

export function parseScanProgressChunk(chunk: string): ScanProgressEvent | null {
  const t = String(chunk ?? '').replace(/\r/g, '');

  const pm = t.match(/scan:\s+fetching raw tx\s+(\d+)\s*\/\s*(\d+)/i);
  if (pm) {
    const cur = Number(pm[1]);
    const total = Number(pm[2]);
    if (Number.isFinite(cur) && Number.isFinite(total) && total > 0) return { kind: 'progress', cur, total };
  }

  if (t.toLowerCase().includes('scan: fetching raw tx') && t.toLowerCase().includes('done')) {
    return { kind: 'done' };
  }

  const fm = t.match(/found:\s+(\d+)/i);
  if (fm) {
    const found = Number(fm[1]);
    if (Number.isFinite(found) && found >= 0) return { kind: 'found', found };
  }

  return null;
}