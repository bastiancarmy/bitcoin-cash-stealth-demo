// packages/gui/src/renderer/tabs/PoolWithdraw.tsx
import React, { useState } from 'react';
import type { Actor } from '../hooks/useBchctl';

export function PoolWithdrawTab(props: {
  run: (args: { profile: Actor; label: string; argv: string[] }) => Promise<void>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;
  const [who, setWho] = useState<Actor>('bob');

  const submit = async () => {
    await run({ profile: who, label: 'pool:withdraw', argv: ['pool', 'withdraw'] });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>Pool withdraw</div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          Profile:{' '}
          <select value={who} onChange={(e) => setWho(e.target.value as Actor)}>
            <option value="alice">alice</option>
            <option value="bob">bob</option>
          </select>
        </label>

        <button disabled={disableAll} onClick={submit}>
          pool withdraw
        </button>
      </div>

      <div style={{ opacity: 0.85, fontSize: 13 }}>
        Uses: <code>pool withdraw</code>
      </div>
    </div>
  );
}