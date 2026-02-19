// packages/gui/src/renderer/tabs/TransparentSend.tsx
import React, { useState } from 'react';

export function TransparentSendTab(props: {
  run: (args: { label: string; argv: string[] }) => Promise<void>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;
  const [dest, setDest] = useState<string>('');
  const [sats, setSats] = useState<string>('2000');
  const [dryRun, setDryRun] = useState<boolean>(false);

  const submit = async () => {
    const argv = ['send', dest.trim(), sats.trim(), '--no-paycode'];
    if (dryRun) argv.push('--dry-run');
    await run({ label: 'send:cashaddr', argv });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>Transparent chain send (cashaddr)</div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ flex: 1, minWidth: 420 }}>
          To cashaddr:{' '}
          <input
            style={{ width: '100%' }}
            value={dest}
            onChange={(e) => setDest(e.target.value)}
            placeholder="bitcoincash:... or bchtest:..."
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

        <button disabled={disableAll || !dest.trim()} onClick={submit}>
          Send
        </button>
      </div>

      <div style={{ opacity: 0.85, fontSize: 13 }}>
        Uses: <code>send &lt;cashaddr&gt; &lt;sats&gt; --no-paycode</code>
      </div>
    </div>
  );
}