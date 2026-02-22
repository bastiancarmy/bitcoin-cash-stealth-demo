// packages/cli/src/commands/scan.ts
//
// Single-source-of-truth update:
// - indexHints and update-state now go through pool-state store helpers (no raw JSON writes).
// - scan logic updated to respect Fulcrum rpa_history_blocks limit by chunking get_history calls.
// - default scan startHeight uses wallet birthdayHeight when available.
// - robust prefix strategy:
//   (1) query derived default prefix (fast path)
//   (2) query 1-byte prefix fallback (prefix_bits_min=8)
//   (3) if still no candidates, bounded brute sweep of all 256 8-bit prefixes in last N blocks
//       (N = BCH_STEALTH_SCAN_SWEEP_BLOCKS, default 600) to guarantee discovery.

import type { Command } from 'commander';

import fs from 'node:fs';
import path from 'node:path';

import { connectElectrum as connectElectrumDefault } from '@bch-stealth/electrum';
import { scanChainWindow as scanChainWindowDefault } from '@bch-stealth/rpa-scan';
import { NETWORK } from '../config.js';
import type { LoadedWallet } from '../wallets.js';

import type { StealthUtxoRecord } from '@bch-stealth/pool-state';
import { FileBackedPoolStateStore, upsertStealthUtxo } from '@bch-stealth/pool-state';

import { hexToBytes, bytesToHex, encodeCashAddr, decodeCashAddress, sha256, concat } from '@bch-stealth/utils';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { normalizeWalletKeys, debugPrintKeyFlags } from '../wallet/normalizeKeys.js';
import { loadStateOrEmpty, saveState } from '../pool/state.js';

import { decodePaycode } from '../paycodes.js';

type ScanFlags = {
  sinceHeight?: number;
  window?: number;
  updateState?: boolean;
  rpaPrefix?: string;
  includeMempool?: boolean;
  all?: boolean;
  txid?: string;
};

function ensureDirForFile(filePath: string) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
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

// ✅ Robust normalization for Electrum/Fulcrum responses.
function normalizeHexString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (value instanceof String) return String(value.valueOf());

  const anyVal: any = value as any;
  if (anyVal && typeof anyVal === 'object') {
    const fieldCandidates = ['hex', 'raw', 'result', 'data', 'tx', 'transaction'];
    for (const k of fieldCandidates) {
      if (k in anyVal) {
        const v = anyVal[k];
        if (typeof v === 'string') return v;
        if (v instanceof Uint8Array) return bytesToHex(v);
        if (v instanceof String) return String(v.valueOf());
      }
    }
    if (anyVal instanceof ArrayBuffer) return bytesToHex(new Uint8Array(anyVal));
    if (anyVal?.buffer instanceof ArrayBuffer && typeof anyVal?.byteLength === 'number') {
      try {
        return bytesToHex(new Uint8Array(anyVal.buffer, anyVal.byteOffset ?? 0, anyVal.byteLength));
      } catch {
        // ignore
      }
    }
  }

  const keys = value && typeof value === 'object' ? ` keys=${Object.keys(value as any).join(',')}` : '';
  throw new Error(`${label}: expected hex string/bytes, got ${typeof value}.${keys}`);
}

function unwrapRpcValue<T = unknown>(v: unknown, label: string): T {
  if (v instanceof Error) throw new Error(`${label}: electrum returned Error: ${v.message}`);
  if (v && typeof v === 'object' && (v as any).error) {
    const msg = (v as any).error?.message ?? (v as any).error?.error ?? JSON.stringify((v as any).error);
    throw new Error(`${label}: electrum returned error: ${msg}`);
  }
  return v as T;
}

