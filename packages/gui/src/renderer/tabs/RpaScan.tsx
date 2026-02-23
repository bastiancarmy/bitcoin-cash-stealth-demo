// packages/gui/src/renderer/tabs/RpaScan.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RunResult } from '../hooks/useBchctl';
import { OpStatusBar, type OpStatus } from '../components/OpStatusBar';
import {
  type RpaUtxoRow,
  buildScanInboundArgv,
  buildWalletRpaUtxosArgv,
  parseWalletRpaUtxos,
  formatSats,
  shortHex,
  chipnetTxUrl,
  parseScanProgressChunk,
} from './poolImportModel';

type Props = {
  profile: string;
  run: (args: { label: string; argv: string[]; timeoutMs?: number }) => Promise<RunResult>;
  runFast: (args: { label: string; argv: string[]; timeoutMs?: number }) => Promise<RunResult>;
  refreshNow: () => Promise<void>;
  disableAll: boolean;
};

type TrailItem = {
  ts: number;
  label: string;
  argv: string[];
  code?: number;
  note?: string;
};

function trailKey(profile: string): string {
  const p = String(profile ?? '').trim() || 'default';
  return `bchstealth.rpaScanTrail.v1.${p}`;
}

function lastSeenKey(profile: string): string {
  const p = String(profile ?? '').trim() || 'default';
  return `bchstealth.rpaScanLastSeen.v1.${p}`;
}

function loadTrail(profile: string): TrailItem[] {
  try {
    const raw = sessionStorage.getItem(trailKey(profile));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrailItem[]) : [];
  } catch {
    return [];
  }
}

function saveTrail(profile: string, items: TrailItem[]) {
  try {
    sessionStorage.setItem(trailKey(profile), JSON.stringify(items.slice(-50)));
  } catch {
    // ignore
  }
}

function loadLastSeen(profile: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(lastSeenKey(profile));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((x) => String(x)));
  } catch {
    return new Set();
  }
}

function saveLastSeen(profile: string, outpoints: string[]) {
  try {
    sessionStorage.setItem(lastSeenKey(profile), JSON.stringify(outpoints.slice(-2000)));
  } catch {
    // ignore
  }
}

function argvToString(argv: string[]): string {
  return argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ');
}

function shortOutpoint(op: string): string {
  const s = String(op ?? '');
  const tx = s.slice(0, 8);
  return tx ? `${tx}…` : s;
}

function kindText(k?: string): string {
  const s = String(k ?? '').trim();
  return s || '(none)';
}

