// packages/gui/src/renderer/tabs/PoolInit.tsx
import React, { useEffect, useMemo, useState } from 'react';
import type { RunResult } from '../hooks/useBchctl';
import { MostRecentResult } from '../components/MostRecentResult';

// -----------------------------
// Types (JSON-based)
// -----------------------------
type PoolShardsJson = {
  meta?: {
    stateFile?: string;
    network?: string;
    poolIdHex?: string;
    categoryHex?: string;
    shardCount?: number;
    totalSats?: string;
  };
  shards?: Array<{
    index?: number;
    txid?: string;
    vout?: number;
    valueSats?: string;
    commitmentHex?: string;
  }>;
};

type ShardRow = {
  index: number;
  valueSats: string; // keep as string for BigInt safety
  outpoint: string; // txid:vout
  commitment: string;
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

type Props = {
  profile: string;
  run: (args: { label: string; argv: string[]; timeoutMs?: number }) => Promise<RunResult>;
  runFast: (args: { label: string; argv: string[]; timeoutMs?: number }) => Promise<RunResult>;
  refreshNow: () => Promise<void>;
  disableAll: boolean;
};

// -----------------------------
// Helpers
// -----------------------------
function isHex64(s: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(String(s ?? ''));
}

function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const s = String(outpoint ?? '').trim();
  const m = s.match(/^([0-9a-f]{64}):(\d+)$/i);
  if (!m) return null;
  return { txid: m[1].toLowerCase(), vout: Number(m[2]) };
}

function chipnetTxUrl(txid: string): string {
  return `https://chipnet.chaingraph.cash/tx/${txid}`;
}

function shortHex(h: string, n = 12): string {
  const s = String(h ?? '');
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function formatSats(satsStr: string): string {
  try {
    return BigInt(String(satsStr ?? '0')).toString();
  } catch {
    return String(satsStr ?? '0');
  }
}

// Robust JSON tail extraction (stdout may contain logs above JSON)
function extractJsonTail(s: string): string | null {
  const text = String(s ?? '');
  if (!text.trim()) return null;

  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x7b /* { */ || c === 0x5b /* [ */) starts.push(i);
  }
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
        // try next
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

function parsePoolShardsJson(stdout: string): {
  meta: PoolShardsJson['meta'] | null;
  shards: ShardRow[];
} {
  const json = tryParseJson<PoolShardsJson>(stdout ?? '');
  const meta = json?.meta ?? null;
  const shardsAny = Array.isArray(json?.shards) ? (json!.shards as any[]) : [];

  const shards: ShardRow[] = [];
  for (const s of shardsAny) {
    const index = Number(s?.index);
    const txid = String(s?.txid ?? '').trim().toLowerCase();
    const vout = Number(s?.vout);
    const valueSats = String(s?.valueSats ?? '0');
    const commitment = String(s?.commitmentHex ?? '').trim();

    if (!Number.isFinite(index) || index < 0) continue;
    if (!isHex64(txid) || !Number.isFinite(vout) || vout < 0) continue;
    if (!commitment) continue;

    shards.push({
      index,
      valueSats,
      outpoint: `${txid}:${vout}`,
      commitment,
    });
  }

  shards.sort((a, b) => a.index - b.index);
  return { meta, shards };
}

// -----------------------------
// Per-profile command trail
// -----------------------------
function trailKey(profile: string): string {
  const p = String(profile ?? '').trim() || 'default';
  return `bchstealth.poolInitTrail.v1.${p}`;
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

// -----------------------------
// Tiny UI helpers (kept local)
// -----------------------------
function InfoTip(props: { title: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        borderRadius: 999,
        border: '1px solid #333',
        background: '#0b0b0b',
        color: '#bbb',
        fontSize: 11,
        lineHeight: 1,
        marginLeft: 6,
        cursor: 'help',
        userSelect: 'none',
      }}
      aria-label="info"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      i
      {open ? (
        <span
          style={{
            position: 'absolute',
            zIndex: 9999,
            top: 'calc(100% + 10px)',
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'block',
            minWidth: 260,
            width: 360,
            maxWidth: 520,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid #333',
            background: '#0b0b0b',
            color: '#eee',
            fontSize: 12,
            lineHeight: 1.35,
            boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
            whiteSpace: 'normal',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            writingMode: 'horizontal-tb',
            textAlign: 'left',
          }}
        >
          {props.title}
          <span
            style={{
              position: 'absolute',
              top: -6,
              left: '50%',
              width: 10,
              height: 10,
              background: '#0b0b0b',
              borderLeft: '1px solid #333',
              borderTop: '1px solid #333',
              transform: 'translateX(-50%) rotate(45deg)',
            }}
          />
        </span>
      ) : null}
    </span>
  );
}

