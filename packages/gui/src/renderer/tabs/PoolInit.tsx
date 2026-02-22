// packages/gui/src/renderer/tabs/PoolInit.tsx
import React, { useMemo, useState } from 'react';
import type { RunResult } from '../hooks/useBchctl';
import { MostRecentResult } from '../components/MostRecentResult';

type ShardRow = {
  index: number;
  valueSats: number;
  outpoint: string;
  commitment: string;
};

function parsePoolShardsStdout(stdout: string): {
  statePath?: string;
  poolId?: string;
  category?: string;
  shardCount?: number;
  totalSats?: number;
  shards: ShardRow[];
} {
  const s = stdout ?? '';
  const lines = s.split(/\r?\n/);

  const out: {
    statePath?: string;
    poolId?: string;
    category?: string;
    shardCount?: number;
    totalSats?: number;
    shards: ShardRow[];
  } = { shards: [] };

  const getAfter = (prefix: string) => {
    const line = lines.find((l) => l.toLowerCase().startsWith(prefix.toLowerCase()));
    if (!line) return undefined;
    return line.slice(prefix.length).trim();
  };

  out.statePath = getAfter('state:');
  out.poolId = getAfter('poolId:');
  out.category = getAfter('category:');

  const shardCountStr = getAfter('shardCount:');
  if (shardCountStr && /^\d+$/.test(shardCountStr)) out.shardCount = Number(shardCountStr);

  const totalLine = lines.find((l) => l.toLowerCase().startsWith('total:'));
  if (totalLine) {
    const m = totalLine.match(/total:\s*([0-9]+)\s*sats/i);
    if (m) out.totalSats = Number(m[1]);
  }

  for (const l of lines) {
    const m = l.match(/^\[(\d+)\]\s+value=(\d+)\s+outpoint=([0-9a-f]{64}:\d+)\s+commit=([0-9a-f]+)/i);
    if (!m) continue;
    out.shards.push({
      index: Number(m[1]),
      valueSats: Number(m[2]),
      outpoint: m[3],
      commitment: m[4],
    });
  }

  out.shards.sort((a, b) => a.index - b.index);
  return out;
}

function extractInitTxid(stdout: string): string | null {
  const m = (stdout ?? '').match(/init txid:\s*([0-9a-f]{64})/i);
  return m ? m[1] : null;
}

function shortHex(h: string, n = 10): string {
  const s = String(h ?? '');
  if (s.length <= n * 2) return s;
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

function formatSats(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString('en-US');
}

function splitOutpoint(outpoint: string): { txid: string; vout: number } | null {
  const s = String(outpoint ?? '').trim();
  const m = s.match(/^([0-9a-f]{64}):(\d+)$/i);
  if (!m) return null;
  return { txid: m[1], vout: Number(m[2]) };
}

function chipnetTxUrl(txid: string): string {
  return `https://chipnet.chaingraph.cash/tx/${txid}`;
}

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

            // IMPORTANT: prevent the “one character per line” collapse
            minWidth: 260,
            width: 340,
            maxWidth: 420,

            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid #333',
            background: '#0b0b0b',
            color: '#eee',
            fontSize: 12,
            lineHeight: 1.35,
            boxShadow: '0 10px 30px rgba(0,0,0,0.45)',

            // Text behavior
            whiteSpace: 'normal',
            wordBreak: 'break-word',
            overflowWrap: 'anywhere',
            writingMode: 'horizontal-tb',
            textAlign: 'left',
          }}
        >
          {props.title}

          {/* Arrow */}
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

/**
 * NOTE: There is not a reliable Chaingraph URL for "commitment hex" itself (it is not a txid).
 * Best-effort link is to the outpoint tx (where the commitment is committed).
 */