export function RpaScanTab(props: Props) {
  const { profile, runFast, refreshNow, disableAll } = props;

  const [busy, setBusy] = useState(false);

  // keep it simple and aligned with phase2
  const [includeMempool] = useState(true);
  const [updateState] = useState(true);

  const [status, setStatus] = useState<OpStatus>({
    kind: 'idle',
    title: 'Ready',
    detail: 'Click “Scan inbound” to discover new stealth UTXOs.',
    progress: null,
  });

  const [utxos, setUtxos] = useState<RpaUtxoRow[]>([]);
  const [newSince, setNewSince] = useState<RpaUtxoRow[]>([]);

  // per-profile command trail
  const [trail, setTrail] = useState<TrailItem[]>(() => loadTrail(profile));
  useEffect(() => {
    setTrail(loadTrail(profile));
    // reset view on profile switch
    setUtxos([]);
    setNewSince([]);
    setStatus({
      kind: 'idle',
      title: 'Ready',
      detail: 'Click “Scan inbound” to discover new stealth UTXOs.',
      progress: null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const pushTrail = (it: TrailItem) => {
    setTrail((cur: TrailItem[]) => {
      const next = [...cur, it].slice(-50);
      saveTrail(profile, next);
      return next;
    });
  };

  const clearTrail = () => {
    setTrail([]);
    saveTrail(profile, []);
  };

  // scan progress opId (best-effort: depends on chunks timing)
  const scanOpIdRef = useRef<string | null>(null);

  // Best-effort live scan progress from streamed stderr chunks.
  useEffect(() => {
    const off = window.bchStealth.onBchctlChunk((m) => {
      const scanOpId = scanOpIdRef.current;
      if (!scanOpId) return;
      if (m.opId !== scanOpId) return;

      const evt = parseScanProgressChunk(m.chunk ?? '');
      if (!evt) return;

      if (evt.kind === 'progress') {
        setStatus((cur: OpStatus) => ({
          ...cur,
          kind: 'running',
          title: cur.title || 'Scanning inbound…',
          detail: `Fetching raw tx ${evt.cur}/${evt.total}…`,
          progress: { cur: evt.cur, total: evt.total },
        }));
      } else if (evt.kind === 'done') {
        setStatus((cur: OpStatus) => ({
          ...cur,
          kind: 'running',
          title: cur.title || 'Scanning inbound…',
          detail: 'Scan completed. Finalizing…',
          progress: cur.progress ?? null,
        }));
      } else if (evt.kind === 'found') {
        setStatus((cur: OpStatus) => ({
          ...cur,
          kind: 'running',
          title: 'Scan complete',
          detail: `Found ${evt.found} inbound candidates.`,
          progress: null,
        }));
      }
    });

    return () => off();
  }, []);

  const runStep = async (args: { label: string; argv: string[]; timeoutMs?: number; note?: string }) => {
    pushTrail({ ts: Date.now(), label: args.label, argv: args.argv, note: args.note });
    const res = await runFast({ label: args.label, argv: args.argv, timeoutMs: args.timeoutMs });
    pushTrail({ ts: Date.now(), label: args.label, argv: args.argv, code: res.code });
    return res;
  };

  const canScan = useMemo(() => !disableAll && !busy, [disableAll, busy]);

  const computeNewSince = (all: RpaUtxoRow[]) => {
    const prev = loadLastSeen(profile);
    const nowOutpoints = all.map((u) => u.outpoint).filter(Boolean);

    const fresh = all.filter((u) => u.outpoint && !prev.has(u.outpoint));
    setNewSince(fresh);

    // update last seen to current snapshot
    saveLastSeen(profile, nowOutpoints);
  };

  const loadRpaUtxos = async () => {
    const argv = buildWalletRpaUtxosArgv();
    const res = await runStep({
      label: 'wallet:rpa-utxos',
      argv,
      timeoutMs: 90_000,
      note: 'Read stealth UTXOs from state (after scan)',
    });

    const parsed = parseWalletRpaUtxos(res.stdout ?? '');
    setUtxos(parsed.utxos);
    computeNewSince(parsed.utxos);
  };

  const scanInbound = async () => {
    setBusy(true);
    setStatus({ kind: 'running', title: 'Scanning inbound…', detail: 'Starting scan…', progress: null });

    // IMPORTANT: clear old opId
    scanOpIdRef.current = null;

    try {
      const scanArgv = buildScanInboundArgv({ includeMempool, updateState });

      // We can only set opId after runFast returns (best-effort).
      pushTrail({
        ts: Date.now(),
        label: 'scan:auto',
        argv: scanArgv,
        note: 'Discover inbound RPA outputs and write to state (slow)',
      });

      const scanRes = await runFast({ label: 'scan:auto', argv: scanArgv, timeoutMs: 240_000 });

      scanOpIdRef.current = scanRes.opId;
      pushTrail({ ts: Date.now(), label: 'scan:auto', argv: scanArgv, code: scanRes.code });

      // If chunk timing didn’t hit the status bar, still show a nice completion state.
      setStatus((cur: OpStatus) => ({
        ...cur,
        kind: 'running',
        title: 'Scan complete',
        detail: 'Updating list from state…',
        progress: null,
      }));

      await loadRpaUtxos();
      await refreshNow();

      if (newSince.length === 0) {
        setStatus({
          kind: 'success',
          title: 'Ready',
          detail: 'Scan finished. No new stealth UTXOs since last scan.',
          progress: null,
        });
      } else {
        setStatus({
          kind: 'success',
          title: 'Ready',
          detail: `Scan finished. Found ${newSince.length} new stealth UTXO(s).`,
          progress: null,
        });
      }
    } catch (e: any) {
      setStatus({
        kind: 'error',
        title: 'Scan failed',
        detail: String(e?.message ?? e ?? 'Unknown error'),
        progress: null,
      });
    } finally {
      scanOpIdRef.current = null;
      setBusy(false);
    }
  };

  // Optional: show something on first mount/profile switch (fast read-only)
  useEffect(() => {
    // read-only “what’s already in state”
    void loadRpaUtxos().catch(() => {
      // ignore: state missing is fine
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const allSorted = useMemo(() => {
    const copy = utxos.slice();
    // largest first is usually most useful
    copy.sort((a, b) => {
      try {
        return BigInt(b.valueSats) > BigInt(a.valueSats) ? 1 : -1;
      } catch {
        return 0;
      }
    });
    return copy;
  }, [utxos]);

  const newSorted = useMemo(() => {
    const copy = newSince.slice();
    copy.sort((a, b) => {
      try {
        return BigInt(b.valueSats) > BigInt(a.valueSats) ? 1 : -1;
      } catch {
        return 0;
      }
    });
    return copy;
  }, [newSince]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>RPA Scan</div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>Scan inbound → write to state → list stealth UTXOs</div>
        <div style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 12 }}>
          profile: <code>{profile}</code>
        </div>
      </div>

      <OpStatusBar
        status={status}
        onClear={
          status.kind === 'error' || status.kind === 'success'
            ? () =>
                setStatus({
                  kind: 'idle',
                  title: 'Ready',
                  detail: 'Click “Scan inbound” to discover new stealth UTXOs.',
                  progress: null,
                })
            : undefined
        }
      />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button disabled={!canScan} onClick={() => void scanInbound()}>
          {busy ? 'Working…' : 'Scan inbound'}
        </button>

        <button
          disabled={disableAll || busy}
          onClick={() => {
            setStatus({ kind: 'running', title: 'Refreshing…', detail: 'Reading state…', progress: null });
            void loadRpaUtxos()
              .then(() => setStatus({ kind: 'idle', title: 'Ready', detail: 'List refreshed from state.', progress: null }))
              .catch((e) =>
                setStatus({
                  kind: 'error',
                  title: 'Refresh failed',
                  detail: String((e as any)?.message ?? e),
                  progress: null,
                })
              );
          }}
        >
          Refresh list
        </button>

        <div style={{ opacity: 0.75, fontSize: 12 }}>
          Uses: <code>scan --include-mempool --update-state</code> then <code>wallet rpa-utxos --json</code>
        </div>

        <div style={{ marginLeft: 'auto', opacity: 0.75, fontSize: 12 }}>
          total: <code>{utxos.length}</code> · new since last scan: <code>{newSince.length}</code>
        </div>
      </div>

      {/* New since last scan */}
      <div style={{ border: '1px solid #222', borderRadius: 10, padding: 10, background: '#070707' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>New since last scan</div>
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            These outpoints were not present the last time this profile scanned.
          </div>
          <div style={{ marginLeft: 'auto', opacity: 0.75, fontSize: 12 }}>
            shown: <code>{newSorted.length}</code>
          </div>
        </div>

        {newSorted.length ? (
          <div style={{ overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.85 }}>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>value</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>outpoint</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>kind</th>
                </tr>
              </thead>
              <tbody>
                {newSorted.map((u) => {
                  const txid = u.outpoint.split(':')[0];
                  const vout = u.outpoint.split(':')[1] ?? '';
                  return (
                    <tr key={u.outpoint} style={{ borderBottom: '1px solid #111' }}>
                      <td style={{ padding: '6px 8px' }}>{formatSats(u.valueSats)} sats</td>
                      <td style={{ padding: '6px 8px' }}>
                        <a href={chipnetTxUrl(txid)} target="_blank" rel="noreferrer">
                          <code>{shortHex(txid, 10)}</code>
                        </a>
                        <span style={{ opacity: 0.8 }}>:{vout}</span>
                      </td>
                      <td style={{ padding: '6px 8px', opacity: 0.85 }}>
                        <code>{kindText(u.kind)}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ opacity: 0.75, fontSize: 12 }}>
            No new stealth UTXOs yet. If you just received a payment, wait for propagation and scan again.
          </div>
        )}
      </div>

      {/* All stealth UTXOs */}
      <div style={{ border: '1px solid #222', borderRadius: 10, padding: 10, background: '#070707', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>Stealth UTXOs (state)</div>
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            Source: <code>wallet rpa-utxos --json</code>
          </div>
          <div style={{ marginLeft: 'auto', opacity: 0.75, fontSize: 12 }}>
            shown: <code>{allSorted.length}</code>
          </div>
        </div>

        {allSorted.length ? (
          <div style={{ overflow: 'auto', height: '100%' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.85 }}>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>value</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>outpoint</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>kind</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>spent</th>
                </tr>
              </thead>
              <tbody>
                {allSorted.map((u) => {
                  const txid = u.outpoint.split(':')[0];
                  const vout = u.outpoint.split(':')[1] ?? '';
                  return (
                    <tr key={u.outpoint} style={{ borderBottom: '1px solid #111', opacity: u.spent ? 0.6 : 1 }}>
                      <td style={{ padding: '6px 8px' }}>{formatSats(u.valueSats)} sats</td>
                      <td style={{ padding: '6px 8px' }}>
                        <a href={chipnetTxUrl(txid)} target="_blank" rel="noreferrer">
                          <code>{shortHex(txid, 10)}</code>
                        </a>
                        <span style={{ opacity: 0.8 }}>:{vout}</span>
                      </td>
                      <td style={{ padding: '6px 8px', opacity: 0.85 }}>
                        <code>{kindText(u.kind)}</code>
                      </td>
                      <td style={{ padding: '6px 8px', opacity: 0.85 }}>
                        <code>{u.spent ? 'yes' : 'no'}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ opacity: 0.75, fontSize: 12 }}>
            No stealth UTXOs found in state for this profile yet. Ask someone to pay your paycode, then click <b>Scan inbound</b>.
          </div>
        )}

        {/* Commands run */}
        <div style={{ marginTop: 12, borderTop: '1px solid #111', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.85 }}>Commands run (RPA Scan • {profile})</div>
            <button style={{ marginLeft: 'auto' }} disabled={disableAll || busy || !trail.length} onClick={clearTrail}>
              Clear
            </button>
          </div>

          <div style={{ marginTop: 8, maxHeight: 140, overflow: 'auto', fontSize: 12, opacity: 0.85 }}>
            {trail.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {trail
                  .slice()
                  .reverse()
                  .map((t, i) => {
                    const ts = new Date(t.ts).toLocaleTimeString();
                    const code = typeof t.code === 'number' ? `exit ${t.code}` : '';
                    return (
                      <div
                        key={`${t.ts}:${i}`}
                        style={{ border: '1px solid #111', borderRadius: 8, padding: 8, background: '#050505' }}
                      >
                        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                          <div style={{ opacity: 0.65 }}>{ts}</div>
                          <div style={{ fontWeight: 700 }}>{t.label}</div>
                          <div style={{ marginLeft: 'auto', opacity: 0.7 }}>{code}</div>
                        </div>
                        {t.note ? <div style={{ opacity: 0.75, marginTop: 4 }}>{t.note}</div> : null}
                        <div style={{ marginTop: 6 }}>
                          <code>{argvToString(t.argv)}</code>
                        </div>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div style={{ opacity: 0.7 }}>No commands yet. Click “Scan inbound”.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}