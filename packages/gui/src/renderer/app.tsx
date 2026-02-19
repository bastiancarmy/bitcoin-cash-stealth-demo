// packages/gui/src/renderer/app.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useBchctl, type ProfileId } from './hooks/useBchctl';
import type { AppInfo, ConfigJsonV1, PoolShardsJson, WalletRpaUtxosJson, WalletShowJson, WalletUtxosJson } from './types';
import { tryParseJson } from './types';

import { Gauges, type ProfileState } from './components/Gauges';
import { LogPane } from './components/LogPane';

import { TransparentSendTab } from './tabs/TransparentSend';

type TabKey = 'transparent' | 'rpa_send' | 'rpa_scan' | 'pool_init' | 'pool_import' | 'pool_withdraw';

function PlaceholderTab(props: { title: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>{props.title}</div>
      <div style={{ opacity: 0.85, fontSize: 13 }}>Coming soon</div>
    </div>
  );
}

export default function App() {
  const bch = useBchctl();

  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [config, setConfig] = useState<ConfigJsonV1 | null>(null);

  const [profiles, setProfiles] = useState<string[]>([]);
  const [activeProfile, setActiveProfile] = useState<ProfileId>('default');

  const [tab, setTab] = useState<TabKey>('transparent');

  const [state, setState] = useState<ProfileState>({
    show: null,
    base: null,
    stealth: null,
    pool: null,
  });

  // bootstrap (app info + config)
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const info = (await window.bchStealth.appInfo()) as AppInfo;
      if (cancelled) return;
      setAppInfo(info);

      const cfgRes = await window.bchStealth.getConfig();
      if (cancelled) return;

      if (cfgRes?.ok && cfgRes.config) {
        setConfig(cfgRes.config);
        const keys = Object.keys(cfgRes.config.profiles ?? {}).sort();
        setProfiles(keys.length ? keys : ['default']);

        const initial = String(info.activeProfile ?? cfgRes.config.currentProfile ?? 'default').trim() || 'default';
        setActiveProfile(initial);
      } else {
        setProfiles(['default']);
        setActiveProfile(String(info.activeProfile ?? 'default'));
      }
    })().catch(() => {
      // ignore bootstrap errors; UI remains usable for manual actions
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const tabs = useMemo(
    () =>
      [
        ['transparent', 'Transparent send'] as const,
        ['rpa_send', 'RPA send'] as const,
        ['rpa_scan', 'RPA scan'] as const,
        ['pool_init', 'Pool init'] as const,
        ['pool_import', 'Pool import'] as const,
        ['pool_withdraw', 'Pool withdraw'] as const,
      ] satisfies Array<readonly [TabKey, string]>,
    []
  );

  const refreshActive = async (who: ProfileId) => {
    // wallet show
    {
      const { json } = await bch.runJson<WalletShowJson>({
        profile: who,
        label: 'wallet:show',
        argv: ['wallet', 'show', '--json'],
      });
      setState((cur) => ({ ...cur, show: json }));
    }

    // wallet utxos
    {
      const result = await bch.runText({
        profile: who,
        label: 'wallet:utxos',
        argv: ['wallet', 'utxos', '--json', '--include-unconfirmed'],
      });

      const stdout = result?.stdout ?? '';
      const json = (tryParseJson<WalletUtxosJson>(stdout) ?? null) as WalletUtxosJson | null;
      setState((cur) => ({ ...cur, base: json }));
    }

    // wallet rpa-utxos
    {
      const result = await bch.runText({
        profile: who,
        label: 'wallet:rpa-utxos',
        argv: ['wallet', 'rpa-utxos', '--json'],
      });

      const stdout = result?.stdout ?? '';
      const json = (tryParseJson<WalletRpaUtxosJson>(stdout) ?? null) as WalletRpaUtxosJson | null;
      setState((cur) => ({ ...cur, stealth: json }));
    }

    // pool shards (must not hard-fail refresh)
    {
      try {
        const result = await bch.runText({
          profile: who,
          label: 'pool:shards',
          argv: ['pool', 'shards', '--json'],
          timeoutMs: 45_000,
        });

        const stdout = result?.stdout ?? '';
        const json = (tryParseJson<PoolShardsJson>(stdout) ?? null) as PoolShardsJson | null;
        setState((cur) => ({ ...cur, pool: json }));
      } catch {
        setState((cur) => ({ ...cur, pool: null }));
      }
    }
  };

  const refresh = async () => {
    await refreshActive(activeProfile);
  };

  const initWallet = async () => {
    await bch.runText({ profile: activeProfile, label: 'wallet:init', argv: ['wallet', 'init'] });
    await refreshActive(activeProfile);
  };

  const run = async (args: { label: string; argv: string[] }) => {
    await bch.runText({ profile: activeProfile, label: args.label, argv: args.argv });
    await refreshActive(activeProfile);
  };

  // auto refresh gauges on first load or profile change
  useEffect(() => {
    if (!activeProfile) return;
    void refreshActive(activeProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile]);

  const onSelectProfile = async (p: string) => {
    const next = String(p ?? '').trim();
    if (!next || next === activeProfile) return;

    setActiveProfile(next);

    // Persist currentProfile (best-effort; do not block UX)
    try {
      const res = await window.bchStealth.setCurrentProfile(next);
      if (res?.ok) {
        const cfgRes = await window.bchStealth.getConfig();
        if (cfgRes?.ok && cfgRes.config) {
          setConfig(cfgRes.config);
          setProfiles(Object.keys(cfgRes.config.profiles ?? {}).sort());
        }
      }
    } catch {
      // ignore
    }
  };

  const renderTab = () => {
    const disableAll = bch.isRunning;

    if (tab === 'transparent') return <TransparentSendTab run={run} disableAll={disableAll} />;
    if (tab === 'rpa_send') return <PlaceholderTab title="RPA send (paycode)" />;
    if (tab === 'rpa_scan') return <PlaceholderTab title="RPA scan + update state" />;
    if (tab === 'pool_init') return <PlaceholderTab title="Pool init (shards)" />;
    if (tab === 'pool_import') return <PlaceholderTab title="Pool import" />;
    if (tab === 'pool_withdraw') return <PlaceholderTab title="Pool withdraw" />;

    return null;
  };

  const disableAll = bch.isRunning;

  return (
    <div style={{ padding: 16, color: '#eee', background: '#050505', height: '100vh', boxSizing: 'border-box' }}>
      {/* Top bar */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontWeight: 900, fontSize: 20 }}>bch-stealth</div>

        <div style={{ opacity: 0.75, fontSize: 12 }}>
          {appInfo ? (
            <span>
              {appInfo.platform ?? ''} {appInfo.arch ?? ''} v{appInfo.appVersion ?? ''}{' '}
              {appInfo.isPackaged ? '(packaged)' : '(dev)'}
            </span>
          ) : (
            <span>(loading app info)</span>
          )}
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {appInfo?.launchProfile ? (
            <div style={{ opacity: 0.75, fontSize: 12 }}>launched with --profile {appInfo.launchProfile}</div>
          ) : null}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ opacity: 0.8, fontSize: 12 }}>Profile</span>
            <select
              value={activeProfile}
              onChange={(e) => void onSelectProfile(e.target.value)}
              style={{ background: '#0b0b0b', color: '#eee', border: '1px solid #333', borderRadius: 8, padding: 6 }}
              disabled={disableAll}
            >
              {profiles.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Gauges */}
      <div style={{ marginTop: 12 }}>
        <Gauges profile={activeProfile} state={state} onRefresh={refresh} onInitWallet={initWallet} disableAll={disableAll} />
      </div>

      {/* Tabs + log */}
      <div style={{ marginTop: 14, display: 'flex', gap: 12, height: 'calc(100vh - 190px)' }}>
        <div style={{ flex: 1.1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tabs.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                style={{
                  border: '1px solid #333',
                  background: tab === k ? '#1a1a1a' : '#0b0b0b',
                  color: '#eee',
                  borderRadius: 10,
                  padding: '8px 10px',
                  cursor: 'pointer',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={{ border: '1px solid #222', borderRadius: 10, padding: 12, background: '#0a0a0a', flex: 1 }}>
            {renderTab()}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 520 }}>
          <LogPane lines={bch.lines} onClear={bch.clearLog} />
        </div>
      </div>

      {/* Minimal footer diagnostics (optional) */}
      <div style={{ marginTop: 10, opacity: 0.6, fontSize: 11 }}>
        {appInfo?.dotDir ? (
          <span>
            storage: <code>{appInfo.dotDir}</code>
          </span>
        ) : null}
        {config ? (
          <span>
            {' '}
            | currentProfile in config: <code>{config.currentProfile}</code>
          </span>
        ) : null}
      </div>
    </div>
  );
}