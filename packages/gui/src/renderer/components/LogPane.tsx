// packages/gui/src/renderer/components/LogPane.tsx
import React, { useMemo, useRef } from 'react';
import type { ConsoleLine } from '../hooks/useBchctl';
import { chipnetExplorerTxUrl, extractTxidsFromText } from '../types';

export function LogPane(props: {
  lines: ConsoleLine[];
  onClear: () => void;
}) {
  const { lines, onClear } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);

  const txids = useMemo(() => {
    const text = lines.map((l) => l.text).join('\n');
    return extractTxidsFromText(text).slice(0, 12);
  }, [lines]);

  const copyAll = async () => {
    const text = lines
      .map((l) => {
        const t = new Date(l.ts).toISOString();
        const tag = `${l.profile}:${l.label}:${l.stream}`;
        return `[${t}] ${tag} ${l.text}`;
      })
      .join('');
    await navigator.clipboard.writeText(text);
  };

  const scrollToBottom = () => {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ fontWeight: 700 }}>Log</div>
        <button onClick={scrollToBottom}>Scroll</button>
        <button onClick={copyAll}>Copy</button>
        <button onClick={onClear}>Clear</button>
        <div style={{ marginLeft: 'auto', opacity: 0.8 }}>
          {txids.length ? (
            <span>
              TXIDs:{' '}
              {txids.map((t) => (
                <a key={t} href={chipnetExplorerTxUrl(t)} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                  {t.slice(0, 10)}…
                </a>
              ))}
            </span>
          ) : (
            <span>No TXIDs detected</span>
          )}
        </div>
      </div>

      <div
        ref={boxRef}
        style={{
          background: '#0b0b0b',
          border: '1px solid #222',
          borderRadius: 8,
          padding: 10,
          overflow: 'auto',
          height: '100%',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 12,
          lineHeight: 1.35,
          whiteSpace: 'pre-wrap',
        }}
      >
        {lines.map((l, i) => {
          const prefix = `${l.profile}:${l.label}:${l.stream}`;
          const color = l.stream === 'stderr' ? '#ff6b6b' : '#d7d7d7';
          return (
            <div key={`${l.opId}:${i}`} style={{ color }}>
              <span style={{ opacity: 0.7 }}>[{prefix}] </span>
              <span>{l.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}