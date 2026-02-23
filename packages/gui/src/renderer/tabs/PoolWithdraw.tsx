// packages/gui/src/renderer/tabs/PoolWithdraw.tsx
import React, { useEffect, useMemo, useState } from 'react';
import type { RunResult } from '../hooks/useBchctl';
import { OpStatusBar, type OpStatus } from '../components/OpStatusBar';
import { MostRecentResult } from '../components/MostRecentResult';

type Props = {
  profile: string;
  runFast: (args: { label: string; argv: string[]; timeoutMs?: number }) => Promise<RunResult>;
  refreshNow: () => Promise<void>;
  disableAll: boolean;
};

type LastRun = {
  ts: number;
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
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
  return `bchstealth.poolWithdrawTrail.v1.${p}`;
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
  return argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ');
}

function parseIntSafe(s: string): number | null {
  const t = String(s ?? '').trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return n;
}

// -------------------------
// Dest detection helpers
// -------------------------

function looksLikePaycode(dest: string): boolean {
  const d = String(dest ?? '').trim();
  // Paycodes start with PM (case-sensitive)
  return d.startsWith('PM');
}

function looksLikeCashaddr(dest: string): boolean {
  const d0 = String(dest ?? '').trim();
  if (!d0) return false;
  if (looksLikePaycode(d0)) return false; // never misclassify paycodes

  // With prefix
  const dl = d0.toLowerCase();
  if (dl.startsWith('bchtest:') || dl.startsWith('bitcoincash:')) return true;

  // No-prefix cashaddr is lower-case "q/p..." format
  if (/^[qp][0-9a-z]{30,}$/u.test(dl)) return true;

  return false;
}

function normalizeDestForCli(dest: string): {
  destForWithdraw: string;
  destForWithdrawCheck: string | null;
  kind: 'paycode' | 'cashaddr' | 'unknown';
} {
  const raw = String(dest ?? '').trim();
  if (!raw) return { destForWithdraw: raw, destForWithdrawCheck: null, kind: 'unknown' };

  if (looksLikePaycode(raw)) {
    // Keep original casing for paycodes
    return { destForWithdraw: raw, destForWithdrawCheck: null, kind: 'paycode' };
  }

  if (looksLikeCashaddr(raw)) {
    // Normalize cashaddr to lowercase (avoid mixed-case decode errors)
    const lower = raw.toLowerCase();
    return { destForWithdraw: lower, destForWithdrawCheck: lower, kind: 'cashaddr' };
  }

  return { destForWithdraw: raw, destForWithdrawCheck: null, kind: 'unknown' };
}

