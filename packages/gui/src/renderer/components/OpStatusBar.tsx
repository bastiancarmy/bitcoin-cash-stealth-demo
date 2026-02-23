// packages/gui/src/renderer/components/OpStatusBar.tsx
import React from 'react';

export type OpStatus = {
  kind: 'idle' | 'running' | 'success' | 'error';
  title: string;
  detail?: string;
  progress: { cur: number; total: number } | null;
};

export function OpStatusBar(props: { status: OpStatus; onClear?: () => void }) {
  const { status, onClear } = props;

  const bg =
    status.kind === 'error'
      ? '#2a0f0f'
      : status.kind === 'success'
        ? '#102414'
        : status.kind === 'running'
          ? '#0f1a2a'
          : '#101010';

  const border =
    status.kind === 'error'
      ? '#6a2a2a'
      : status.kind === 'success'
        ? '#2a6a3a'
        : status.kind === 'running'
          ? '#2a3f6a'
          : '#222';

  const pct =
    status.progress && status.progress.total > 0
      ? Math.max(0, Math.min(1, status.progress.cur / status.progress.total))
      : null;

  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 10, overflow: 'hidden', background: bg }}>
      <div style={{ height: 4, width: pct != null ? `${Math.floor(pct * 100)}%` : '0%', background: '#4aa3ff' }} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '8px 10px' }}>
        <div style={{ fontWeight: 800, fontSize: 13 }}>{status.title}</div>
        <div
          style={{
            opacity: 0.8,
            fontSize: 12,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: 1,
          }}
        >
          {status.detail ?? ''}
        </div>
        {onClear ? (
          <button onClick={onClear} style={{ fontSize: 12 }}>
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}