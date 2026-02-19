// packages/gui/src/renderer/tabs/PoolInit.tsx
import React, { useState } from 'react';
import type { Actor } from '../hooks/useBchctl';

export function PoolInitTab(props: {
  run: (args: { profile: Actor; label: string; argv: string[] }) => Promise<void>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;
  const [who, setWho] = useState<Actor>('alice');

  const submit = async () => {
    await run({ profile: who, label: 'pool:init', argv: ['pool', 'init'] });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>Pool init (shards)</div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          Profile:{' '}
          <select value={who} onChange={(e) => setWho(e.target.value as Actor)}>
            <option value="alice">alice</option>
            <option value="bob">bob</option>
          </select>
        </label>

        <button disabled={disableAll} onClick={submit}>
          pool init
        </button>
      </div>

      <div style={{ opacity: 0.85, fontSize: 13 }}>
        Uses: <code>pool init</code>
      </div>
    </div>
  );
}