function OutpointLink(props: { outpoint: string }) {
  const p = splitOutpoint(props.outpoint);
  if (!p) return <code>{props.outpoint}</code>;
  return (
    <span style={{ overflowWrap: 'anywhere' }}>
      <a href={chipnetTxUrl(p.txid)} target="_blank" rel="noreferrer">
        <code>{p.txid}</code>
      </a>
      <span style={{ opacity: 0.8 }}>:{p.vout}</span>
    </span>
  );
}

// -----------------------------
// Main component
// -----------------------------
export function PoolInitTab(props: Props) {
  const { profile, runFast, refreshNow, disableAll } = props;

  const [busy, setBusy] = useState(false);

  // show only init raw output (shards raw output goes to global LogPane)
  const [lastInit, setLastInit] = useState<LastRun | null>(null);

  // keep parsed shard state locally so we can render the table
  const [shardsMeta, setShardsMeta] = useState<PoolShardsJson['meta'] | null>(null);
  const [shards, setShards] = useState<ShardRow[]>([]);
  const [selectedShardIndex, setSelectedShardIndex] = useState<number | null>(null);

  // per-profile trail
  const [trail, setTrail] = useState<TrailItem[]>(() => loadTrail(profile));
  useEffect(() => {
    setTrail(loadTrail(profile));
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

  const selectedShard = useMemo(() => {
    if (selectedShardIndex === null) return null;
    return shards.find((s) => s.index === selectedShardIndex) ?? null;
  }, [shards, selectedShardIndex]);

  const refreshShards = async () => {
    // IMPORTANT: use --json so we can reliably parse and render the table
    const argv = ['pool', 'shards', '--json'];

    const res = await runStep({
      label: 'pool:shards',
      argv,
      timeoutMs: 90_000,
      note: 'Read current shard outpoints/commitments',
    });

    const parsed = parsePoolShardsJson(res.stdout ?? '');
    setShardsMeta(parsed.meta);
    setShards(parsed.shards);

    // maintain selection
    if (!parsed.shards.length) {
      setSelectedShardIndex(null);
    } else if (selectedShardIndex === null || !parsed.shards.some((s) => s.index === selectedShardIndex)) {
      setSelectedShardIndex(parsed.shards[0].index);
    }
  };

  // On mount + profile change: reset view and refresh (like Pool Import)
  useEffect(() => {
    setBusy(false);
    setLastInit(null);
    setShardsMeta(null);
    setShards([]);
    setSelectedShardIndex(null);

    void refreshShards().catch(() => {
      // ignore (pool may be uninitialized for this profile)
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const canInit = useMemo(() => !disableAll && !busy, [disableAll, busy]);

  const doInit = async () => {
    setBusy(true);
    try {
      const argv = ['pool', 'init'];
      const res = await runStep({
        label: 'pool:init',
        argv,
        timeoutMs: 180_000,
        note: 'Create shard UTXOs and initialize pool state',
      });

      setLastInit({
        ts: Date.now(),
        argv,
        code: res.code,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
      });

      // Always refresh shards afterward (even if init failed, the logs will explain)
      await refreshShards();

      // Refresh gauges once (pool sats etc)
      await refreshNow();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>Pool init (create shards)</div>
        <div style={{ marginLeft: 'auto', opacity: 0.6, fontSize: 12 }}>
          profile: <code>{profile}</code>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button disabled={!canInit} onClick={() => void doInit()}>
          {busy ? 'Initializing…' : 'Init pool (8 shards)'}
        </button>

        <button disabled={disableAll || busy} onClick={() => void refreshShards()}>
          Refresh shards
        </button>

        <div style={{ opacity: 0.75, fontSize: 12 }}>
          Tip: In the <b>Log</b> pane, enable <b>this tab</b> to watch only <code>pool:init</code> + <code>pool:shards</code>.
        </div>
      </div>

      {/* Pool summary */}
      <div style={{ border: '1px solid #222', borderRadius: 8, padding: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Pool summary</div>

        <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.35, marginBottom: 10 }}>
          A local, wallet-owned sharded pool lets the wallet move value through a private state machine without shared
          mixers or custodians. Shards spread value across independent state cells, improving privacy and change routing.
          Later, shard commitments become stable anchors for confidential proofs and withdrawals.
        </div>

        {shardsMeta?.shardCount ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, opacity: 0.92 }}>
            {shardsMeta.stateFile ? (
              <div>
                state: <code>{shardsMeta.stateFile}</code>
              </div>
            ) : null}
            {shardsMeta.poolIdHex ? (
              <div>
                poolId: <code>{shardsMeta.poolIdHex}</code>
              </div>
            ) : null}
            {shardsMeta.categoryHex ? (
              <div>
                category: <code title={shardsMeta.categoryHex}>{shortHex(shardsMeta.categoryHex, 16)}</code>
              </div>
            ) : null}
            <div>
              shards: <code>{String(shardsMeta.shardCount)}</code>
              {shardsMeta.totalSats ? (
                <>
                  {' '}
                  · total: <code>{formatSats(shardsMeta.totalSats)} sats</code>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.75 }}>
            No pool detected yet for this profile. Click <code>Init pool</code>.
          </div>
        )}
      </div>

      {/* Selected shard + commands trail */}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0, border: '1px solid #222', borderRadius: 8, padding: 10, background: '#0b0b0b' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Selected shard</div>

          {!selectedShard ? (
            <div style={{ fontSize: 13, opacity: 0.75 }}>Select a row below to inspect shard details.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, opacity: 0.95 }}>
              <div>
                index: <code>{selectedShard.index}</code>
              </div>
              <div>
                value: <code>{formatSats(selectedShard.valueSats)} sats</code>
              </div>
              <div style={{ overflowWrap: 'anywhere' }}>
                outpoint
                <InfoTip title="Outpoint = txid:vout. This is the UTXO currently backing the shard." />:{' '}
                <OutpointLink outpoint={selectedShard.outpoint} />
              </div>
              <div style={{ overflowWrap: 'anywhere' }}>
                commitment
                <InfoTip title="Shard state commitment enforced by the covenant." />:{' '}
                <code title={selectedShard.commitment}>{selectedShard.commitment}</code>
              </div>
            </div>
          )}
        </div>

        {/* Commands run (tab-local, per-profile) */}
        <div style={{ flex: 1.2, minWidth: 0, border: '1px solid #222', borderRadius: 8, padding: 10, background: '#070707' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.85 }}>Commands run (Pool Init • {profile})</div>
            <button style={{ marginLeft: 'auto' }} disabled={disableAll || busy || !trail.length} onClick={clearTrail}>
              Clear
            </button>
          </div>

          <div style={{ marginTop: 8, maxHeight: 190, overflow: 'auto', fontSize: 12, opacity: 0.85 }}>
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

      {/* Shards table */}
      <div style={{ border: '1px solid #222', borderRadius: 8, padding: 10, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>Active shards</div>
          {selectedShard ? (
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              selected: <code>#{selectedShard.index}</code>
            </div>
          ) : null}
        </div>

        {shards.length ? (
          <div style={{ overflow: 'auto', height: '100%' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.85 }}>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>#</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>value</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>
                    outpoint
                    <InfoTip title="Outpoint = txid:vout. This is the UTXO currently backing the shard." />
                  </th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>
                    commitment
                    <InfoTip title="Shard state commitment enforced by the covenant." />
                  </th>
                </tr>
              </thead>

              <tbody>
                {shards.map((r) => {
                  const isSel = selectedShardIndex === r.index;
                  const p = splitOutpoint(r.outpoint);
                  const txLink = p ? chipnetTxUrl(p.txid) : null;

                  return (
                    <tr
                      key={r.index}
                      onClick={() => setSelectedShardIndex(r.index)}
                      style={{ cursor: 'pointer', background: isSel ? '#10161d' : undefined }}
                      title="Click to select"
                    >
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', opacity: 0.9 }}>{r.index}</td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', opacity: 0.9 }}>
                        {formatSats(r.valueSats)} sats
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111' }}>
                        {txLink ? (
                          <span>
                            <a href={txLink} target="_blank" rel="noreferrer">
                              <code>{shortHex(p!.txid, 16)}</code>
                            </a>
                            <span style={{ opacity: 0.8 }}>:{p!.vout}</span>
                          </span>
                        ) : (
                          <code>{r.outpoint}</code>
                        )}
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111' }}>
                        {txLink ? (
                          <a href={txLink} target="_blank" rel="noreferrer" title="Open the anchoring transaction.">
                            <code title={r.commitment}>{shortHex(r.commitment, 18)}</code>
                          </a>
                        ) : (
                          <code title={r.commitment}>{shortHex(r.commitment, 18)}</code>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.75 }}>No shards to display yet.</div>
        )}
      </div>

      {/* Init output only (shards output now shown in global LogPane) */}
      <div style={{ height: 260, minHeight: 260 }}>
        <MostRecentResult
          title="Init output"
          result={lastInit}
          onClear={() => setLastInit(null)}
          disableClear={disableAll || busy}
          emptyText="Run pool init to see the most recent CLI output here."
        />
      </div>
    </div>
  );
}