function CommitmentView(props: { commitment: string; outpoint?: string }) {
  const c = String(props.commitment ?? '');
  const p = props.outpoint ? splitOutpoint(props.outpoint) : null;

  if (p) {
    return (
      <span style={{ overflowWrap: 'anywhere' }}>
        <a
          href={chipnetTxUrl(p.txid)}
          target="_blank"
          rel="noreferrer"
          title="Open the transaction that currently anchors this shard (commitment is committed there)."
        >
          <code>{c}</code>
        </a>
      </span>
    );
  }

  return (
    <span style={{ overflowWrap: 'anywhere' }}>
      <code>{c}</code>
    </span>
  );
}

function ShardChart(props: {
  shards: ShardRow[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}) {
  const { shards, selectedIndex, onSelect } = props;

  const max = useMemo(() => {
    let m = 0;
    for (const s of shards) m = Math.max(m, s.valueSats);
    return m || 1;
  }, [shards]);

  const chartH = 140;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 700 }}>Shard value chart</div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>(click a bar to inspect)</div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          height: chartH + 26,
          padding: 10,
          border: '1px solid #222',
          borderRadius: 8,
          background: '#0b0b0b',
          overflowX: 'auto',
        }}
      >
        {shards.map((s) => {
          const h = Math.max(2, Math.round((s.valueSats / max) * chartH));
          const isSel = selectedIndex === s.index;

          return (
            <button
              key={s.index}
              onClick={() => onSelect(s.index)}
              title={`#${s.index} ${s.valueSats} sats\n${s.outpoint}\n${s.commitment}`}
              style={{
                cursor: 'pointer',
                border: isSel ? '1px solid #9bd' : '1px solid #222',
                background: isSel ? '#141b22' : '#0b0b0b',
                borderRadius: 6,
                padding: 6,
                width: 56,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 6,
              }}
            >
              <div
                style={{
                  height: chartH,
                  display: 'flex',
                  alignItems: 'flex-end',
                  justifyContent: 'center',
                  borderRadius: 4,
                  background: '#070707',
                  border: '1px solid #111',
                  padding: 4,
                }}
              >
                <div
                  style={{
                    height: h,
                    width: '100%',
                    borderRadius: 3,
                    background: isSel ? '#9bd' : '#3a3a3a',
                  }}
                />
              </div>

              <div style={{ fontSize: 11, opacity: 0.85, display: 'flex', justifyContent: 'space-between' }}>
                <span>#{s.index}</span>
                <span>{formatSats(s.valueSats)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ANCHOR: ShardDetails()
 * Updated to:
 * - show outpoint as tx link + vout
 * - include explanatory text
 * - show commitment with tooltip and best-effort link (to outpoint tx)
 */
function ShardDetails(props: { shard: ShardRow | null }) {
  const { shard } = props;

  return (
    <div style={{ border: '1px solid #222', borderRadius: 8, padding: 10, background: '#0b0b0b' }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>Selected shard</div>

      {!shard ? (
        <div style={{ fontSize: 13, opacity: 0.75 }}>Click a bar (or a row) to view shard details.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, opacity: 0.95 }}>
          <div>
            index: <code>{shard.index}</code>
          </div>
          <div>
            value: <code>{formatSats(shard.valueSats)} sats</code>
          </div>

          {/* UPDATED OUTPOINT SECTION */}
          <div style={{ overflowWrap: 'anywhere' }}>
            outpoint (UTXO id)
            <InfoTip title="An outpoint is txid:vout. It uniquely identifies the UTXO that currently backs this shard. Pool operations spend this outpoint to advance shard state." />
            : <OutpointLink outpoint={shard.outpoint} />
          </div>

          <div style={{ fontSize: 12, opacity: 0.75 }}>
            This outpoint is the on-chain UTXO that currently backs this shard. Pool operations spend it to advance shard
            state.
          </div>

          {/* UPDATED COMMITMENT SECTION */}
          <div style={{ overflowWrap: 'anywhere' }}>
            commitment
            <InfoTip title="This is the shard’s state commitment bound into the covenant. It is used to verify shard state transitions. Explorers generally can’t search this directly, so the link opens the anchoring transaction." />
            : <CommitmentView commitment={shard.commitment} outpoint={shard.outpoint} />
          </div>
        </div>
      )}
    </div>
  );
}

export function PoolInitTab(props: {
  run: (args: { label: string; argv: string[] }) => Promise<RunResult>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;

  const [busy, setBusy] = useState(false);
  const [lastInit, setLastInit] = useState<RunResult | null>(null);
  const [lastShards, setLastShards] = useState<RunResult | null>(null);
  const [selectedShardIndex, setSelectedShardIndex] = useState<number | null>(null);

  const canInit = useMemo(() => !disableAll && !busy, [disableAll, busy]);

  const shardsParsed = useMemo(() => {
    if (!lastShards?.stdout) return null;
    return parsePoolShardsStdout(lastShards.stdout);
  }, [lastShards]);

  useMemo(() => {
    const list = shardsParsed?.shards ?? [];
    if (!list.length) {
      if (selectedShardIndex !== null) setSelectedShardIndex(null);
      return;
    }
    if (selectedShardIndex === null) {
      setSelectedShardIndex(list[0].index);
      return;
    }
    if (!list.some((s) => s.index === selectedShardIndex)) {
      setSelectedShardIndex(list[0].index);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shardsParsed?.shards?.length]);

  const selectedShard = useMemo(() => {
    const list = shardsParsed?.shards ?? [];
    if (!list.length || selectedShardIndex === null) return null;
    return list.find((s) => s.index === selectedShardIndex) ?? null;
  }, [shardsParsed, selectedShardIndex]);

  const initTxid = useMemo(() => {
    if (!lastInit?.stdout) return null;
    return extractInitTxid(lastInit.stdout);
  }, [lastInit]);

  const refreshShards = async () => {
    const res = await run({ label: 'pool:shards', argv: ['pool', 'shards'] });
    setLastShards(res);
  };

  const doInit = async () => {
    setBusy(true);
    try {
      const initRes = await run({ label: 'pool:init', argv: ['pool', 'init'] });
      setLastInit(initRes);

      if (initRes.code === 0) {
        const shardsRes = await run({ label: 'pool:shards', argv: ['pool', 'shards'] });
        setLastShards(shardsRes);
      }
    } finally {
      setBusy(false);
    }
  };

  const explorerUrl = useMemo(() => {
    if (!initTxid) return null;
    return `https://chipnet.chaingraph.cash/tx/${initTxid}`;
  }, [initTxid]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>Pool init (create shards)</div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button disabled={!canInit} onClick={doInit}>
          {busy ? 'Initializing…' : 'Init pool (8 shards)'}
        </button>

        <button disabled={disableAll || busy} onClick={refreshShards}>
          Refresh shards
        </button>

        {initTxid ? (
          <div style={{ fontSize: 13, opacity: 0.9 }}>
            init txid: <code>{initTxid}</code>{' '}
            {explorerUrl ? (
              <a href={explorerUrl} target="_blank" rel="noreferrer">
                (explorer)
              </a>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Structured summary */}
      <div style={{ border: '1px solid #222', borderRadius: 8, padding: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Pool summary</div>

        {/* Brief rationale (3 sentences) */}
        <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.35, marginBottom: 10 }}>
          A local, wallet owned sharded pool lets the wallet move value through a private state machine without relying on
          shared mixers or custodians, while keeping all spending authority under the user’s keys. Multiple shards spread
          value across independent state cells, reducing linkability and enabling flexible change routing and liquidity.
          Later, those shard commitments become stable ZKP anchors so the wallet can prove correct confidential updates and
          withdrawals without disclosing amounts or linkage.
        </div>

        {/* Technical details */}
        {shardsParsed && shardsParsed.shardCount ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, opacity: 0.92 }}>
            {shardsParsed.statePath ? (
              <div>
                state: <code>{shardsParsed.statePath}</code>
              </div>
            ) : null}
            {shardsParsed.poolId ? (
              <div>
                poolId: <code>{shardsParsed.poolId}</code>
              </div>
            ) : null}
            {shardsParsed.category ? (
              <div>
                category: <code title={shardsParsed.category}>{shortHex(shardsParsed.category, 12)}</code>
              </div>
            ) : null}
            <div>
              shards: <code>{String(shardsParsed.shardCount)}</code>
              {typeof shardsParsed.totalSats === 'number' ? (
                <>
                  {' '}
                  · total: <code>{formatSats(shardsParsed.totalSats)} sats</code>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 13, opacity: 0.75 }}>
            Run <code>pool init</code> (and/or <code>pool shards</code>) to see pool status here.
          </div>
        )}
      </div>

      {/* Chart + details */}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 2, minWidth: 0 }}>
          {shardsParsed && shardsParsed.shards.length ? (
            <ShardChart
              shards={shardsParsed.shards}
              selectedIndex={selectedShardIndex}
              onSelect={(i) => setSelectedShardIndex(i)}
            />
          ) : (
            <div style={{ border: '1px solid #222', borderRadius: 8, padding: 10, opacity: 0.75 }}>
              No shards to chart yet.
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 320 }}>
          <ShardDetails shard={selectedShard} />
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

        {shardsParsed && shardsParsed.shards.length ? (
          <div style={{ overflow: 'auto', height: '100%' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.85 }}>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>#</th>

                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>value</th>

                  {/* ANCHOR: outpoint header with tooltip */}
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>
                    outpoint
                    <InfoTip title="Outpoint = txid:vout. This is the UTXO currently backing the shard and will be spent in the next shard update." />
                  </th>

                  {/* ANCHOR: commitment header with tooltip */}
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>
                    commitment
                    <InfoTip title="Shard state commitment enforced by the covenant. Not a txid; explorers usually can’t search it directly. Click opens the anchoring transaction." />
                  </th>
                </tr>
              </thead>

              <tbody>
                {/* ANCHOR: shards map row rendering (updated outpoint + commitment display) */}
                {shardsParsed.shards.map((r) => {
                  const isSel = selectedShardIndex === r.index;
                  const p = splitOutpoint(r.outpoint);
                  return (
                    <tr
                      key={r.index}
                      onClick={() => setSelectedShardIndex(r.index)}
                      style={{
                        cursor: 'pointer',
                        background: isSel ? '#10161d' : undefined,
                      }}
                      title="Click to select"
                    >
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', opacity: 0.9 }}>{r.index}</td>

                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', opacity: 0.9 }}>
                        {formatSats(r.valueSats)} sats
                      </td>

                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111' }}>
                        {p ? (
                          <span>
                            <a href={chipnetTxUrl(p.txid)} target="_blank" rel="noreferrer">
                              <code>{p.txid}</code>
                            </a>
                            <span style={{ opacity: 0.8 }}>:{p.vout}</span>
                          </span>
                        ) : (
                          <code>{r.outpoint}</code>
                        )}
                      </td>

                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111' }}>
                        {p ? (
                          <a
                            href={chipnetTxUrl(p.txid)}
                            target="_blank"
                            rel="noreferrer"
                            title="Open the transaction that currently anchors this shard (commitment is committed there)."
                          >
                            <code title={r.commitment}>{shortHex(r.commitment, 12)}</code>
                          </a>
                        ) : (
                          <code title={r.commitment}>{shortHex(r.commitment, 12)}</code>
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

      {/* Raw outputs: keep same styling across tabs */}
      <div style={{ display: 'flex', gap: 12, height: 260, minHeight: 260 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MostRecentResult
            title="Init output"
            result={lastInit}
            onClear={() => setLastInit(null)}
            disableClear={disableAll || busy}
            emptyText="Run pool init to see the most recent CLI output here."
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <MostRecentResult
            title="Shards output"
            result={lastShards}
            onClear={() => setLastShards(null)}
            disableClear={disableAll || busy}
            emptyText="Run pool shards to see the most recent CLI output here."
          />
        </div>
      </div>
    </div>
  );
}