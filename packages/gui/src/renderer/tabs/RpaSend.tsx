// packages/gui/src/renderer/tabs/RpaSend.tsx
import React, { useMemo, useState } from 'react';
import type { RunResult } from '../hooks/useBchctl';
import { MostRecentResult } from '../components/MostRecentResult';

export function RpaSendTab(props: {
  run: (args: { label: string; argv: string[] }) => Promise<RunResult>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;

  const [paycode, setPaycode] = useState<string>('');
  const [sats, setSats] = useState<string>('2000');
  const [dryRun, setDryRun] = useState<boolean>(false);

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
    if (!paycode.trim()) return false;
    if (!sats.trim()) return false;
    return true;
  }, [disableAll, busy, paycode, sats]);

  const submit = async () => {
    const pc = paycode.trim();
    const a = sats.trim();
    if (!pc || !a) return;

    const argv = ['send', pc, a];
    if (dryRun) argv.push('--dry-run');

    setBusy(true);
    try {
      const res = await run({ label: 'send:paycode', argv });
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>RPA send (paycode)</div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ flex: 1, minWidth: 420 }}>
          Paycode:{' '}
          <input
            style={{ width: '100%' }}
            value={paycode}
            onChange={(e) => setPaycode(e.target.value)}
            placeholder="PM8T..."
          />
        </label>

        <label>
          Sats:{' '}
          <input value={sats} onChange={(e) => setSats(e.target.value)} style={{ width: 120 }} />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          dry-run
        </label>

        <button disabled={!canSend} onClick={submit}>
          {busy ? 'Sending…' : 'Send via paycode'}
        </button>
      </div>

      <div style={{ opacity: 0.85, fontSize: 13 }}>
        Uses: <code>send &lt;paycode&gt; &lt;sats&gt;</code>
      </div>

      <MostRecentResult
        title="Last result"
        result={last}
        onClear={() => setLast(null)}
        disableClear={disableAll || busy}
        emptyText="Run a paycode send to see the most recent CLI output here."
      />
    </div>
  );
}