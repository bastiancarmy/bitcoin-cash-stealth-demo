// packages/gui/src/renderer/components/Gauges.tsx
import React, { useMemo, useState } from 'react';

export type ProfileState = {
  show: any | null;    // WalletShowJson-like
  base: any | null;    // WalletUtxosJson-like
  stealth: any | null; // WalletRpaUtxosJson-like
  pool: any | null;    // PoolShardsJson-like
};

function formatSats(s: any): string {
  try {
    const n = BigInt(String(s ?? '0'));
    return n.toLocaleString('en-US');
  } catch {
    const n = Number(s ?? 0);
    if (Number.isFinite(n)) return n.toLocaleString('en-US');
    return String(s ?? '0');
  }
}

function sumBaseUtxosSats(base: any | null): bigint {
  const utxos = Array.isArray(base?.utxos) ? base.utxos : [];
  let total = 0n;
  for (const u of utxos) {
    const v = BigInt(String(u?.value ?? u?.valueSats ?? 0));
    total += v;
  }
  return total;
}

function sumStealthUtxosSats(stealth: any | null): bigint {
  // wallet rpa-utxos --json typically has totalSats (string)
  if (stealth?.totalSats != null) {
    try {
      return BigInt(String(stealth.totalSats));
    } catch {
      // fall through
    }
  }
  const utxos = Array.isArray(stealth?.utxos) ? stealth.utxos : [];
  let total = 0n;
  for (const u of utxos) {
    if (u?.isSpent) continue;
    try {
      total += BigInt(String(u?.valueSats ?? u?.value ?? 0));
    } catch {
      // ignore
    }
  }
  return total;
}

function sumPoolShardsSats(pool: any | null): bigint {
  // pool shards --json typically has totalSats on meta as string
  const meta = pool?.meta ?? null;
  if (meta?.totalSats != null) {
    try {
      return BigInt(String(meta.totalSats));
    } catch {
      // fall through
    }
  }
  const shards = Array.isArray(pool?.shards) ? pool.shards : [];
  let total = 0n;
  for (const s of shards) {
    try {
      total += BigInt(String(s?.valueSats ?? s?.value ?? 0));
    } catch {
      // ignore
    }
  }
  return total;
}

function CopyPill(props: { label: string; value: string; mono?: boolean }) {
  const { label, value, mono } = props;
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    const v = String(value ?? '').trim();
    if (!v) return;
    try {
      await navigator.clipboard.writeText(v);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 900);
    } catch {
      // ignore
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ fontSize: 11, opacity: 0.7 }}>{label}</div>

      <button
        onClick={onCopy}
        disabled={!String(value ?? '').trim()}
        title="Click to copy"
        style={{
          width: '100%',
          textAlign: 'left',
          border: '1px solid #222',
          background: '#070707',
          color: '#eee',
          borderRadius: 10,
          padding: '10px 12px',
          cursor: String(value ?? '').trim() ? 'pointer' : 'not-allowed',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minWidth: 0,
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: mono
              ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
              : undefined,
            fontSize: mono ? 12 : 13,
            opacity: 0.95,
          }}
        >
          {String(value ?? '').trim() ? String(value) : '(not available)'}
        </span>

        <span
          style={{
            fontSize: 11,
            opacity: copied ? 1 : 0.75,
            padding: '4px 8px',
            borderRadius: 999,
            border: '1px solid #222',
            background: copied ? '#123319' : '#0b0b0b',
            whiteSpace: 'nowrap',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </span>
      </button>
    </div>
  );
}

function MetricTile(props: {
  title: string;
  sats: string;
  subline: string;
}) {
  const { title, sats, subline } = props;
  return (
    <div
      style={{
        border: '1px solid #222',
        background: '#070707',
        borderRadius: 12,
        padding: 12,
        minWidth: 220,
        flex: 1,
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.7 }}>{title}</div>
      <div style={{ marginTop: 6, fontSize: 22, fontWeight: 900, letterSpacing: 0.2 }}>
        {sats} <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.75 }}>sats</span>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>{subline}</div>
    </div>
  );
}

export function Gauges(props: {
  profile: string;
  state: ProfileState;
  onRefresh: () => void;
  onInitWallet: () => void;
  disableAll: boolean;
}) {
  const { profile, state, onRefresh, onInitWallet, disableAll } = props;

  const address = String(state.show?.address ?? '');
  const paycode = String(state.show?.paycode ?? '');

  const baseSats = useMemo(() => sumBaseUtxosSats(state.base), [state.base]);
  const stealthSats = useMemo(() => sumStealthUtxosSats(state.stealth), [state.stealth]);
  const poolSats = useMemo(() => sumPoolShardsSats(state.pool), [state.pool]);

  const baseCount = Array.isArray(state.base?.utxos) ? state.base.utxos.length : 0;
  const stealthShown = typeof state.stealth?.shown === 'number' ? state.stealth.shown : Array.isArray(state.stealth?.utxos) ? state.stealth.utxos.length : 0;
  const shardCount =
    typeof state.pool?.meta?.shardCount === 'number'
      ? state.pool.meta.shardCount
      : Array.isArray(state.pool?.shards)
        ? state.pool.shards.length
        : 0;

  return (
    <div
      style={{
        border: '1px solid #222',
        borderRadius: 14,
        padding: 14,
        background: '#060606',
      }}
    >
      <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', flexWrap: 'wrap' }}>
        {/* Left: profile + buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 260 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <div style={{ fontSize: 18, fontWeight: 900 }}>{profile}</div>
            <div style={{ fontSize: 11, opacity: 0.7 }}>active profile</div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={onRefresh}
              disabled={disableAll}
              style={{
                border: '1px solid #333',
                background: '#0b0b0b',
                color: '#eee',
                borderRadius: 10,
                padding: '8px 12px',
                cursor: disableAll ? 'not-allowed' : 'pointer',
                fontWeight: 700,
              }}
            >
              Refresh
            </button>

            <button
              onClick={onInitWallet}
              disabled={disableAll}
              style={{
                border: '1px solid #333',
                background: '#0b0b0b',
                color: '#eee',
                borderRadius: 10,
                padding: '8px 12px',
                cursor: disableAll ? 'not-allowed' : 'pointer',
                fontWeight: 700,
              }}
            >
              Init wallet
            </button>
          </div>

          <div style={{ fontSize: 11, opacity: 0.65 }}>
            Tip: click Address/Paycode to copy.
          </div>
        </div>

        {/* Center: big metric tiles */}
        <div style={{ flex: 2, minWidth: 520, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
          <MetricTile title="Base UTXOs" sats={formatSats(baseSats)} subline={`${baseCount} utxos`} />
          <MetricTile title="Stealth UTXOs" sats={formatSats(stealthSats)} subline={`${stealthShown} tracked`} />
          <MetricTile title="Pool shards" sats={formatSats(poolSats)} subline={`${shardCount} shards`} />
        </div>

        {/* Right: copyable identifiers */}
        <div style={{ flex: 1.2, minWidth: 420, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <CopyPill label="Cash address (base P2PKH)" value={address} mono />
          <CopyPill label="Paycode (RPA)" value={paycode} mono />
        </div>
      </div>
    </div>
  );
}