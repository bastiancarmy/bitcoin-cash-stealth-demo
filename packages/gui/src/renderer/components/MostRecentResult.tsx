// packages/gui/src/renderer/components/MostRecentResult.tsx
import React, { useMemo } from 'react';

export type MostRecentLike = {
  ts?: number;          // optional (we'll fall back to Date.now() formatting if missing)
  argv?: string[];      // optional
  code: number;
  stdout?: string;
  stderr?: string;
};

function fmtArg(a: string): string {
  return a.includes(' ') ? JSON.stringify(a) : a;
}

export function MostRecentResult(props: {
  title: string;
  result: MostRecentLike | null;
  onClear?: () => void;
  disableClear?: boolean;
  emptyText?: string;
  cmdPrefix?: string; // default: "bchctl"
}) {
  const {
    title,
    result,
    onClear,
    disableClear = false,
    emptyText = 'Run an action to see the most recent CLI output here.',
    cmdPrefix = 'bchctl',
  } = props;

  const formatted = useMemo(() => {
    if (!result) return '';
    const ts = typeof result.ts === 'number' ? result.ts : Date.now();
    const t = new Date(ts).toISOString();
    const argv = Array.isArray(result.argv) ? result.argv : [];
    const cmd = `${cmdPrefix} ${argv.map(fmtArg).join(' ')}`.trim();

    const parts: string[] = [];
    parts.push(`[${t}] ${cmd}`.trim());
    parts.push('');

    const so = String(result.stdout ?? '');
    const se = String(result.stderr ?? '');

    if (so.trim()) {
      parts.push('--- stdout ---');
      parts.push(so.trimEnd());
      parts.push('');
    }
    if (se.trim()) {
      parts.push('--- stderr ---');
      parts.push(se.trimEnd());
      parts.push('');
    }

    parts.push(`(exit ${result.code})`);
    return parts.join('\n');
  }, [result, cmdPrefix]);

  const statusText = useMemo(() => {
    if (!result) return '(none yet)';
    return result.code === 0 ? 'ok' : `error (exit ${result.code})`;
  }, [result]);

  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div style={{ opacity: 0.7, fontSize: 12 }}>{statusText}</div>
        {result && onClear ? (
          <button style={{ marginLeft: 'auto' }} onClick={onClear} disabled={disableClear}>
            Clear
          </button>
        ) : null}
      </div>

      <div
        style={{
          marginTop: 8,
          background: '#0b0b0b',
          border: '1px solid #222',
          borderRadius: 8,
          padding: 10,
          overflow: 'auto',
          height: '100%',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 12,
          lineHeight: 1.35,
          whiteSpace: 'pre-wrap',
        }}
      >
        {formatted || emptyText}
      </div>
    </div>
  );
}