export function PoolWithdrawTab(props: Props) {
  const { profile, runFast, refreshNow, disableAll } = props;

  const [busy, setBusy] = useState(false);

  const [dest, setDest] = useState('');
  const [sats, setSats] = useState('1000');

  // Safety/policy
  const [allowTransparent, setAllowTransparent] = useState(false);

  // Advanced UX
  const [showAdvanced, setShowAdvanced] = useState(false);

  // withdraw flags
  const [withdrawShard, setWithdrawShard] = useState(''); // optional
  const [requireShard, setRequireShard] = useState(false);
  const [fresh, setFresh] = useState(false);

  // withdraw-check flags
  const [checkShard, setCheckShard] = useState(''); // optional
  const [broadcastFromCheck, setBroadcastFromCheck] = useState(false);
  const [categoryMode, setCategoryMode] = useState(''); // optional

  // Optional behavior: preflight before withdraw
  const [doPreflightFirst, setDoPreflightFirst] = useState(true);

  const [status, setStatus] = useState<OpStatus>({
    kind: 'idle',
    title: 'Ready',
    detail: 'Enter destination + sats, then Withdraw.',
    progress: null,
  });

  const [trail, setTrail] = useState<TrailItem[]>(() => loadTrail(profile));
  const [lastCheck, setLastCheck] = useState<LastRun | null>(null);
  const [lastWithdraw, setLastWithdraw] = useState<LastRun | null>(null);

  // reset per-profile
  useEffect(() => {
    setTrail(loadTrail(profile));
    setLastCheck(null);
    setLastWithdraw(null);
    setStatus({
      kind: 'idle',
      title: 'Ready',
      detail: 'Enter destination + sats, then Withdraw.',
      progress: null,
    });
  }, [profile]);

  const pushTrail = (it: TrailItem) => {
    setTrail((cur) => {
      const next = [...cur, it].slice(-50);
      saveTrail(profile, next);
      return next;
    });
  };

  const clearTrail = () => {
    setTrail([]);
    saveTrail(profile, []);
  };

  const runStep = async (args: { label: string; argv: string[]; timeoutMs?: number; note?: string }) => {
    pushTrail({ ts: Date.now(), label: args.label, argv: args.argv, note: args.note });
    const res = await runFast({ label: args.label, argv: args.argv, timeoutMs: args.timeoutMs });
    pushTrail({ ts: Date.now(), label: args.label, argv: args.argv, code: res.code });
    return res;
  };

  const satsOk = useMemo(() => {
    const s = String(sats ?? '').trim();
    if (!/^\d+$/.test(s)) return false;
    try {
      return BigInt(s) > 0n;
    } catch {
      return false;
    }
  }, [sats]);

  const destInfo = useMemo(() => normalizeDestForCli(dest), [dest]);

  const cashaddrBlocked = useMemo(() => {
    return destInfo.kind === 'cashaddr' && !allowTransparent;
  }, [destInfo.kind, allowTransparent]);

  const destOk = useMemo(() => {
    const d = String(dest ?? '').trim();
    if (!d) return false;
    if (cashaddrBlocked) return false;
    return true;
  }, [dest, cashaddrBlocked]);

  const requireShardButMissing = useMemo(() => {
    if (!requireShard) return false;
    return parseIntSafe(withdrawShard) == null;
  }, [requireShard, withdrawShard]);

  const canRun = useMemo(() => !disableAll && !busy && satsOk && destOk, [disableAll, busy, satsOk, destOk]);

  const buildWithdrawCheckArgv = (): string[] => {
    if (!destInfo.destForWithdrawCheck) return ['pool', 'withdraw-check', 'INVALID_DEST', '0'];

    const argv: string[] = ['pool', 'withdraw-check', destInfo.destForWithdrawCheck, String(sats).trim()];

    const s = parseIntSafe(checkShard);
    if (s != null) argv.push('--shard', String(s));

    if (broadcastFromCheck) argv.push('--broadcast');

    const mode = String(categoryMode ?? '').trim();
    if (mode) argv.push('--category-mode', mode);

    return argv;
  };

  const buildWithdrawArgv = (): string[] => {
    const argv: string[] = ['pool', 'withdraw', destInfo.destForWithdraw, String(sats).trim()];

    const s = parseIntSafe(withdrawShard);
    if (s != null) argv.push('--shard', String(s));

    if (requireShard) argv.push('--require-shard');
    if (fresh) argv.push('--fresh');

    return argv;
  };

  const runWithdrawCheck = async () => {
    if (!destInfo.destForWithdrawCheck) {
      setStatus({
        kind: 'error',
        title: 'Withdraw-check not available',
        detail: 'withdraw-check only supports cashaddr destinations. Use Withdraw for paycodes.',
        progress: null,
      });
      return;
    }

    setBusy(true);
    setStatus({ kind: 'running', title: 'Preflight…', detail: 'Running withdraw-check…', progress: null });

    try {
      const argv = buildWithdrawCheckArgv();
      const res = await runStep({
        label: 'pool:withdraw-check',
        argv,
        timeoutMs: 180_000,
        note: 'Preflight covenant withdraw (cashaddr only)',
      });

      setLastCheck({
        ts: Date.now(),
        argv,
        code: res.code,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
      });

      if (broadcastFromCheck && res.code === 0) {
        await refreshNow();
      }

      setStatus({ kind: 'success', title: 'Preflight complete', detail: 'Withdraw-check finished.', progress: null });
    } catch (e: any) {
      setStatus({
        kind: 'error',
        title: 'Preflight failed',
        detail: String(e?.message ?? e ?? 'Unknown error'),
        progress: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const runWithdraw = async () => {
    if (requireShardButMissing) {
      setStatus({
        kind: 'error',
        title: 'Missing shard',
        detail: 'You enabled “require shard” but did not provide a shard index.',
        progress: null,
      });
      return;
    }

    setBusy(true);
    setStatus({ kind: 'running', title: 'Withdrawing…', detail: 'Building and broadcasting withdraw…', progress: null });

    try {
      // preflight only when cashaddr supports it; skip for paycodes
      if (doPreflightFirst && destInfo.destForWithdrawCheck) {
        const argvCheck = buildWithdrawCheckArgv();
        const resCheck = await runStep({
          label: 'pool:withdraw-check',
          argv: argvCheck,
          timeoutMs: 180_000,
          note: 'Preflight before withdraw (cashaddr only)',
        });

        setLastCheck({
          ts: Date.now(),
          argv: argvCheck,
          code: resCheck.code,
          stdout: resCheck.stdout ?? '',
          stderr: resCheck.stderr ?? '',
        });

        if (broadcastFromCheck && resCheck.code === 0) {
          await refreshNow();
          setStatus({
            kind: 'success',
            title: 'Withdraw complete',
            detail: 'Broadcast succeeded via withdraw-check (--broadcast).',
            progress: null,
          });
          return;
        }
      }

      const argv = buildWithdrawArgv();
      const res = await runStep({
        label: 'pool:withdraw',
        argv,
        timeoutMs: 240_000,
        note: destInfo.kind === 'paycode' ? 'Withdraw to paycode (stealth)' : 'Withdraw to destination',
      });

      setLastWithdraw({
        ts: Date.now(),
        argv,
        code: res.code,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
      });

      await refreshNow();
      setStatus({ kind: 'success', title: 'Withdraw complete', detail: 'Broadcast succeeded (see output).', progress: null });
    } catch (e: any) {
      setStatus({
        kind: 'error',
        title: 'Withdraw failed',
        detail: String(e?.message ?? e ?? 'Unknown error'),
        progress: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const disableRun = !canRun || requireShardButMissing;

  const showCashaddrWarning = cashaddrBlocked;
  const showPaycodeNote = destInfo.kind === 'paycode' && doPreflightFirst;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Pool Withdraw</div>
        <div style={{ opacity: 0.75, fontSize: 12 }}>withdraw-check → withdraw</div>
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
                  detail: 'Enter destination + sats, then Withdraw.',
                  progress: null,
                })
            : undefined
        }
      />

      <div style={{ border: '1px solid #222', borderRadius: 10, padding: 10, background: '#070707', minWidth: 0 }}>
        {/* STACKED: destination above sats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <label style={{ width: '100%', minWidth: 0 }}>
            destination (paycode or cashaddr):
            <input
              style={{ width: '100%', marginTop: 6 }}
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              placeholder="PM... (paycode) or bchtest:... (cashaddr)"
              disabled={disableAll || busy}
            />
          </label>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
            <label style={{ width: 220 }}>
              sats:
              <input
                style={{ width: '100%', marginTop: 6 }}
                value={sats}
                onChange={(e) => setSats(e.target.value)}
                disabled={disableAll || busy}
              />
            </label>

            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
              <input
                type="checkbox"
                checked={doPreflightFirst}
                onChange={(e) => setDoPreflightFirst(e.target.checked)}
                disabled={disableAll || busy}
              />
              run withdraw-check first
            </label>

            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
              <input
                type="checkbox"
                checked={allowTransparent}
                onChange={(e) => setAllowTransparent(e.target.checked)}
                disabled={disableAll || busy}
              />
              allow transparent (cashaddr)
            </label>

            <button
              style={{ marginLeft: 'auto' }}
              disabled={disableAll || busy}
              onClick={() => setShowAdvanced((x) => !x)}
              title="Show advanced flags"
            >
              {showAdvanced ? 'Hide advanced' : 'Advanced'}
            </button>
          </div>
        </div>

        {showCashaddrWarning ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
            ⚠️ Cashaddr detected — enable <code>allow transparent</code> to proceed.
          </div>
        ) : null}

        {showPaycodeNote ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
            ℹ️ Paycode detected — <code>withdraw-check</code> is cashaddr-only. We’ll skip it and run <code>pool withdraw</code>.
          </div>
        ) : null}

        {showAdvanced ? (
          <div style={{ marginTop: 10, borderTop: '1px solid #111', paddingTop: 10 }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 320, border: '1px solid #111', borderRadius: 8, padding: 10, background: '#050505' }}>
                <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>Withdraw flags</div>

                <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ width: 180 }}>
                    shard:
                    <input
                      style={{ width: '100%', marginTop: 6 }}
                      value={withdrawShard}
                      onChange={(e) => setWithdrawShard(e.target.value)}
                      placeholder="(auto)"
                      disabled={disableAll || busy}
                    />
                  </label>

                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
                    <input
                      type="checkbox"
                      checked={requireShard}
                      onChange={(e) => setRequireShard(e.target.checked)}
                      disabled={disableAll || busy}
                    />
                    require shard
                  </label>

                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
                    <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} disabled={disableAll || busy} />
                    fresh
                  </label>

                  {requireShardButMissing ? <div style={{ fontSize: 12, opacity: 0.85 }}>⚠️ Provide a shard index.</div> : null}
                </div>
              </div>

              <div style={{ flex: 1, minWidth: 320, border: '1px solid #111', borderRadius: 8, padding: 10, background: '#050505' }}>
                <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.9 }}>Withdraw-check flags (cashaddr only)</div>

                <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ width: 180 }}>
                    shard:
                    <input
                      style={{ width: '100%', marginTop: 6 }}
                      value={checkShard}
                      onChange={(e) => setCheckShard(e.target.value)}
                      placeholder="(optional)"
                      disabled={disableAll || busy}
                    />
                  </label>

                  <label style={{ width: 220 }}>
                    category-mode:
                    <input
                      style={{ width: '100%', marginTop: 6 }}
                      value={categoryMode}
                      onChange={(e) => setCategoryMode(e.target.value)}
                      placeholder="reverse | direct | (blank)"
                      disabled={disableAll || busy}
                    />
                  </label>

                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
                    <input
                      type="checkbox"
                      checked={broadcastFromCheck}
                      onChange={(e) => setBroadcastFromCheck(e.target.checked)}
                      disabled={disableAll || busy}
                    />
                    broadcast from check
                  </label>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 10, display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            disabled={disableRun || !destInfo.destForWithdrawCheck}
            onClick={() => void runWithdrawCheck()}
            title={destInfo.destForWithdrawCheck ? '' : 'withdraw-check is cashaddr-only'}
          >
            Withdraw-check
          </button>

          <button disabled={disableRun} onClick={() => void runWithdraw()}>
            {busy ? 'Working…' : 'Withdraw'}
          </button>
        </div>

        <div style={{ marginTop: 8, opacity: 0.75, fontSize: 12 }}>
          Uses: <code>pool withdraw-check &lt;cashaddr&gt; &lt;sats&gt;</code> and <code>pool withdraw &lt;dest&gt; &lt;sats&gt;</code>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, minHeight: 240, flex: 1, minWidth: 0 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MostRecentResult
            title="Withdraw output"
            result={
              lastWithdraw
                ? { ts: lastWithdraw.ts, argv: lastWithdraw.argv, code: lastWithdraw.code, stdout: lastWithdraw.stdout, stderr: lastWithdraw.stderr }
                : null
            }
            onClear={() => setLastWithdraw(null)}
            disableClear={disableAll || busy}
            emptyText="Run pool withdraw to see the most recent CLI output here."
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <MostRecentResult
            title="Withdraw-check output"
            result={
              lastCheck ? { ts: lastCheck.ts, argv: lastCheck.argv, code: lastCheck.code, stdout: lastCheck.stdout, stderr: lastCheck.stderr } : null
            }
            onClear={() => setLastCheck(null)}
            disableClear={disableAll || busy}
            emptyText="Run pool withdraw-check to see the most recent preflight output here."
          />
        </div>
      </div>

      <div style={{ border: '1px solid #222', borderRadius: 10, padding: 10, background: '#070707', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.85 }}>Commands run (Pool Withdraw • {profile})</div>
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
                    <div key={`${t.ts}:${i}`} style={{ border: '1px solid #111', borderRadius: 8, padding: 8, background: '#050505' }}>
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
            <div style={{ opacity: 0.7 }}>No commands yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}