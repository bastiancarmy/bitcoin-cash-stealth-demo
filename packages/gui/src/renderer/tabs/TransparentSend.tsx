// packages/gui/src/renderer/tabs/TransparentSend.tsx
import React, { useMemo, useState } from 'react';
import { MostRecentResult } from '../components/MostRecentResult';

export type RunTextResult = {
  opId: string;
  code: number;
  stdout: string;
  stderr: string;
};

export function TransparentSendTab(props: {
  run: (args: { label: string; argv: string[] }) => Promise<RunTextResult>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;

  const [dest, setDest] = useState('');
  const [sats, setSats] = useState('2000');
  const [dryRun, setDryRun] = useState(true);

  const [last, setLast] = useState<{
    ts: number;
    argv: string[];
    code: number;
    stdout: string;
    stderr: string;
  } | null>(null);

  const [busy, setBusy] = useState(false);

  const canSend = useMemo(() => {
    if (disableAll || busy) return false;
    if (!dest.trim()) return false;
    if (!sats.trim()) return false;
    return true;
  }, [dest, sats, disableAll, busy]);

  const submit = async () => {
    const argv = ['send', dest.trim(), sats.trim(), '--no-paycode'];
    if (dryRun) argv.push('--dry-run');

    setBusy(true);
    try {
      const res = await run({ label: 'send:cashaddr', argv });
      setLast({
        ts: Date.now(),
        argv,
        code: res.code,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minWidth: 0 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>Transparent chain send (cashaddr)</div>

      {/* Form: destination stacked above sats */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
        <label style={{ width: '100%', minWidth: 0 }}>
          To cashaddr:
          <input
            style={{ width: '100%', marginTop: 6 }}
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder="bitcoincash:... or bchtest:..."
          />
        </label>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <label style={{ width: 220 }}>
            Sats:
            <input
              value={sats}
              onChange={(e) => setSats(e.target.value)}
              style={{ width: '100%', marginTop: 6 }}
            />
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.9 }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            dry-run
          </label>

          <button disabled={!canSend} onClick={submit}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>

      <div style={{ opacity: 0.85, fontSize: 13 }}>
        Uses: <code>send &lt;cashaddr&gt; &lt;sats&gt; --no-paycode</code>
      </div>

      <MostRecentResult
        title="Last result"
        result={last}
        onClear={() => setLast(null)}
        disableClear={disableAll || busy}
        emptyText="Run a send to see the most recent CLI output here."
      />
    </div>
  );
}