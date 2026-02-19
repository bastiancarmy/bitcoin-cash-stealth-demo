// packages/gui/src/renderer/components/Gauges.tsx
import React, { useMemo, useState } from 'react';
import type { ProfileId } from '../hooks/useBchctl';
import type { PoolShardsJson, WalletRpaUtxosJson, WalletShowJson, WalletUtxosJson } from '../types';
import { sumUtxosSats } from '../types';

export type ProfileState = {
  show: WalletShowJson | null;
  base: WalletUtxosJson | null;
  stealth: WalletRpaUtxosJson | null;
  pool: PoolShardsJson | null;
};

export function Gauges(props: {
  profile: ProfileId;
  state: ProfileState;
  disableAll: boolean;
  onRefresh: () => Promise<void>;
  onInitWallet: () => Promise<void>;
}) {
  const { profile, state, disableAll, onRefresh, onInitWallet } = props;
  const [busy, setBusy] = useState(false);

  const baseSats = useMemo(() => sumUtxosSats(state.base), [state.base]);
  const stealthSats = useMemo(() => sumUtxosSats(state.stealth), [state.stealth]);
  const poolSats = useMemo(() => sumUtxosSats(state.pool), [state.pool]);

  const doRefresh = async () => {
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const doInitWallet = async () => {
    setBusy(true);
    try {
      await onInitWallet();
    } finally {
      setBusy(false);
    }
  };

  const hasWallet = !!state.show?.address || !!state.show?.paycode;

  return (
    <div
      style={{
        border: '1px solid #222',
        borderRadius: 10,
        padding: 12,
        background: '#0a0a0a',
        minWidth: 520,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{profile}</div>

        <button disabled={disableAll || busy} onClick={doRefresh}>
          Refresh
        </button>
        <button disabled={disableAll || busy} onClick={doInitWallet}>
          Init wallet
        </button>

        <div style={{ marginLeft: 'auto', opacity: 0.8, fontSize: 12 }}>
          {state.show?.address ? <span>{state.show.address}</span> : <span>(no cashaddr)</span>}
        </div>
      </div>

      {!hasWallet ? (
        <div style={{ marginTop: 10, opacity: 0.85, fontSize: 13 }}>Not initialized</div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 13, flexWrap: 'wrap' }}>
            <div>
              <div style={{ opacity: 0.7 }}>Base UTXOs</div>
              <div style={{ fontWeight: 700 }}>{baseSats.toString()} sats</div>
            </div>
            <div>
              <div style={{ opacity: 0.7 }}>RPA UTXOs</div>
              <div style={{ fontWeight: 700 }}>{stealthSats.toString()} sats</div>
            </div>
            <div>
              <div style={{ opacity: 0.7 }}>Pool shards</div>
              <div style={{ fontWeight: 700 }}>{poolSats.toString()} sats</div>
            </div>
          </div>

          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
            {state.show?.paycode ? (
              <div style={{ wordBreak: 'break-all' }}>
                <span style={{ opacity: 0.7 }}>paycode:</span> {state.show.paycode}
              </div>
            ) : (
              <div style={{ opacity: 0.7 }}>(no paycode)</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}