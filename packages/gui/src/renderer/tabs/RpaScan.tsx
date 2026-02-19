// packages/gui/src/renderer/tabs/RpaScan.tsx
import React, { useState } from 'react';
import type { Actor } from '../hooks/useBchctl';

export function RpaScanTab(props: {
  run: (args: { profile: Actor; label: string; argv: string[] }) => Promise<void>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;
  const [who, setWho] = useState<Actor>('bob');
  const [windowBlocks, setWindowBlocks] = useState<string>('4000');
  const [includeMempool, setIncludeMempool] = useState<boolean>(true);
  const [updateState, setUpdateState] = useState<boolean>(true);

  const submit = async () => {
    const argv: string[] = ['scan', '--window', windowBlocks.trim()];
    if (includeMempool) argv.push('--include-mempool');
    if (updateState) argv.push('--update-state');
    await run({ profile: who, label: 'scan', argv });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>RPA scan + update state</div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          Profile:{' '}
          <select value={who} onChange={(e) => setWho(e.target.value as Actor)}>
            <option value="alice">alice</option>
            <option value="bob">bob</option>
          </select>
        </label>

        <label>
          Window blocks:{' '}
          <input value={windowBlocks} onChange={(e) => setWindowBlocks(e.target.value)} style={{ width: 120 }} />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={includeMempool} onChange={(e) => setIncludeMempool(e.target.checked)} />
          include mempool
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={updateState} onChange={(e) => setUpdateState(e.target.checked)} />
          update state
        </label>

        <button disabled={disableAll} onClick={submit}>
          Scan
        </button>
      </div>

      <div style={{ opacity: 0.85, fontSize: 13 }}>
        Uses: <code>scan --window N --include-mempool --update-state</code>
      </div>
    </div>
  );
}