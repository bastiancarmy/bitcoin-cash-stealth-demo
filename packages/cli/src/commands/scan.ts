// packages/cli/src/commands/scan.ts
//
// Single-source-of-truth update:
// - indexHints and update-state now go through pool-state store helpers (no raw JSON writes).
// - scan logic remains unchanged otherwise.

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

  const keys =
    value && typeof value === 'object' ? ` keys=${Object.keys(value as any).join(',')}` : '';
  throw new Error(`${label}: expected hex string/bytes, got ${typeof value}.${keys}`);
}

function unwrapRpcValue<T = unknown>(v: unknown, label: string): T {
  if (v instanceof Error) throw new Error(`${label}: electrum returned Error: ${v.message}`);
  if (v && typeof v === 'object' && (v as any).error) {
    const msg =
      (v as any).error?.message ?? (v as any).error?.error ?? JSON.stringify((v as any).error);
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

  // Cashaddr -> 1 byte prefix from hash160
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
    .action(async (opts: ScanFlags, cmd: any) => {
      const me = await deps.loadMeWallet();
      const all = !!opts.all;

      const ap = deps.getActivePaths();
      const { profile, stateFile } = resolveProfileAndStateFile(program, ap, cmd);

      // ✅ Single source of truth: use store/state for indexHints too
      const store0 = new FileBackedPoolStateStore({ filename: stateFile });
      const st0 = await loadStateOrEmpty({ store: store0, networkDefault: String(NETWORK) });

      const existingRecords0 = Array.isArray(st0.stealthUtxos) ? st0.stealthUtxos : [];

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
          : (opts.rpaPrefix ? normalizeRpaPrefixHexOrThrow(opts) : deriveWalletDefaultRpaPrefixHex(receiverScanPriv32));

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
        console.log(`rpaPrefixHex:   ${rpaPrefixHex}`);
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

        // ✅ Load canonical state (again) using a fresh store instance (safe, avoids any tool caching assumptions)
        const store = new FileBackedPoolStateStore({ filename: stateFile });
        const st = await loadStateOrEmpty({ store, networkDefault: String(NETWORK) });

        // Safety guard: refuse cross-profile writes
        const ownerHint = detectOwnerHintFromPoolState(st);
        if (ownerHint && ownerHint !== profile) {
          throw new Error(
            `scan: refusing to write: state file appears to belong to another profile.\n` +
              `  resolvedProfile=${profile}\n` +
              `  stateOwnerHint=${ownerHint}\n` +
              `  stateFile=${stateFile}`
          );
        }

        // Merge discovered into canonical list
        for (const recAny of discovered as any[]) {
          const rec = recAny as StealthUtxoRecord;

          // Ensure owner tag for new records (do NOT overwrite if present)
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