// packages/gui/src/renderer/tabs/RpaSend.tsx
import React, { useState } from 'react';
import type { Actor } from '../hooks/useBchctl';

export function RpaSendTab(props: {
  run: (args: { profile: Actor; label: string; argv: string[] }) => Promise<void>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;
  const [from, setFrom] = useState<Actor>('alice');
  const [toProfile, setToProfile] = useState<Actor>('bob');
  const [sats, setSats] = useState<string>('2000');
  const [dryRun, setDryRun] = useState<boolean>(false);

  const submit = async () => {
    const argv = ['send', '--to-profile', toProfile, sats.trim()];
    if (dryRun) argv.push('--dry-run');
    await run({ profile: from, label: 'send:paycode', argv });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>RPA send (paycode)</div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          From:{' '}
          <select value={from} onChange={(e) => setFrom(e.target.value as Actor)}>
            <option value="alice">alice</option>
            <option value="bob">bob</option>
          </select>
        </label>

        <label>
          To profile:{' '}
          <select value={toProfile} onChange={(e) => setToProfile(e.target.value as Actor)}>
            <option value="alice">alice</option>
            <option value="bob">bob</option>
          </select>
        </label>

        <label>
          Sats:{' '}
          <input value={sats} onChange={(e) => setSats(e.target.value)} style={{ width: 120 }} />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          dry-run
        </label>

        <button disabled={disableAll || from === toProfile} onClick={submit}>
          Send via paycode
        </button>
      </div>

      <div style={{ opacity: 0.85, fontSize: 13 }}>
        Uses: <code>send --to-profile &lt;name&gt; &lt;sats&gt;</code>
      </div>
    </div>
  );
}