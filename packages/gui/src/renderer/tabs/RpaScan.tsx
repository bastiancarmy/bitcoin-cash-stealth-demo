// packages/gui/src/renderer/tabs/RpaScan.tsx
import React, { useMemo, useState } from 'react';
import type { RunResult } from '../hooks/useBchctl';
import { MostRecentResult } from '../components/MostRecentResult';

export function RpaScanTab(props: {
  run: (args: { label: string; argv: string[] }) => Promise<RunResult>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;

  const [txid, setTxid] = useState<string>('');
  const [windowBlocks, setWindowBlocks] = useState<string>('4000');

  const [includeMempool, setIncludeMempool] = useState<boolean>(false);
  const [updateState, setUpdateState] = useState<boolean>(true);
  const [printAll, setPrintAll] = useState<boolean>(false);

  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<RunResult | null>(null);

  const txidLooksValid = useMemo(() => {
    const t = txid.trim();
    if (!t) return false;
    return /^[0-9a-fA-F]{64}$/.test(t);
  }, [txid]);

  const canScan = useMemo(() => {
    if (disableAll || busy) return false;
    // Current milestone: require txid (user said scan isn't fully functional yet)
    if (!txidLooksValid) return false;
    return true;
  }, [disableAll, busy, txidLooksValid]);

  const submit = async () => {
    const t = txid.trim();

    const argv: string[] = ['scan'];

    // Primary path for now: scan a single txid.
    if (t) {
      argv.push('--txid', t);
    } else {
      // Dev fallback (should be unreachable if canScan requires txid).
      const w = windowBlocks.trim();
      if (w) argv.push('--window', w);
    }

    if (includeMempool) argv.push('--include-mempool');
    if (updateState) argv.push('--update-state');
    if (printAll) argv.push('--all');

    setBusy(true);
    try {
      const res = await run({ label: 'scan', argv });
      setLast(res);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>RPA scan (import to state)</div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ flex: 1, minWidth: 520 }}>
          TXID:{' '}
          <input
            style={{ width: '100%' }}
            value={txid}
            onChange={(e) => setTxid(e.target.value)}
            placeholder="64-hex txid (e.g. 7363...6a2c)"
          />
        </label>

        <label>
          Window blocks:{' '}
          <input
            value={windowBlocks}
            onChange={(e) => setWindowBlocks(e.target.value)}
            style={{ width: 120 }}
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={includeMempool}
            onChange={(e) => setIncludeMempool(e.target.checked)}
          />
          include mempool
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={updateState}
            onChange={(e) => setUpdateState(e.target.checked)}
          />
          update state
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={printAll} onChange={(e) => setPrintAll(e.target.checked)} />
          all (debug)
        </label>

        <button disabled={!canScan} onClick={submit}>
          {busy ? 'Scanning…' : 'Scan'}
        </button>
      </div>

      <div style={{ opacity: 0.85, fontSize: 13 }}>
        Uses: <code>scan --txid &lt;txid&gt; [--include-mempool] [--update-state] [--all]</code>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <MostRecentResult
          title="Last result"
          result={last}
          onClear={() => setLast(null)}
          disableClear={disableAll || busy}
          emptyText="Run a scan to see the most recent CLI output here."
        />
      </div>
    </div>
  );
}