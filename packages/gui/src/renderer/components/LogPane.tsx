import React, { useMemo, useRef, useState } from 'react';
import type { ConsoleLine } from '../hooks/useBchctl';
import { chipnetExplorerTxUrl, extractTxidsFromText } from '../types';

function isRoutineLabel(label: string): boolean {
  return (
    label === 'wallet:show' ||
    label === 'wallet:utxos' ||
    label === 'wallet:rpa-utxos' ||
    label === 'pool:shards' ||
    label === 'pool:deposits' ||
    label === 'pool:deposits:all'
  );
}

const tabFilters: Record<string, (label: string) => boolean> = {
  pool_import: (label) =>
    label.startsWith('scan') ||
    label.startsWith('wallet:rpa-utxos') ||
    label.startsWith('pool:deposits') ||
    label.startsWith('pool:stage-from') ||
    label.startsWith('pool:import'),

  pool_init: (label) => label.startsWith('pool:init') || label.startsWith('pool:shards'),

  rpa_scan: (label) => label.startsWith('scan'),

  rpa_send: (label) => label.startsWith('send') || label.startsWith('wallet:'),

  transparent: (label) => label.startsWith('send') || label.startsWith('wallet:'),
};

export function LogPane(props: {
  lines: ConsoleLine[];
  onClear: () => void;
  activeTab?: string;
}) {
  const { lines, onClear, activeTab } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);

  const [hideRoutine, setHideRoutine] = useState<boolean>(true);
  const [stderrOnly, setStderrOnly] = useState<boolean>(false);
  const [onlyThisTab, setOnlyThisTab] = useState<boolean>(false);

  const visibleLines = useMemo(() => {
    let out = lines;

    if (onlyThisTab && activeTab && tabFilters[activeTab]) {
      const allow = tabFilters[activeTab];
      out = out.filter((l) => allow(l.label));
    }

    // If user explicitly wants “only this tab”, don’t hide “routine” for that view.
    const applyHideRoutine = hideRoutine && !onlyThisTab;

    out = out.filter((l) => {
      if (stderrOnly && l.stream !== 'stderr') return false;
      if (applyHideRoutine && isRoutineLabel(l.label)) return false;
      return true;
    });

    return out;
  }, [lines, hideRoutine, stderrOnly, onlyThisTab, activeTab]);

  const txids = useMemo(() => {
    const text = visibleLines.map((l) => l.text).join('\n');
    return extractTxidsFromText(text).slice(0, 12);
  }, [visibleLines]);

  const copyAll = async () => {
    const text = visibleLines
      .map((l) => {
        const t = new Date(l.ts).toISOString();
        const tag = `${l.profile}:${l.label}:${l.stream}`;
        return `[${t}] ${tag} ${l.text}`;
      })
      .join('');
    await navigator.clipboard.writeText(text);
  };

  const scrollToTop = () => {
    const el = boxRef.current;
    if (!el) return;
    el.scrollTop = 0;
  };

  // Latest-first view
  const rendered = useMemo(() => visibleLines.slice().reverse(), [visibleLines]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700 }}>Log</div>

        <button onClick={scrollToTop}>Top</button>
        <button onClick={copyAll}>Copy</button>
        <button onClick={onClear}>Clear</button>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
          <input type="checkbox" checked={onlyThisTab} onChange={(e) => setOnlyThisTab(e.target.checked)} />
          this tab
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
          <input type="checkbox" checked={hideRoutine} onChange={(e) => setHideRoutine(e.target.checked)} />
          hide routine
        </label>

        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, opacity: 0.85 }}>
          <input type="checkbox" checked={stderrOnly} onChange={(e) => setStderrOnly(e.target.checked)} />
          stderr only
        </label>

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
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          fontSize: 12,
          lineHeight: 1.35,
          whiteSpace: 'pre-wrap',
        }}
      >
        {rendered.map((l, i) => {
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