async function getTipHeight(client: any): Promise<number> {
  const parseHeight = (r: any): number | null => {
    if (r == null) return null;
    if (typeof r === 'number' && Number.isFinite(r)) return r;

    if (typeof r === 'object') {
      if (r.height != null) {
        const h = Number(r.height);
        return Number.isFinite(h) ? h : null;
      }
      if (r.block_height != null) {
        const h = Number(r.block_height);
        return Number.isFinite(h) ? h : null;
      }
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

  // Prefer Fulcrum method (0 params)
  const h1 = await tryCall(() => client.request('blockchain.headers.get_tip'));
  if (h1 != null) return h1;

  // Fallback: subscribe (0 params)
  const h2 = await tryCall(() => client.request('blockchain.headers.subscribe'));
  if (h2 != null) return h2;

  throw new Error('scan: could not determine chain tip height from electrum server');
}

function cleanHexPrefix(s: string): string {
  const x = s.startsWith('0x') ? s.slice(2) : s;
  return x.trim().toLowerCase();
}

function tryGetPaycodePub33FromMe(me: any): Uint8Array | null {
  const pm =
    (typeof me?.selfPaycode === 'string' && me.selfPaycode.startsWith('PM') ? me.selfPaycode : null) ??
    (typeof me?.paycode === 'string' && me.paycode.startsWith('PM') ? me.paycode : null) ??
    (typeof me?.wallet?.paycode === 'string' && me.wallet.paycode.startsWith('PM') ? me.wallet.paycode : null);

  if (!pm) return null;

  try {
    const d: any = decodePaycode(pm);
    const pub = d?.pubkey33;
    return pub instanceof Uint8Array && pub.length === 33 ? pub : null;
  } catch {
    return null;
  }
}

function parseTxidOrThrow(raw: unknown): string {
  const txid = String(raw ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error(`scan: --txid must be a 64-char hex txid (got "${String(raw ?? '')}")`);
  }
  return txid;
}

const P2PKH_SCRIPT_PREFIX_HEX = '76a914';

function normalizeRpaPrefixHexOrThrow(opts: ScanFlags): string {
  const raw = String(opts.rpaPrefix ?? '').trim();
  if (!raw) {
    throw new Error(
      'scan: missing --rpa-prefix <cashaddr|hex>\n' +
        'Tip: pass 1–2 bytes of expected RPA prefix (server expects 2–4 hex chars).\n' +
        'You may also pass a cashaddr; it will be decoded.\n' +
        'You may also pass a script prefix like "76a91456"; we will extract "56".'
    );
  }

  // Cashaddr -> 1 byte prefix from hash160 (legacy helper; ok as user input)
  if (raw.includes(':')) {
    const decoded: any = decodeCashAddress(raw);
    const h: unknown = decoded?.hash;
    const type: unknown = decoded?.type;

    if (type !== 'P2PKH') throw new Error(`scan: --rpa-prefix cashaddr must be P2PKH (got ${String(type ?? 'unknown')})`);
    if (!(h instanceof Uint8Array) || h.length !== 20) throw new Error('scan: --rpa-prefix cashaddr decode failed (expected 20-byte hash160)');

    return bytesToHex(h.slice(0, 1)).toLowerCase();
  }

  const p0 = cleanHexPrefix(raw);
  if (!/^[0-9a-f]+$/.test(p0)) throw new Error('scan: --rpa-prefix must be hex or cashaddr');
  if (p0.length % 2 !== 0) throw new Error('scan: --rpa-prefix must have even hex length (whole bytes)');

  let p = p0.toLowerCase();
  if (p.startsWith(P2PKH_SCRIPT_PREFIX_HEX)) p = p.slice(P2PKH_SCRIPT_PREFIX_HEX.length);

  if (p.length < 2) throw new Error('scan: --rpa-prefix must be at least 1 byte (2 hex chars)');
  if (p.length > 4) p = p.slice(0, 4);
  if (p.length !== 2 && p.length !== 4) throw new Error('scan: --rpa-prefix must resolve to 1–2 bytes (2–4 hex chars)');

  return p;
}

// Spec-aligned default RPA prefix derivation.
// Prefer the wallet's paycode scan pubkey (pub33) if available, because
// it is the canonical identity key used by send(paycode) and avoids
// "config mismatch" paths selecting the wrong privkey.
//
// Spec rule (prefix_bits=16): prefix16 = scanPub33[1..3] (skip 02/03).
// Fallback: derive scanPub33 from scanPriv32 and apply same rule.
function deriveWalletDefaultRpaPrefix16Hex(args: {
  scanPriv32: Uint8Array;
  paycodePub33?: Uint8Array | null;
}): string {
  const payPub = args.paycodePub33;
  if (payPub instanceof Uint8Array && payPub.length === 33) {
    return bytesToHex(payPub.slice(1, 3)).toLowerCase();
  }

  const Q = secp256k1.getPublicKey(args.scanPriv32, true); // 33
  if (!(Q instanceof Uint8Array) || Q.length !== 33) {
    throw new Error('scan: failed to derive scan pubkey (expected 33 bytes)');
  }
  return bytesToHex(Q.slice(1, 3)).toLowerCase();
}

function cashaddrPrefixFromNetwork(network: string): 'bitcoincash' | 'bchtest' {
  const n = String(network ?? '').toLowerCase();
  return n === 'mainnet' ? 'bitcoincash' : 'bchtest';
}

function p2pkhCashaddrFromHash160Hex(network: string, h160Hex: string): string {
  return encodeCashAddr(cashaddrPrefixFromNetwork(network), 'P2PKH', hexToBytes(h160Hex));
}

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

function detectOwnerHintFromPoolState(st: any): string | null {
  try {
    const a = st?.restoreHints?.ownerTag;
    if (typeof a === 'string' && a.trim()) return a.trim();

    const u0 = st?.stealthUtxos?.[0]?.owner;
    if (typeof u0 === 'string' && u0.trim()) return u0.trim();
  } catch {
    // ignore
  }
  return null;
}

function asInt(x: unknown, dflt: number): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

function parseBoolishEnv(name: string, dflt: boolean): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return dflt;
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

async function getRpaHistoryBlocksLimit(client: any): Promise<number> {
  // Prefer server.features.rpa.history_block_limit if available; else 60.
  try {
    const features = await client.request('server.features');
    const lim = Number((features as any)?.rpa?.history_block_limit);
    if (Number.isFinite(lim) && lim > 0) return Math.max(10, Math.min(lim | 0, 2000));
  } catch {
    // ignore
  }
  const env = asInt(process.env.BCH_STEALTH_RPA_HISTORY_BLOCKS, 60);
  return Math.max(10, Math.min(env | 0, 2000));
}

/**
 * Chunk rpa.get_history to respect Fulcrum rpa_history_blocks (default 60)
 */
async function getRpaHistoryChunked(args: {
  client: any;
  prefix: string;
  startHeight: number;
  endHeightInclusive: number;
  limit: number;
  debug?: boolean;
}): Promise<string[]> {
  const { client, prefix, startHeight, endHeightInclusive, limit, debug } = args;

  const endExclusive = endHeightInclusive + 1;
  const out: string[] = [];

  for (let a = startHeight; a < endExclusive; a += limit) {
    const b = Math.min(endExclusive, a + limit);
    const resp = await client.request('blockchain.rpa.get_history', prefix, a, b);
    const hist = unwrapRpcValue<unknown>(resp, `scan: rpa.get_history.${prefix}`);

    if (!Array.isArray(hist)) continue;

    if (debug) console.log(`[scan:debug] rpa.get_history.${prefix} ${a}..${b} len=${hist.length}`);

    for (const it of hist) {
      const txid = (it as any)?.tx_hash;
      if (typeof txid === 'string' && txid.length === 64) out.push(txid);
    }
  }

  return out;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

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
    .option('--rpa-prefix <HEX>', 'RPA prefix hex (server expects 2–4 hex chars, e.g. "c2" or "c272")')
    .option('--include-mempool', 'also scan unconfirmed RPA txs', false)
    .option('--txid <TXID>', 'Scan a single txid (bypasses Fulcrum RPA candidate selection).')
    .option('--all', 'Also print hex internals (hash160 + RPA context fields).', false)
    .action(async (opts: ScanFlags, cmd: any) => {
      const me = await deps.loadMeWallet();
      const all = !!opts.all;

      const ap = deps.getActivePaths();
      const { profile, stateFile } = resolveProfileAndStateFile(program, ap, cmd);

      const store0 = new FileBackedPoolStateStore({ filename: stateFile });
      const st0 = await loadStateOrEmpty({ store: store0, networkDefault: String(NETWORK) });

      const existingRecords0 = Array.isArray(st0.stealthUtxos) ? st0.stealthUtxos : [];

      const lastIdxs = existingRecords0
        .map((r: any) => r?.roleIndex ?? r?.rpaContext?.index)
        .filter((n: any) => Number.isInteger(n) && n >= 0)
        .slice(-8);

      const indexHints = lastIdxs.length ? lastIdxs : null;

      const debugScan = String(process.env.BCH_STEALTH_DEBUG_SCAN ?? '') === '1';

      if (debugScan) {
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
        console.log(`[scan:debug] wallet.birthdayHeight=${String((me as any).birthdayHeight ?? '(none)')}`);
      }

      const electrumAny: { connectElectrum: (args: { network: string }) => Promise<any> } =
        deps.electrum ??
        ({
          connectElectrum: async ({ network }: { network: string }) => connectElectrumDefault(network as any),
        } as const);

      const scanChainWindowAny: any = deps.scanChainWindow ?? scanChainWindowDefault;

      const client = await electrumAny.connectElectrum({ network: NETWORK });

      try {
        const tipHeight = await getTipHeight(client);
        const historyLimit = await getRpaHistoryBlocksLimit(client);

        const birthdayHeight = Number((me as any).birthdayHeight ?? (me as any).wallet?.birthdayHeight ?? 0) || 0;
        let startHeight = birthdayHeight || 0;

        if (opts.sinceHeight != null && Number.isFinite(opts.sinceHeight)) {
          startHeight = Math.max(0, Math.floor(opts.sinceHeight));
        } else if (opts.window != null && Number.isFinite(opts.window)) {
          const w = Math.max(1, Math.floor(opts.window));
          startHeight = Math.max(0, tipHeight - w + 1);
        }

        const endHeight = tipHeight;
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

        if (nk.flags.spendWasDerived) console.log(`spendKey:       derived (from scan key)`);
        if (nk.flags.spendWasOverridden) console.log(`spendKey:       overridden (config mismatch; using derived)`);

        const maxRoleIndex = Math.max(1, Math.min(Number(process.env.BCH_STEALTH_MAX_ROLE_INDEX ?? 2048) | 0, 65536));

        const payPub33 = tryGetPaycodePub33FromMe(me);
        const derived16 = deriveWalletDefaultRpaPrefix16Hex({
          scanPriv32: receiverScanPriv32,
          paycodePub33: payPub33 ?? ((me as any).paycodePub33 ?? (me as any).wallet?.paycodePub33 ?? null),
        });
        const derived8 = derived16.slice(0, 2);
        if (debugScan) console.log(`[scan:debug] derived16=${derived16} derived8=${derived16.slice(0,2)}`);
        
        const brute8Enabled = parseBoolishEnv('BCH_STEALTH_SCAN_BRUTE8', false);
        const sweepBlocks = Math.max(60, Math.min(asInt(process.env.BCH_STEALTH_SCAN_SWEEP_BLOCKS, 600) | 0, 5000));
        const bruteStartHeight = Math.max(0, endHeight - sweepBlocks + 1);

        const listTxidsInWindow = async (): Promise<string[]> => {
          if (singleTxid) return [singleTxid];

          // Explicit prefix mode: only query what user asked for
          if (opts.rpaPrefix) {
            const p = normalizeRpaPrefixHexOrThrow(opts);
            const histTxids = await getRpaHistoryChunked({
              client,
              prefix: p,
              startHeight,
              endHeightInclusive: endHeight,
              limit: historyLimit,
              debug: debugScan,
            });

            const out = [...histTxids];

            if (opts.includeMempool) {
              const mpResp = await client.request('blockchain.rpa.get_mempool', p);
              const mp = unwrapRpcValue<unknown>(mpResp, `scan: rpa.get_mempool.${p}`);
              if (Array.isArray(mp)) {
                if (debugScan) console.log(`[scan:debug] rpa.get_mempool.${p} len=${mp.length}`);
                for (const it of mp) {
                  const txid = (it as any)?.tx_hash;
                  if (typeof txid === 'string' && txid.length === 64) out.push(txid);
                }
              }
            }

            return Array.from(new Set(out));
          }

          // -------------------------------------------------------------------
          // Default mode:
          // (1) Derived fast path (16-bit + 8-bit)
          // (2) Optional brute8 sweep MERGED with fast results (not fallback-only)
          // -------------------------------------------------------------------

          // Phase 2 default: 8-bit only for performance and to match send default.
          const prefixesToTry = [derived8];

          const out: string[] = [];
          for (const p of prefixesToTry) {
            const histTxids = await getRpaHistoryChunked({
              client,
              prefix: p,
              startHeight,
              endHeightInclusive: endHeight,
              limit: historyLimit,
              debug: debugScan,
            });
            out.push(...histTxids);

            if (opts.includeMempool) {
              const mpResp = await client.request('blockchain.rpa.get_mempool', p);
              const mp = unwrapRpcValue<unknown>(mpResp, `scan: rpa.get_mempool.${p}`);
              if (Array.isArray(mp)) {
                if (debugScan) console.log(`[scan:debug] rpa.get_mempool.${p} len=${mp.length}`);
                for (const it of mp) {
                  const txid = (it as any)?.tx_hash;
                  if (typeof txid === 'string' && txid.length === 64) out.push(txid);
                }
              }
            }
          }

          const uniqFast = Array.from(new Set(out));
          if (debugScan) console.log(`[scan:debug] fast candidates=${uniqFast.length} (prefixes=${derived8})`);

          // MERGE brute8 results if enabled
          if (!brute8Enabled) return uniqFast;

          if (debugScan) {
            console.log(`[scan:debug] brute8 sweep enabled (merge)`);
            console.log(`[scan:debug] brute8 range=${bruteStartHeight}..${endHeight} (limit=${historyLimit} blocks/call)`);
          }

          const bruteOut: string[] = [];

          for (let i = 0; i < 256; i++) {
            const p = hex2(i);

            const histTxids = await getRpaHistoryChunked({
              client,
              prefix: p,
              startHeight: bruteStartHeight,
              endHeightInclusive: endHeight,
              limit: historyLimit,
              debug: false,
            });
            bruteOut.push(...histTxids);

            if (opts.includeMempool) {
              try {
                const mpResp = await client.request('blockchain.rpa.get_mempool', p);
                const mp = unwrapRpcValue<unknown>(mpResp, `scan: rpa.get_mempool.${p}`);
                if (Array.isArray(mp)) {
                  for (const it of mp) {
                    const txid = (it as any)?.tx_hash;
                    if (typeof txid === 'string' && txid.length === 64) bruteOut.push(txid);
                  }
                }
              } catch {
                // ignore per-prefix failures
              }
            }

            if (debugScan && i % 32 === 0) {
              process.stderr.write(`\r[scan:debug] brute8 progress ${i}/256...`);
            }
          }

          if (debugScan) process.stderr.write(`\r[scan:debug] brute8 progress 256/256...\n`);

          const uniqBrute = Array.from(new Set(bruteOut));
          if (debugScan) console.log(`[scan:debug] brute8 candidates=${uniqBrute.length}`);

          const merged = Array.from(new Set([...uniqFast, ...uniqBrute]));
          if (debugScan) console.log(`[scan:debug] merged candidates=${merged.length}`);

          // after merged is computed, before return merged;
          const wantTx = String(process.env.BCH_STEALTH_DEBUG_WANT_TXID ?? '').trim().toLowerCase();
          if (debugScan && wantTx && /^[0-9a-f]{64}$/.test(wantTx)) {
            const has = merged.includes(wantTx);
            console.log(`[scan:debug] contains(${wantTx.slice(0, 8)}…)= ${has}`);
          }

          return merged;
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

          let resp: any = await client.request('blockchain.transaction.get', txid, false);

          try {
            const rawHex = normalizeHexString(resp, 'scan: transaction.get');
            if (rawHex.length % 2 !== 0) throw new Error(`scan: invalid rawtx hex length for ${txid}`);
            return rawHex;
          } catch {
            // retry below
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
        if (opts.rpaPrefix) console.log(`rpaPrefixHex:   ${normalizeRpaPrefixHexOrThrow(opts)}`);
        else console.log(`rpaPrefixHex:   ${derived8} (phase2 default${brute8Enabled ? ', brute8' : ''})`);
        if (singleTxid) console.log(`txid:           ${singleTxid}`);
        console.log(`candidates:     ${candidateTxids.length}`);
        console.log(`updateState:    ${opts.updateState ? 'yes' : 'no'}`);

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

        if (all && discovered.length > 0) {
          for (const r of discovered as any[]) {
            const h160 = String(r?.hash160Hex ?? '');
            const addr = h160 && /^[0-9a-f]{40}$/i.test(h160) ? p2pkhCashaddrFromHash160Hex(NETWORK, h160) : '';
            if (h160) console.log(`  hash160: ${h160}${addr ? ` (${addr})` : ''}`);
            if (r?.rpaContext) console.log(`  rpaContext: ${JSON.stringify(r.rpaContext)}`);
          }
        }

        if (!opts.updateState) return;

        ensureDirForFile(stateFile);

        const store = new FileBackedPoolStateStore({ filename: stateFile });
        const st = await loadStateOrEmpty({ store, networkDefault: String(NETWORK) });

        const ownerHint = detectOwnerHintFromPoolState(st);
        if (ownerHint && ownerHint !== profile) {
          throw new Error(
            `scan: refusing to write: state file appears to belong to another profile.\n` +
              `  resolvedProfile=${profile}\n` +
              `  stateOwnerHint=${ownerHint}\n` +
              `  stateFile=${stateFile}`
          );
        }

        for (const recAny of discovered as any[]) {
          const rec = recAny as StealthUtxoRecord;
          if (!(rec as any).owner) (rec as any).owner = profile;
          upsertStealthUtxo(st, rec);
        }

        await saveState({ store, state: st, networkDefault: String(NETWORK) });

        console.log('');
        console.log(`stateFile:      ${stateFile}`);
        console.log(`stateUtxos:     ${Array.isArray(st.stealthUtxos) ? st.stealthUtxos.length : 0}`);
      } finally {
        try {
          await client.disconnect();
        } catch {
          // ignore
        }
      }
    });
}