// packages/gui/src/renderer/tabs/PoolImport.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RunResult } from '../hooks/useBchctl';
import { OpStatusBar, type OpStatus } from '../components/OpStatusBar';
import {
  type DepositRow,
  type RpaUtxoRow,
  buildScanInboundArgv,
  buildWalletRpaUtxosArgv,
  parseWalletRpaUtxos,
  buildPoolDepositsArgv,
  parsePoolDeposits,
  buildPoolStageFromArgv,
  buildPoolImportArgv,
  chipnetTxUrl,
  shortHex,
  formatSats,
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
  return `bchstealth.poolImportTrail.v1.${p}`;
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

function argvToString(argv: string[]): string {
  // show as user would run it (minus yarn bchctl and profile)
  return argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ');
}

function shortOutpoint(op: string): string {
  const s = String(op ?? '');
  const tx = s.slice(0, 8);
  return tx ? `${tx}…` : s;
}

export function PoolImportTab(props: Props) {
  const { profile, runFast, refreshNow, disableAll } = props;

  const [busy, setBusy] = useState(false);

  // table filters
  const [checkChain, setCheckChain] = useState(true);
  const [unimportedOnly, setUnimportedOnly] = useState(true);
  const [allowUnknown, setAllowUnknown] = useState(false);

  const [rows, setRows] = useState<DepositRow[]>([]);
  const [selectedOutpoint, setSelectedOutpoint] = useState<string>('');

  const [depositsMeta, setDepositsMeta] = useState<{
    stateFile?: string;
    network?: string;
    total?: number;
    shown?: number;
  } | null>(null);

  const [status, setStatus] = useState<OpStatus>({
    kind: 'idle',
    title: 'Ready',
    detail: 'Click “Scan inbound” to find new deposits.',
    progress: null,
  });

  // -----------------------------
  // Command trail (per-profile)
  // -----------------------------
  const [trail, setTrail] = useState<TrailItem[]>(() => loadTrail(profile));

  useEffect(() => {
    setTrail(loadTrail(profile));
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

  // track which opId is the active scan so we can parse its progress chunks
  const scanOpIdRef = useRef<string | null>(null);

  const runStep = async (args: { label: string; argv: string[]; timeoutMs?: number; note?: string }) => {
    pushTrail({ ts: Date.now(), label: args.label, argv: args.argv, note: args.note });
    const res = await runFast({ label: args.label, argv: args.argv, timeoutMs: args.timeoutMs });
    pushTrail({ ts: Date.now(), label: args.label, argv: args.argv, code: res.code });
    return res;
  };

  // -----------------------------
  // Load staged deposits list
  // -----------------------------
  const loadDeposits = async () => {
    const argv = buildPoolDepositsArgv({ unimportedOnly, checkChain });
    const res = await runStep({ label: 'pool:deposits', argv, timeoutMs: 90_000, note: 'Load staged deposits list' });
    const parsed = parsePoolDeposits(res.stdout ?? '');
    setRows(parsed.deposits);
    setDepositsMeta(parsed.meta ?? null);
  };

  useEffect(() => {
    // reset view + reload when profile changes
    setRows([]);
    setSelectedOutpoint('');
    setDepositsMeta(null);
  
    // also reset status so the user doesn't see stale "Depositing..." etc.
    setStatus({
      kind: 'idle',
      title: 'Ready',
      detail: 'Click “Scan inbound” to find new deposits.',
      progress: null,
    });
  
    // clear any in-flight scan tracking
    scanOpIdRef.current = null;
  
    // (optional) clear busy if you want profile switch to “break out” of a long op visually
    setBusy(false);
  
    void loadDeposits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  useEffect(() => {
    void loadDeposits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // filter flips should re-read list (fast-ish), not do discovery
    void loadDeposits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkChain, unimportedOnly]);

  // -----------------------------
  // Live scan progress (stderr)
  // -----------------------------
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
        return;
      }

      if (evt.kind === 'done') {
        setStatus((cur: OpStatus) => ({
          ...cur,
          kind: 'running',
          title: cur.title || 'Scanning inbound…',
          detail: 'Scan completed. Finalizing…',
          progress: cur.progress ?? null,
        }));
        return;
      }

      if (evt.kind === 'found') {
        setStatus((cur: OpStatus) => ({
          ...cur,
          kind: 'running',
          title: 'Scan complete',
          detail: `Found ${evt.found} inbound candidates.`,
          progress: null,
        }));
        return;
      }
    });

    return () => off();
  }, []);

  const canScan = useMemo(() => !disableAll && !busy, [disableAll, busy]);

  const rowDisabledReason = (r: DepositRow): string | null => {
    if (disableAll) return 'disabled';
    if (busy) return 'busy';
    if (r.importTxid) return 'already imported';
    if (checkChain && r.chainOk === false) return 'spent on chain';
    if (checkChain && r.chainOk == null && !allowUnknown) return 'unknown on chain';
    return null;
  };

  // -----------------------------
  // One-click flow:
  // scan -> rpa-utxos -> stage-from new -> reload deposits -> refresh gauges
  // -----------------------------
  const runScanInboundAndPromote = async () => {
    setBusy(true);
    setStatus({ kind: 'running', title: 'Scanning inbound…', detail: 'Starting scan…', progress: null });

    // IMPORTANT: clear old scan opId *before* starting
    scanOpIdRef.current = null;

    try {
      // 0) kickoff scan and capture opId early so chunk listener can work
      const scanArgv = buildScanInboundArgv({ includeMempool: true, updateState: true });

      // We need opId from the run itself. runFast returns it.
      pushTrail({
        ts: Date.now(),
        label: 'scan:auto',
        argv: scanArgv,
        note: 'Discover inbound deposits and write them to the state file (slow)',
      });

      const scanRes = await runFast({ label: 'scan:auto', argv: scanArgv, timeoutMs: 240_000 });

      // ✅ set opId immediately so we can parse subsequent chunks (some may still arrive after await)
      scanOpIdRef.current = scanRes.opId;

      pushTrail({ ts: Date.now(), label: 'scan:auto', argv: scanArgv, code: scanRes.code });

      // 1) wallet rpa-utxos --json
      let inbound: RpaUtxoRow[] = [];
      {
        const argv = buildWalletRpaUtxosArgv();
        const res = await runStep({
          label: 'wallet:rpa-utxos',
          argv,
          timeoutMs: 90_000,
          note: 'Read discovered inbound UTXOs from state',
        });
        inbound = parseWalletRpaUtxos(res.stdout ?? '').utxos;
      }

      // 2) pool deposits (all) to avoid restaging
      let staged = new Set<string>();
      {
        const argv = buildPoolDepositsArgv({ unimportedOnly: false, checkChain: false });
        const res = await runStep({
          label: 'pool:deposits:all',
          argv,
          timeoutMs: 90_000,
          note: 'Read all staged deposits (avoid re-staging)',
        });
        staged = new Set(parsePoolDeposits(res.stdout ?? '').deposits.map((d) => d.outpoint));
      }

      // 3) stage-from for new inbound outpoints (unspent & not already staged)
      const candidates = inbound.filter((u) => u?.outpoint && !u.spent && !staged.has(u.outpoint) && u.kind !== 'wallet_change');

      if (!candidates.length) {
        // reload deposits anyway (chain check may have changed)
        await loadDeposits();
        await refreshNow();

        // first-run friendly empty state
        const nowRows = rows.length;
        if (nowRows === 0) {
          setStatus({
            kind: 'idle',
            title: 'No inbound deposits found',
            detail: 'Ask someone to pay your paycode, then click “Scan inbound” again.',
            progress: null,
          });
        } else {
          setStatus({
            kind: 'success',
            title: 'No new deposits',
            detail: 'Everything already looks staged. If you just received a payment, scan again in a moment.',
            progress: null,
          });
        }
        return;
      }

      setStatus({
        kind: 'running',
        title: 'Promoting inbound…',
        detail: `Staging ${candidates.length} new deposits…`,
        progress: { cur: 0, total: candidates.length },
      });

      let i = 0;
      for (const u of candidates) {
        i++;
        setStatus({
          kind: 'running',
          title: 'Promoting inbound…',
          detail: `Staging ${i}/${candidates.length} (${shortOutpoint(u.outpoint)})`,
          progress: { cur: i, total: candidates.length },
        });

        const argv = buildPoolStageFromArgv({ outpoint: u.outpoint });
        await runStep({
          label: `pool:stage-from:${u.outpoint.slice(0, 8)}`,
          argv,
          timeoutMs: 120_000,
          note: `Promote ${u.outpoint} into staged deposits`,
        });
      }

      // 4) reload list + refresh gauges once
      setStatus({ kind: 'running', title: 'Refreshing…', detail: 'Loading staged deposits…', progress: null });
      await loadDeposits();
      await refreshNow();

      setStatus({ kind: 'success', title: 'Ready', detail: 'Scan complete. Deposits list updated.', progress: null });
    } catch (e: any) {
      setStatus({ kind: 'error', title: 'Error', detail: String(e?.message ?? e ?? 'Unknown error'), progress: null });
    } finally {
      scanOpIdRef.current = null;
      setBusy(false);
    }
  };

  const depositOne = async (r: DepositRow) => {
    const reason = rowDisabledReason(r);
    if (reason) return;

    setBusy(true);
    setStatus({ kind: 'running', title: 'Depositing…', detail: `Importing ${shortOutpoint(r.outpoint)}…`, progress: null });

    try {
      const argv = buildPoolImportArgv({ outpoint: r.outpoint });
      await runStep({
        label: `pool:import:${r.outpoint.slice(0, 8)}`,
        argv,
        timeoutMs: 240_000,
        note: `Import ${r.outpoint} into the pool shard`,
      });

      await refreshNow();
      await loadDeposits();

      setStatus({ kind: 'success', title: 'Deposited', detail: `Imported ${shortOutpoint(r.outpoint)}.`, progress: null });
    } catch (e: any) {
      setStatus({
        kind: 'error',
        title: 'Deposit failed',
        detail: String(e?.message ?? e ?? 'Unknown error'),
        progress: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const depositAllVisible = async () => {
    const candidates = rows.filter((r) => !rowDisabledReason(r));
    if (!candidates.length) {
      setStatus({ kind: 'idle', title: 'Nothing to deposit', detail: 'No eligible deposits are visible.', progress: null });
      return;
    }

    setBusy(true);
    setStatus({
      kind: 'running',
      title: 'Depositing…',
      detail: `Importing 0/${candidates.length}…`,
      progress: { cur: 0, total: candidates.length },
    });

    try {
      let i = 0;
      for (const r of candidates) {
        i++;
        setStatus({
          kind: 'running',
          title: 'Depositing…',
          detail: `Importing ${i}/${candidates.length} (${shortOutpoint(r.outpoint)})`,
          progress: { cur: i, total: candidates.length },
        });

        const argv = buildPoolImportArgv({ outpoint: r.outpoint });
        await runStep({
          label: `pool:import:${r.outpoint.slice(0, 8)}`,
          argv,
          timeoutMs: 240_000,
          note: `Import ${r.outpoint}`,
        });
      }

      await refreshNow();
      await loadDeposits();

      setStatus({ kind: 'success', title: 'Done', detail: `Imported ${candidates.length} deposits.`, progress: null });
    } catch (e: any) {
      setStatus({
        kind: 'error',
        title: 'Deposit-all failed',
        detail: String(e?.message ?? e ?? 'Unknown error'),
        progress: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const selectedRow = useMemo(() => rows.find((r) => r.outpoint === selectedOutpoint) ?? null, [rows, selectedOutpoint]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Pool Import</div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>Scan inbound → promote → deposit</div>
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
                  detail: 'Click “Scan inbound” to find new deposits.',
                  progress: null,
                })
            : undefined
        }
      />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button disabled={!canScan} onClick={() => void runScanInboundAndPromote()}>
          {busy ? 'Working…' : 'Scan inbound'}
        </button>

        <button disabled={disableAll || busy} onClick={() => void depositAllVisible()}>
          Deposit all visible
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
            <input type="checkbox" checked={unimportedOnly} onChange={(e) => setUnimportedOnly(e.target.checked)} />
            unimported only
          </label>

          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
            <input type="checkbox" checked={checkChain} onChange={(e) => setCheckChain(e.target.checked)} />
            check chain
          </label>

          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
            <input
              type="checkbox"
              checked={allowUnknown}
              onChange={(e) => setAllowUnknown(e.target.checked)}
              disabled={!checkChain}
            />
            allow unknown
          </label>
        </div>
      </div>

      <div
        style={{
          border: '1px solid #222',
          borderRadius: 10,
          padding: 10,
          background: '#070707',
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* header row with precise placement */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
          <div style={{ fontWeight: 700 }}>Staged deposits</div>
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            Source: <code>pool deposits --json</code>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
            <div style={{ opacity: 0.75, fontSize: 12 }}>
              shown: <code>{rows.length}</code>
            </div>

            {depositsMeta?.stateFile ? (
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                state: <code>{depositsMeta.stateFile}</code>
              </div>
            ) : null}
          </div>
        </div>

        <div style={{ maxHeight: '100%', overflow: 'auto' }}>
          {rows.length ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.85 }}>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>value</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>outpoint</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>kind</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>status</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222', textAlign: 'right' }}>action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isSel = selectedOutpoint === r.outpoint;
                  const imported = !!r.importTxid;
                  const disabledReason = rowDisabledReason(r);
                  const disabled = !!disabledReason;

                  const statusText = imported
                    ? 'imported'
                    : checkChain
                      ? r.chainOk === true
                        ? 'unspent'
                        : r.chainOk === false
                          ? 'spent'
                          : 'unknown'
                      : 'unchecked';

                  return (
                    <tr
                      key={r.outpoint}
                      onClick={() => setSelectedOutpoint(r.outpoint)}
                      style={{
                        cursor: 'pointer',
                        background: isSel ? '#10161d' : undefined,
                        opacity: disabled ? 0.55 : 1,
                      }}
                      title={disabledReason ?? 'Click to select'}
                    >
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111' }}>
                        {formatSats(r.valueSats)} sats
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111' }}>
                        <a href={chipnetTxUrl(r.txid)} target="_blank" rel="noreferrer">
                          <code>{shortHex(r.txid, 10)}</code>
                        </a>
                        <span style={{ opacity: 0.8 }}>:{r.vout}</span>
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', opacity: 0.85 }}>
                        <code>{r.depositKind || 'rpa'}</code>
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', opacity: 0.85 }}>
                        <code>{statusText}</code>
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', textAlign: 'right' }}>
                        <button
                          disabled={disabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            void depositOne(r);
                          }}
                        >
                          {imported ? 'Imported' : 'Deposit'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ opacity: 0.75, fontSize: 12 }}>
              No staged deposits found. Click <b>Scan inbound</b> to discover deposits.
            </div>
          )}
        </div>

        {/* command trail under the frame */}
        <div style={{ marginTop: 12, borderTop: '1px solid #111', paddingTop: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.85 }}>Commands run (Pool Import • {profile})</div>
            <button style={{ marginLeft: 'auto' }} disabled={disableAll || busy || !trail.length} onClick={clearTrail}>
              Clear
            </button>
          </div>

          <div style={{ marginTop: 8, maxHeight: 140, overflow: 'auto', fontSize: 12, opacity: 0.85 }}>
            {trail.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* newest first */}
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

      {selectedRow ? (
        <div style={{ opacity: 0.75, fontSize: 12 }}>
          selected: <code>{selectedRow.outpoint}</code> • value: <code>{formatSats(selectedRow.valueSats)}</code> • kind:{' '}
          <code>{selectedRow.depositKind || 'rpa'}</code> •{' '}
          <a href={chipnetTxUrl(selectedRow.txid)} target="_blank" rel="noreferrer">
            explorer
          </a>
        </div>
      ) : null}
    </div>
  );
}