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

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

import * as Electrum from '@bch-stealth/electrum';
import { NETWORK } from '../config.js';
import type { LoadedWallet } from '../wallets.js';

import { scanChainWindow } from '@bch-stealth/rpa-scan';
import type { StealthUtxoRecord } from '@bch-stealth/pool-state';
import {
  hexToBytes,
  bytesToHex,
  encodeCashAddr,
  decodeCashAddress,
  sha256,
  concat,
} from '@bch-stealth/utils';
import { deriveSpendPriv32FromScanPriv32 } from '@bch-stealth/rpa-derive';
import { secp256k1 } from '@noble/curves/secp256k1.js';

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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
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

function dedupeByOutpoint<T extends any>(records: T[]): T[] {
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

export function registerScanCommand(
  program: Command,
  deps: {
    loadMeWallet: () => Promise<LoadedWallet>;
    getActivePaths: () => { profile: string; stateFile: string };
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
    .action(async (opts: ScanFlags) => {
      const me = await deps.loadMeWallet();
      const { profile, stateFile } = deps.getActivePaths();
      const all = !!opts.all;

      const electrum: any = Electrum as any;
      const client = await electrum.connectElectrum({ network: NETWORK });

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
        let scanPrivBytes: Uint8Array | undefined = (me as any).scanPrivBytes;
        let spendPrivBytes: Uint8Array | undefined = (me as any).spendPrivBytes;

        if (!scanPrivBytes) {
          const scanPrivHex: string | undefined =
            (me as any).wallet?.scanPrivHex ?? (me as any).scanPrivHex;
          if (typeof scanPrivHex === 'string' && scanPrivHex.trim()) {
            scanPrivBytes = hexToBytes(scanPrivHex.trim());
          }
        }

        if (!spendPrivBytes) {
          const spendPrivHex: string | undefined =
            (me as any).wallet?.spendPrivHex ?? (me as any).spendPrivHex;
          if (typeof spendPrivHex === 'string' && spendPrivHex.trim()) {
            spendPrivBytes = hexToBytes(spendPrivHex.trim());
          }
        }

        if (!scanPrivBytes) {
          throw new Error(
            'scan: wallet is missing scanPrivBytes.\n' +
              `Fix: run "bchctl --profile ${profile} wallet init --force" (or migrate config to include scan/spend keys).`
          );
        }

        if (scanPrivBytes.length !== 32) throw new Error('scan: scanPrivBytes must be 32 bytes');

        // rpaPrefixHex (server expects 2–4 hex chars) — chosen after scanPrivBytes is known
        const rpaPrefixHex: string = singleTxid
          ? (opts.rpaPrefix ? normalizeRpaPrefixHexOrThrow(opts) : '(none)')
          : (opts.rpaPrefix
              ? normalizeRpaPrefixHexOrThrow(opts)
              : deriveWalletDefaultRpaPrefixHex(scanPrivBytes));

        let spendWasDerived = false;
        let spendWasOverridden = false;

        const derivedSpendPriv = deriveSpendPriv32FromScanPriv32(scanPrivBytes);

        if (!(spendPrivBytes instanceof Uint8Array) || spendPrivBytes.length !== 32) {
          spendPrivBytes = derivedSpendPriv;
          spendWasDerived = true;
        } else {
          const provided = bytesToHex(spendPrivBytes);
          const expected = bytesToHex(derivedSpendPriv);

          if (provided.toLowerCase() !== expected.toLowerCase()) {
            spendPrivBytes = derivedSpendPriv;
            spendWasOverridden = true;
          }
        }

        if (spendPrivBytes.length !== 32) throw new Error('scan: spendPrivBytes must be 32 bytes');

        // IMPORTANT: must cover sender grind range.
        // If Alice uses --grind-max 2048, Bob must scan >= 2048.
        const maxRoleIndex = 2048;

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

        // --- small UX progress indicator (fetch stage) ---
        let fetched = 0;
        const total = candidateTxids.length;
        const tickFetch = () => {
          // stderr so piping stdout works
          process.stderr.write(`\rscan: fetching raw tx ${fetched}/${total}...`);
        };
        const doneFetch = () => {
          if (total > 0) process.stderr.write(`\rscan: fetching raw tx ${total}/${total}... done\n`);
        };

        const fetchRawTxHex = async (txid: string): Promise<string> => {
          fetched++;
          if (total > 0 && (fetched === 1 || fetched === total || fetched % 25 === 0)) tickFetch();

          // Try non-verbose first
          let resp: any = await client.request('blockchain.transaction.get', txid, false);

          // Some servers behave better with 0/1 than booleans
          try {
            const rawHex = normalizeHexString(resp, 'scan: transaction.get');
            if (rawHex.length % 2 !== 0) throw new Error(`scan: invalid rawtx hex length for ${txid}`);
            return rawHex;
          } catch {
            // retry
          }

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
        if (spendWasDerived) console.log(`spendKey:       derived (from scan key)`);
        if (spendWasOverridden) console.log(`spendKey:       overridden (config mismatch; using derived)`);

        const discoveredRaw = await scanChainWindow({
          startHeight,
          endHeight,
          scanPrivBytes,
          spendPrivBytes,
          maxRoleIndex,
          listTxidsInWindow: async () => candidateTxids,
          fetchRawTxHex,
        });

        doneFetch();

        // ✅ DEDUPE ALWAYS (print + write use the same set)
        const discovered = dedupeByOutpoint(discoveredRaw as any[]);

        console.log(`found:          ${discovered.length}`);

        for (const r of discovered as any[]) {
          const txid = r.txid ?? r.txidHex;
          const vout = r.vout ?? r.n;
          const valueSats = r.valueSats ?? r.sats;

          const h160Hex: string | undefined =
            r.hash160Hex ?? r.destHash160Hex ?? (typeof r.hash160 === 'string' ? r.hash160 : undefined);

          console.log('');
          console.log(`outpoint:       ${txid}:${vout}`);
          console.log(`valueSats:      ${String(valueSats)}`);

          if (typeof h160Hex === 'string' && h160Hex.length === 40) {
            const addr = p2pkhCashaddrFromHash160Hex(String(NETWORK), h160Hex);
            console.log(`address:        ${addr}`);
            if (all) console.log(`hash160Hex:     ${h160Hex}`);
          } else if (all && h160Hex) {
            console.log(`hash160Hex:     ${String(h160Hex)}`);
          }

          if (all) {
            const ctx = r.rpaContext;
            if (ctx) {
              const senderPub33Hex =
                (ctx as any).senderPub33Hex ??
                ((ctx as any).senderPub33 ? bytesToHex((ctx as any).senderPub33) : undefined);

              const prevoutTxidHex = (ctx as any).prevoutTxidHex ?? (ctx as any).prevoutHashHex;

              if (senderPub33Hex) console.log(`senderPub33Hex: ${senderPub33Hex}`);
              if (prevoutTxidHex) console.log(`prevoutTxidHex: ${prevoutTxidHex}`);
              if ((ctx as any).prevoutN != null) console.log(`prevoutN:       ${(ctx as any).prevoutN}`);
              if ((ctx as any).index != null) console.log(`index:          ${(ctx as any).index}`);
              if ((ctx as any).mode) console.log(`mode:           ${(ctx as any).mode}`);
              if ((ctx as any).paycodeId != null) console.log(`paycodeId:      ${(ctx as any).paycodeId}`);
            }
          }
        }

        if (!opts.updateState) {
          if (!all) console.log(`\nℹ Tip: add --all to print hash160 + RPA context internals.\n`);
          return;
        }

        // --- Update state ---
        const existing = readJsonOrNull<any>(stateFile) ?? {};
        const poolContainer = getPoolStateStealthUtxosContainer(existing);

        // Choose target location:
        // - pool envelope: data.pool.state.stealthUtxos
        // - legacy scan-only file: top-level stealthUtxos
        const targetRoot = poolContainer ? poolContainer.root : existing;
        const targetKey = poolContainer ? poolContainer.key : ('stealthUtxos' as const);

        const existingRecords: StealthUtxoRecord[] = coerceArray<StealthUtxoRecord>(targetRoot[targetKey]);

        // ✅ DEDUPE BEFORE WRITE TOO (merged)
        const merged = dedupeByOutpoint([...existingRecords, ...(discovered as any[])]);

        targetRoot[targetKey] = merged;

        // Prevent split-brain: if this is a pool envelope, remove legacy top-level field
        if (poolContainer && Array.isArray(existing.stealthUtxos)) {
          delete existing.stealthUtxos;
        }

        existing.updatedAt = new Date().toISOString();
        if (!existing.createdAt) existing.createdAt = existing.updatedAt;

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