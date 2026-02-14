// packages/cli/src/commands/scan.ts
//
// What this changes:
// - Dedupe discovered results by outpoint before printing (so "found: 1").
// - Dedupe merged state by outpoint before writing.
// - Default (no flags): derive a 1-byte RPA prefix from wallet scanPrivBytes.
// - Normalize --rpa-prefix into the *server-expected* 1–2 byte hex prefix (2–4 hex chars).
//   (Your server rejects longer strings like "76a91456".)
// - Keeps --txid mode as a bypass/debug tool (no prefix required).
// - More defensive raw-tx fetch: tolerates Fulcrum returning an object (verbose) with a `.hex` field.
// - Adds a small fetch progress indicator for better UX.
// - Fixes state split-brain: when stateFile is a pool-state envelope (schemaVersion + data.pool.state),
//   --update-state writes into data.pool.state.stealthUtxos (the canonical location pool import reads),
//   and removes top-level stealthUtxos to avoid confusion.
// - BigInt-safe state writes (no JSON.stringify crash).
//
// Server RPC constraint observed on chipnet/Fulcrum:
//   prefixHex must be 2..4 hex chars (1–2 bytes).

import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

import { connectElectrum as connectElectrumDefault } from '@bch-stealth/electrum';
import { scanChainWindow as scanChainWindowDefault } from '@bch-stealth/rpa-scan';
import { NETWORK } from '../config.js';
import type { LoadedWallet } from '../wallets.js';

import type { StealthUtxoRecord } from '@bch-stealth/pool-state';
import {
  hexToBytes,
  bytesToHex,
  encodeCashAddr,
  decodeCashAddress,
  sha256,
  concat,
} from '@bch-stealth/utils';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { normalizeWalletKeys, debugPrintKeyFlags } from '../wallet/normalizeKeys.js';

type ScanFlags = {
  sinceHeight?: number;
  window?: number;
  updateState?: boolean;
  rpaPrefix?: string;
  includeMempool?: boolean;
  all?: boolean;
  txid?: string;
};

function fileExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureDirForFile(filePath: string) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function readJsonOrNull<T>(p: string): T | null {
  if (!fileExists(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

// BigInt-safe + Uint8Array-safe JSON write
function writeJsonPretty(p: string, v: unknown) {
  ensureDirForFile(p);

  const bigIntReplacer = (_k: string, value: unknown) => {
    if (typeof value === 'bigint') return value.toString(10);
    if (value instanceof Uint8Array) return bytesToHex(value);
    return value;
  };

  fs.writeFileSync(p, JSON.stringify(v, bigIntReplacer, 2) + '\n', 'utf8');
}

function getOutpointKey(r: any): string {
  const txid = r?.txid ?? r?.txidHex ?? r?.outpointTxid;
  const vout = r?.vout ?? r?.outpointVout ?? r?.n;
  return `${String(txid)}:${String(vout)}`;
}

function dedupeByOutpoint<T>(records: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of records) {
    const key = getOutpointKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// Detect pool-state envelope and return canonical stealthUtxos container
function getPoolStateStealthUtxosContainer(obj: any): { root: any; key: 'stealthUtxos' } | null {
  const poolState = obj?.data?.pool?.state;
  if (poolState && typeof poolState === 'object') {
    return { root: poolState, key: 'stealthUtxos' };
  }
  return null;
}

function coerceArray<T>(v: any): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

// ✅ Robust normalization for Electrum/Fulcrum responses.
// Handles:
// - string hex
// - Uint8Array / Buffer
// - String object
// - verbose tx objects that include a `.hex` field (even if non-enumerable)
// - wrappers like `{ result: <hex> }`, `{ raw: <hex> }`, etc.
function normalizeHexString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;

  if (value instanceof Uint8Array) return bytesToHex(value);

  // Handle String objects (rare, but can happen)
  if (value instanceof String) return String(value.valueOf());

  // Node Buffer is a Uint8Array subclass, but keep this anyway:
  const anyVal: any = value as any;
  if (
    anyVal &&
    typeof anyVal === 'object' &&
    typeof anyVal.length === 'number' &&
    typeof anyVal.readUInt8 === 'function'
  ) {
    return bytesToHex(new Uint8Array(anyVal));
  }

  if (value && typeof value === 'object') {
    const o: any = value;

    // Check common fields using `in` so non-enumerable fields still work
    const fieldCandidates = ['hex', 'raw', 'result', 'data', 'tx', 'transaction'];
    for (const k of fieldCandidates) {
      if (k in o) {
        const v = o[k];
        if (typeof v === 'string') return v;
        if (v instanceof Uint8Array) return bytesToHex(v);
        if (v instanceof String) return String(v.valueOf());
      }
    }

    // Some servers may wrap bytes as ArrayBuffer
    if (o instanceof ArrayBuffer) return bytesToHex(new Uint8Array(o));
    if (o?.buffer instanceof ArrayBuffer && typeof o?.byteLength === 'number') {
      try {
        return bytesToHex(new Uint8Array(o.buffer, o.byteOffset ?? 0, o.byteLength));
      } catch {
        // ignore
      }
    }
  }

  const keys =
    value && typeof value === 'object' ? ` keys=${Object.keys(value as any).join(',')}` : '';
  throw new Error(`${label}: expected hex string/bytes, got ${typeof value}.${keys}`);
}

function unwrapRpcValue<T = unknown>(v: unknown, label: string): T {
  if (v instanceof Error) throw new Error(`${label}: electrum returned Error: ${v.message}`);
  if (v && typeof v === 'object' && (v as any).error) {
    const msg =
      (v as any).error?.message ??
      (v as any).error?.error ??
      JSON.stringify((v as any).error);
    throw new Error(`${label}: electrum returned error: ${msg}`);
  }
  return v as T;
}

async function getTipHeight(client: any): Promise<number> {
  const parseHeight = (r: any): number | null => {
    if (r == null) return null;
    if (typeof r === 'number' && Number.isFinite(r)) return r;
    if (typeof r === 'object' && r.height != null) {
      const h = Number(r.height);
      return Number.isFinite(h) ? h : null;
    }
    if (Array.isArray(r) && r.length > 0) return parseHeight(r[0]);
    return null;
  };

  const tryCall = async (fn: () => Promise<any>): Promise<number | null> => {
    try {
      const r = await fn();
      return parseHeight(r);
    } catch {
      return null;
    }
  };

  const h =
    (await tryCall(() => client.request('blockchain.headers.subscribe', []))) ??
    (await tryCall(() => client.request('blockchain.headers.subscribe'))) ??
    (await tryCall(() => client.request('blockchain.headers.subscribe', undefined)));

  if (h != null) return h;
  throw new Error('scan: could not determine chain tip height from electrum server');
}

function cleanHexPrefix(s: string): string {
  const x = s.startsWith('0x') ? s.slice(2) : s;
  return x.trim().toLowerCase();
}

function parseTxidOrThrow(raw: unknown): string {
  const txid = String(raw ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error(`scan: --txid must be a 64-char hex txid (got "${String(raw ?? '')}")`);
  }
  return txid;
}

/**
 * Server expects 1–2 bytes hex (2–4 chars).
 * User may pass:
 *  - "56" or "56ab" (preferred)
 *  - cashaddr -> derive 1 byte from decoded hash160
 *  - "76a91456" (script prefix) -> we extract "56"
 */
const P2PKH_SCRIPT_PREFIX_HEX = '76a914';

function normalizeRpaPrefixHexOrThrow(opts: ScanFlags): string {
  const raw = String(opts.rpaPrefix ?? '').trim();
  if (!raw) {
    throw new Error(
      'scan: missing --rpa-prefix <cashaddr|hex>\n' +
        'Tip: pass 1–2 bytes of expected dest hash160 (e.g. "56" or "56ab").\n' +
        'You may also pass a cashaddr; it will be decoded.\n' +
        'You may also pass a script prefix like "76a91456"; we will extract "56".'
    );
  }

  // Cashaddr: decode to hash160 and default to 1-byte prefix
  if (raw.includes(':')) {
    const decoded: any = decodeCashAddress(raw);
    const h: unknown = decoded?.hash;
    const type: unknown = decoded?.type;

    if (type !== 'P2PKH') {
      throw new Error(`scan: --rpa-prefix cashaddr must be P2PKH (got ${String(type ?? 'unknown')})`);
    }
    if (!(h instanceof Uint8Array) || h.length !== 20) {
      throw new Error('scan: --rpa-prefix cashaddr decode failed (expected 20-byte hash160)');
    }

    return bytesToHex(h.slice(0, 1)).toLowerCase(); // 1 byte => 2 hex chars
  }

  const p0 = cleanHexPrefix(raw);
  if (!/^[0-9a-f]+$/.test(p0)) throw new Error('scan: --rpa-prefix must be hex or cashaddr');
  if (p0.length % 2 !== 0) throw new Error('scan: --rpa-prefix must have even hex length (whole bytes)');

  let p = p0.toLowerCase();

  // If user passed script prefix: 76a914<hash160...>, extract after 76a914
  if (p.startsWith(P2PKH_SCRIPT_PREFIX_HEX)) {
    p = p.slice(P2PKH_SCRIPT_PREFIX_HEX.length);
  }

  // Server constraint: 1–2 bytes only
  if (p.length < 2) throw new Error('scan: --rpa-prefix must be at least 1 byte (2 hex chars)');
  if (p.length > 4) p = p.slice(0, 4); // truncate to 2 bytes max

  if (p.length !== 2 && p.length !== 4) {
    throw new Error('scan: --rpa-prefix must resolve to 1–2 bytes (2–4 hex chars)');
  }

  return p;
}

/**
 * Default per-wallet grind string (1 byte) derived from scan pubkey Q.
 * rpaPrefixHex = sha256("bch-stealth:rpa:grind:" || Q)[0]
 */
function deriveWalletDefaultRpaPrefixHex(scanPriv32: Uint8Array): string {
  const Q = secp256k1.getPublicKey(scanPriv32, true); // 33
  const tag = new TextEncoder().encode('bch-stealth:rpa:grind:');
  const h = sha256(concat(tag, Q));
  return bytesToHex(h.slice(0, 1)).toLowerCase();
}

function cashaddrPrefixFromNetwork(network: string): 'bitcoincash' | 'bchtest' {
  const n = String(network ?? '').toLowerCase();
  return n === 'mainnet' ? 'bitcoincash' : 'bchtest';
}

function p2pkhCashaddrFromHash160Hex(network: string, h160Hex: string): string {
  return encodeCashAddr(cashaddrPrefixFromNetwork(network), 'P2PKH', hexToBytes(h160Hex));
}

/**
 * Resolve profile/stateFile using commander "global" opts when available, to prevent
 * profile leaks (e.g. `--profile bob scan` writing to alice state).
 */
function resolveProfileAndStateFile(
  program: Command,
  depsActive: { profile: string; stateFile: string },
  cmdMaybe: any
): { profile: string; stateFile: string } {
  const globals =
    typeof cmdMaybe?.optsWithGlobals === 'function'
      ? cmdMaybe.optsWithGlobals()
      : (cmdMaybe?.parent?.opts?.() ?? program?.opts?.() ?? {});

  const cliProfileRaw = String((globals as any).profile ?? '').trim();
  const profile = cliProfileRaw || String(depsActive.profile ?? '').trim() || 'default';

  const stateFileOverrideRaw = String((globals as any).stateFile ?? '').trim();
  const stateFile = stateFileOverrideRaw || depsActive.stateFile;

  return { profile, stateFile };
}

function detectOwnerHint(existing: any): string | null {
  try {
    const st = existing?.data?.pool?.state;
    const a = st?.restoreHints?.ownerTag;
    if (typeof a === 'string' && a.trim()) return a.trim();

    const u0 = st?.stealthUtxos?.[0]?.owner;
    if (typeof u0 === 'string' && u0.trim()) return u0.trim();
  } catch {
    // ignore
  }
  return null;
}

// ✅ Updated registerScanCommand: add indexHints extraction + wire indexHints/stopOnFirstMatch into scanChainWindowAny
// Notes:
// - Reads state once at the top (existingStateJson) and reuses it for update-state merge.
// - indexHints is null when empty (so rpa-scan can treat as "no hints").
// - stopOnFirstMatch is enabled only for --txid mode.

export function registerScanCommand(
  program: Command,
  deps: {
    loadMeWallet: () => Promise<LoadedWallet>;
    getActivePaths: () => { profile: string; stateFile: string };

    electrum?: { connectElectrum: (args: { network: string }) => Promise<any> };
    scanChainWindow?: (args: any) => Promise<any[]>;
  }
) {
  program
    .command('scan')
    .description('Scan chain for inbound paycode-derived outputs (beaconless via Fulcrum RPA index).')
    .option('--since-height <H>', 'scan from height H to tip', (v) => Number(v))
    .option('--window <N>', 'scan last N blocks (overrides birthdayHeight)', (v) => Number(v))
    .option('--update-state', 'persist discovered outputs to state file', false)
    .option('--rpa-prefix <HEX>', 'RPA prefix hex (server expects 2–4 hex chars, e.g. "56" or "56ab")')
    .option('--include-mempool', 'also scan unconfirmed RPA txs', false)
    .option('--txid <TXID>', 'Scan a single txid (bypasses Fulcrum RPA candidate selection).')
    .option('--all', 'Also print hex internals (hash160 + RPA context fields).', false)
    // IMPORTANT: receive `cmd` as 2nd arg so we can read global flags reliably
    .action(async (opts: ScanFlags, cmd: any) => {
      const me = await deps.loadMeWallet();
      const all = !!opts.all;

      // Resolve profile + stateFile safely (globals win)
      const ap = deps.getActivePaths();
      const { profile, stateFile } = resolveProfileAndStateFile(program, ap, cmd);

      // Read existing state ONCE (for hints + optional update-state merge later)
      // If file doesn't exist, this becomes {} and hints stay empty.
      const existingStateJson = readJsonOrNull<any>(stateFile) ?? {};

      // ✅ indexHints: last few observed indices (roleIndex or rpaContext.index)
      const poolContainer0 = getPoolStateStealthUtxosContainer(existingStateJson);
      const targetRoot0 = poolContainer0 ? poolContainer0.root : existingStateJson;
      const existingRecords0 = coerceArray<any>(
        targetRoot0[poolContainer0 ? poolContainer0.key : ('stealthUtxos' as const)]
      );

      const lastIdxs = existingRecords0
        .map((r: any) => r?.roleIndex ?? r?.rpaContext?.index)
        .filter((n: any) => Number.isInteger(n) && n >= 0)
        .slice(-8);

      const indexHints = lastIdxs.length ? lastIdxs : null;

      if (String(process.env.BCH_STEALTH_DEBUG_SCAN ?? '') === '1') {
        const globals =
          typeof cmd?.optsWithGlobals === 'function'
            ? cmd.optsWithGlobals()
            : (cmd?.parent?.opts?.() ?? program?.opts?.() ?? {});
        console.log(`[scan:debug] globals.profile=${String((globals as any).profile ?? '') || '(none)'}`);
        console.log(`[scan:debug] globals.stateFile=${String((globals as any).stateFile ?? '') || '(none)'}`);
        console.log(`[scan:debug] deps.profile=${ap.profile}`);
        console.log(`[scan:debug] deps.stateFile=${ap.stateFile}`);
        console.log(`[scan:debug] resolved.profile=${profile}`);
        console.log(`[scan:debug] resolved.stateFile=${stateFile}`);
        console.log(`[scan:debug] indexHints=${indexHints ? indexHints.join(',') : '(none)'}`);
      }

      // use injected deps when provided (tests), otherwise default adapter
      const electrumAny: { connectElectrum: (args: { network: string }) => Promise<any> } =
        deps.electrum ??
        ({
          connectElectrum: async ({ network }: { network: string }) => connectElectrumDefault(network as any),
        } as const);

      const scanChainWindowAny: any = deps.scanChainWindow ?? scanChainWindowDefault;

      const client = await electrumAny.connectElectrum({ network: NETWORK });

      try {
        const tipHeight = await getTipHeight(client);

        const birthdayHeight =
          Number((me as any).birthdayHeight ?? (me as any).wallet?.birthdayHeight ?? 0) || 0;

        let startHeight = birthdayHeight || 0;

        if (opts.sinceHeight != null && Number.isFinite(opts.sinceHeight)) {
          startHeight = Math.max(0, Math.floor(opts.sinceHeight));
        } else if (opts.window != null && Number.isFinite(opts.window)) {
          const w = Math.max(1, Math.floor(opts.window));
          startHeight = Math.max(0, tipHeight - w + 1);
        }

        const endHeight = tipHeight;

        // direct txid scan mode
        const singleTxid = opts.txid ? parseTxidOrThrow(opts.txid) : null;

        // --- keys ---
        const basePrivBytes: Uint8Array | undefined =
          (me as any).privBytes ??
          ((me as any).wallet?.privHex ? hexToBytes(String((me as any).wallet.privHex).trim()) : undefined);

        const scanPrivBytes: Uint8Array | undefined =
          (me as any).scanPrivBytes ??
          ((me as any).wallet?.scanPrivHex ? hexToBytes(String((me as any).wallet.scanPrivHex).trim()) : undefined);

        const spendPrivBytes: Uint8Array | undefined =
          (me as any).spendPrivBytes ??
          ((me as any).wallet?.spendPrivHex ? hexToBytes(String((me as any).wallet.spendPrivHex).trim()) : undefined);

        const nk = normalizeWalletKeys({
          privBytes: basePrivBytes ?? null,
          scanPrivBytes: scanPrivBytes ?? null,
          spendPrivBytes: spendPrivBytes ?? null,
        });

        debugPrintKeyFlags('scan', nk.flags);

        const receiverScanPriv32 = nk.scanPriv32;
        const receiverSpendPriv32 = nk.spendPriv32;

        const rpaPrefixHex: string = singleTxid
          ? (opts.rpaPrefix ? normalizeRpaPrefixHexOrThrow(opts) : '(none)')
          : (opts.rpaPrefix
              ? normalizeRpaPrefixHexOrThrow(opts)
              : deriveWalletDefaultRpaPrefixHex(receiverScanPriv32));

        if (nk.flags.spendWasDerived) console.log(`spendKey:       derived (from scan key)`);
        if (nk.flags.spendWasOverridden) console.log(`spendKey:       overridden (config mismatch; using derived)`);

        const maxRoleIndex = Math.max(
          1,
          Math.min(Number(process.env.BCH_STEALTH_MAX_ROLE_INDEX ?? 2048) | 0, 65536)
        );

        const listTxidsInWindow = async (): Promise<string[]> => {
          if (singleTxid) return [singleTxid];

          const out: string[] = [];

          const histResp = await client.request(
            'blockchain.rpa.get_history',
            rpaPrefixHex,
            startHeight,
            endHeight + 1
          );

          const hist = unwrapRpcValue<unknown>(histResp, 'scan: rpa.get_history');
          if (!Array.isArray(hist)) {
            const keys = hist && typeof hist === 'object' ? Object.keys(hist as any).join(',') : '';
            throw new Error(
              `scan: rpa.get_history: expected array, got ${typeof hist}${keys ? ` keys=${keys}` : ''}`
            );
          }

          for (const it of hist) {
            const txid = (it as any)?.tx_hash;
            if (typeof txid === 'string' && txid.length === 64) out.push(txid);
          }

          if (opts.includeMempool) {
            const mpResp = await client.request('blockchain.rpa.get_mempool', rpaPrefixHex);
            const mp = unwrapRpcValue<unknown>(mpResp, 'scan: rpa.get_mempool');

            if (!Array.isArray(mp)) {
              const keys = mp && typeof mp === 'object' ? Object.keys(mp as any).join(',') : '';
              throw new Error(
                `scan: rpa.get_mempool: expected array, got ${typeof mp}${keys ? ` keys=${keys}` : ''}`
              );
            }

            for (const it of mp) {
              const txid = (it as any)?.tx_hash;
              if (typeof txid === 'string' && txid.length === 64) out.push(txid);
            }
          }

          return Array.from(new Set(out));
        };

        const candidateTxids = await listTxidsInWindow();

        // --- fetch progress indicator ---
        let fetched = 0;
        const total = candidateTxids.length;
        const tickFetch = () => {
          process.stderr.write(`\rscan: fetching raw tx ${fetched}/${total}...`);
        };
        const doneFetch = () => {
          if (total > 0) process.stderr.write(`\rscan: fetching raw tx ${total}/${total}... done\n`);
        };

        const fetchRawTxHex = async (txid: string): Promise<string> => {
          fetched++;
          if (total > 0 && (fetched === 1 || fetched === total || fetched % 25 === 0)) tickFetch();

          // Try non-verbose raw first
          let resp: any = await client.request('blockchain.transaction.get', txid, false);

          // Fulcrum sometimes returns an object (verbose) with .hex even when false-ish
          try {
            const rawHex = normalizeHexString(resp, 'scan: transaction.get');
            if (rawHex.length % 2 !== 0) throw new Error(`scan: invalid rawtx hex length for ${txid}`);
            return rawHex;
          } catch {
            // retry below
          }

          // Some servers accept 0
          resp = await client.request('blockchain.transaction.get', txid, 0);

          const rawHex = normalizeHexString(resp, 'scan: transaction.get');
          if (rawHex.length % 2 !== 0) throw new Error(`scan: invalid rawtx hex length for ${txid}`);
          return rawHex;
        };

        if (all) {
          console.log(`candidateTxids(sample):`);
          for (const t of candidateTxids.slice(0, 20)) console.log(`  ${t}`);
        }

        console.log(`network:        ${String(NETWORK)}`);
        console.log(`profile:        ${profile}`);
        console.log(`tipHeight:      ${tipHeight}`);
        console.log(`startHeight:    ${startHeight}`);
        console.log(`endHeight:      ${endHeight}`);
        console.log(`rpaPrefixHex:   ${rpaPrefixHex}`);
        if (singleTxid) console.log(`txid:           ${singleTxid}`);
        console.log(`candidates:     ${candidateTxids.length}`);
        console.log(`updateState:    ${opts.updateState ? 'yes' : 'no'}`);

        // ✅ NEW: indexHints + stopOnFirstMatch wiring
        const discoveredRaw = await scanChainWindowAny({
          startHeight,
          endHeight,
          scanPrivBytes: receiverScanPriv32,
          spendPrivBytes: receiverSpendPriv32,
          maxRoleIndex,

          indexHints,
          stopOnFirstMatch: !!singleTxid,

          listTxidsInWindow: async () => candidateTxids,
          fetchRawTxHex,
        });

        doneFetch();

        const discovered = dedupeByOutpoint(discoveredRaw as any[]);
        console.log(`found:          ${discovered.length}`);

        // Optional detailed output for --all (preserve "internals" feature)
        if (all && discovered.length > 0) {
          for (const r of discovered as any[]) {
            const h160 = String(r?.hash160Hex ?? '');
            const addr =
              h160 && /^[0-9a-f]{40}$/i.test(h160) ? p2pkhCashaddrFromHash160Hex(NETWORK, h160) : '';
            if (h160) console.log(`  hash160: ${h160}${addr ? ` (${addr})` : ''}`);
            if (r?.rpaContext) console.log(`  rpaContext: ${JSON.stringify(r.rpaContext)}`);
          }
        }

        // ---------------------------------------------------------------------
        // Update state (create file if missing)
        // ---------------------------------------------------------------------
        if (!opts.updateState) return;

        ensureDirForFile(stateFile);

        // ✅ Reuse already-read JSON (so hints + merge are consistent)
        const existing = existingStateJson;

        // Safety guard: refuse cross-profile writes (helps prevent silent corruption)
        const ownerHint = detectOwnerHint(existing);
        if (ownerHint && ownerHint !== profile) {
          throw new Error(
            `scan: refusing to write: state file appears to belong to another profile.\n` +
              `  resolvedProfile=${profile}\n` +
              `  stateOwnerHint=${ownerHint}\n` +
              `  stateFile=${stateFile}`
          );
        }

        const poolContainer = getPoolStateStealthUtxosContainer(existing);
        const targetRoot = poolContainer ? poolContainer.root : existing;
        const targetKey = poolContainer ? poolContainer.key : ('stealthUtxos' as const);

        const existingRecords = coerceArray<StealthUtxoRecord>(targetRoot[targetKey]);

        // merge + dedupe
        const merged = dedupeByOutpoint<StealthUtxoRecord>([
          ...existingRecords,
          ...(discovered as any as StealthUtxoRecord[]),
        ]);

        // Ensure owner tag is set for newly added records (do NOT overwrite if present)
        for (const r of merged as any[]) {
          if (!r.owner) r.owner = profile;
        }

        targetRoot[targetKey] = merged;

        // Prevent split-brain legacy field if needed
        if (poolContainer && Array.isArray((existing as any).stealthUtxos)) {
          delete (existing as any).stealthUtxos;
        }

        // Make sure top-level envelope timestamps exist if you use them
        (existing as any).updatedAt = new Date().toISOString();
        if (!(existing as any).schemaVersion) (existing as any).schemaVersion = 1;

        writeJsonPretty(stateFile, existing);

        console.log('');
        console.log(`stateFile:      ${stateFile}`);
        console.log(`stateUtxos:     ${merged.length}`);
      } finally {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
      }
    });
}