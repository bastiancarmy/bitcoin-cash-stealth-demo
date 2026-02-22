// packages/gui/src/renderer/tabs/poolImportModel.ts
import type { RunResult } from '../hooks/useBchctl';

export type LastRun = {
  ts: number;
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
};

export type ChainCheck = { ok: boolean | null };

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

type PoolDepositsJson = {
  meta?: any;
  deposits?: any[];
  chainChecks?: Record<string, ChainCheck>;
};

type StageFromJson = {
  meta?: any;
  deposit?: any;
};

// ------------------------------------------
// Robust JSON extraction helpers (mixed logs)
// ------------------------------------------

function extractJsonTail(s: string): string | null {
  const text = String(s ?? '');
  if (!text.trim()) return null;

  // Collect candidate starts for JSON (objects or arrays).
  // Important: stdout may contain bracketed timestamp lines like:
  //   [2026-...] bchctl ...
  // and funding logs like:
  //   [funding] ...
  // before the final JSON object.
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x7b /* { */ || c === 0x5b /* [ */) starts.push(i);
  }
  if (!starts.length) return null;

  // Try parsing from each candidate start.
  for (const start of starts) {
    const tail = text.slice(start).trim();
    if (!tail) continue;

    // Fast path: try tail as-is
    try {
      JSON.parse(tail);
      return tail;
    } catch {
      // Slow path: trim to last closer and try again
      const endObj = tail.lastIndexOf('}');
      const endArr = tail.lastIndexOf(']');
      const end = Math.max(endObj, endArr);
      if (end < 0) continue;

      const chopped = tail.slice(0, end + 1).trim();
      try {
        JSON.parse(chopped);
        return chopped;
      } catch {
        // keep trying next candidate start
      }
    }
  }

  return null;
}

function tryParseJson<T>(s: string): T | null {
  // 1) Pure JSON
  try {
    return JSON.parse(s) as T;
  } catch {
    // 2) Mixed logs + JSON tail
    const tail = extractJsonTail(s);
    if (!tail) return null;
    try {
      return JSON.parse(tail) as T;
    } catch {
      return null;
    }
  }
}

// ------------------------------------------

export function isHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(s);
}

export function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const s = String(outpoint ?? '').trim();
  const m = s.match(/^([0-9a-f]{64}):(\d+)$/i);
  if (!m) return null;

  const txid = m[1].toLowerCase();
  const vout = Number(m[2]);

  if (!Number.isFinite(vout) || vout < 0) return null;
  return { txid, vout };
}

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
    const n = BigInt(String(satsStr ?? '0'));
    return n.toString();
  } catch {
    return String(satsStr ?? '0');
  }
}

export function toLastRun(argv: string[], res: RunResult): LastRun {
  return {
    ts: Date.now(),
    argv,
    code: res.code,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

// ------------------------------------------
// pool deposits
// ------------------------------------------

export function buildPoolDepositsArgv(args: { unimportedOnly: boolean; checkChain: boolean }): string[] {
  const argv = ['pool', 'deposits', '--json'];
  if (args.unimportedOnly) argv.push('--unimported');
  if (args.checkChain) argv.push('--check-chain');
  return argv;
}

export function parsePoolDeposits(stdout: string): {
  deposits: DepositRow[];
  chainChecks?: Record<string, ChainCheck>;
} {
  const json = tryParseJson<PoolDepositsJson>(stdout ?? '');
  const depositsAny = Array.isArray(json?.deposits) ? json!.deposits! : [];
  const chainChecks = (json?.chainChecks ?? undefined) as Record<string, ChainCheck> | undefined;

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

  // Most-recent first (createdAt if present)
  rows.sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  return { deposits: rows, chainChecks };
}

// ------------------------------------------
// pool stage / import argv builders
// ------------------------------------------

export function buildPoolStageArgv(args: {
  sats: string;
  depositMode: 'rpa' | 'base';
  changeMode: 'auto' | 'transparent' | 'stealth';
}): string[] {
  return [
    'pool',
    'stage',
    String(args.sats),
    '--deposit-mode',
    args.depositMode,
    '--change-mode',
    args.changeMode,
    '--json',
  ];
}

export function buildPoolImportArgv(args: {
  outpoint?: string | null;
  latest?: boolean;
  shard?: string;
  fresh?: boolean;
  allowBase?: boolean;
  depositWif?: string;
  depositPrivHex?: string;
}): string[] {
  const argv: string[] = ['pool', 'import'];

  if (args.latest) argv.push('--latest');
  else if (args.outpoint) argv.push(String(args.outpoint));
  else argv.push('--latest');

  if (args.shard && String(args.shard).trim()) argv.push('--shard', String(args.shard).trim());
  if (args.fresh) argv.push('--fresh');

  if (args.allowBase) argv.push('--allow-base');
  if (args.depositWif && String(args.depositWif).trim()) argv.push('--deposit-wif', String(args.depositWif).trim());
  if (args.depositPrivHex && String(args.depositPrivHex).trim())
    argv.push('--deposit-privhex', String(args.depositPrivHex).trim());

  return argv;
}

// ------------------------------------------
// Optional: pool stage-from parsing (nice-to-have)
// ------------------------------------------
//
// This is not required for the staged deposits list; it just gives the UI
// a clean JSON parse for the stage-from response when --json is used.
//
export function parsePoolStageFrom(stdout: string): { depositOutpoint?: string } {
  const json = tryParseJson<StageFromJson>(stdout ?? '');
  const d = json?.deposit;
  const txid = String(d?.txid ?? '').trim().toLowerCase();
  const vout = Number(d?.vout ?? 0);
  if (!isHex64(txid) || !Number.isFinite(vout) || vout < 0) return {};
  return { depositOutpoint: `${txid}:${vout}` };
}