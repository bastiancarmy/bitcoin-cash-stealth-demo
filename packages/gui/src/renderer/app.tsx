// packages/gui/src/renderer/app.tsx
import React, { useEffect, useMemo, useState } from 'react';
import { useBchctl, type ProfileId, type RunResult } from './hooks/useBchctl';
import type { AppInfo, ConfigJsonV1, PoolShardsJson, WalletRpaUtxosJson, WalletShowJson, WalletUtxosJson } from './types';
import { tryParseJson } from './types';

import { Gauges, type ProfileState } from './components/Gauges';
import { LogPane } from './components/LogPane';

import { TransparentSendTab } from './tabs/TransparentSend';
import { RpaSendTab } from './tabs/RpaSend';
import { RpaScanTab } from './tabs/RpaScan';
import { PoolInitTab } from './tabs/PoolInit';
import { PoolImportTab } from './tabs/PoolImport';

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

  const tabs: Array<[TabKey, string]> = useMemo(
    () => [
      ['transparent', 'Transparent send'],
      ['rpa_send', 'RPA send'],
      ['rpa_scan', 'RPA scan'],
      ['pool_init', 'Pool init'],
      ['pool_import', 'Pool import'],
      ['pool_withdraw', 'Pool withdraw'],
    ],
    []
  );

  const reloadConfig = async () => {
    try {
      const cfgRes = await window.bchStealth.getConfig();
      if (cfgRes?.ok && cfgRes.config) {
        setConfig(cfgRes.config);
        return cfgRes.config;
      }
    } catch {
      // ignore
    }
    return null;
  };

  const reloadProfilesFromDisk = async () => {
    try {
      const list = await window.bchStealth.listProfiles();
      const uniq = Array.from(new Set((list ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))).sort();
      setProfiles(uniq);
      return uniq;
    } catch {
      setProfiles([]);
      return [];
    }
  };

  useEffect(() => {
    const run0 = async () => {
      const info = (await window.bchStealth.appInfo()) as AppInfo;
      setAppInfo(info);

      const cfg = await reloadConfig();
      const profs = await reloadProfilesFromDisk();

      const fallback =
        String(info?.activeProfile ?? cfg?.currentProfile ?? '').trim() ||
        (profs.length ? profs[0] : '') ||
        'default';

      setActiveProfile(fallback);
    };

    void run0();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshActive = async (who: string) => {
    if (!who) return;

    // wallet show
    {
      try {
        const result = await bch.runText({
          profile: who,
          label: 'wallet:show',
          argv: ['wallet', 'show', '--json'],
          timeoutMs: 45_000,
        });

        const stdout = result?.stdout ?? '';
        const json = (tryParseJson<WalletShowJson>(stdout) ?? null) as WalletShowJson | null;
        setState((cur) => ({ ...cur, show: json }));
      } catch {
        setState((cur) => ({ ...cur, show: null }));
      }
    }

    // base utxos
    {
      try {
        const result = await bch.runText({
          profile: who,
          label: 'wallet:utxos',
          argv: ['wallet', 'utxos', '--json', '--include-unconfirmed'],
          timeoutMs: 45_000,
        });

        const stdout = result?.stdout ?? '';
        const json = (tryParseJson<WalletUtxosJson>(stdout) ?? null) as WalletUtxosJson | null;
        setState((cur) => ({ ...cur, base: json }));
      } catch {
        setState((cur) => ({ ...cur, base: null }));
      }
    }

    // stealth utxos (rpa-utxos)
    {
      try {
        const result = await bch.runText({
          profile: who,
          label: 'wallet:rpa-utxos',
          argv: ['wallet', 'rpa-utxos', '--json'],
          timeoutMs: 45_000,
        });

        const stdout = result?.stdout ?? '';
        const json = (tryParseJson<WalletRpaUtxosJson>(stdout) ?? null) as WalletRpaUtxosJson | null;
        setState((cur) => ({ ...cur, stealth: json }));
      } catch {
        setState((cur) => ({ ...cur, stealth: null }));
      }
    }

    // pool shards
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

  const refreshNow = async () => {
    await reloadProfilesFromDisk();
    await reloadConfig();
    await refreshActive(activeProfile);
  };

  const initWallet = async () => {
    await bch.runText({ profile: activeProfile, label: 'wallet:init', argv: ['wallet', 'init'] });
    await refreshNow();
  };

  // Existing "safe" runner: refreshes after each command
  const run = async (args: { label: string; argv: string[]; timeoutMs?: number }): Promise<RunResult> => {
    const res = await bch.runText({
      profile: activeProfile,
      label: args.label,
      argv: args.argv,
      timeoutMs: args.timeoutMs,
    });
    await refreshNow();
    return res;
  };

  // New "fast" runner for batch flows: no gauge refresh
  const runFast = async (args: { label: string; argv: string[]; timeoutMs?: number }): Promise<RunResult> => {
    return bch.runText({
      profile: activeProfile,
      label: args.label,
      argv: args.argv,
      timeoutMs: args.timeoutMs,
    });
  };

  useEffect(() => {
    if (!activeProfile) return;
    void refreshActive(activeProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile]);

  const setActiveAndPersist = async (nextProfile: string) => {
    const next = String(nextProfile ?? '').trim();
    if (!next || next === activeProfile) return;

    setActiveProfile(next);

    try {
      const res = await window.bchStealth.setCurrentProfile(next);
      if (res?.ok) {
        await reloadConfig();
      }
    } catch {
      // ignore
    }
  };

  const onSelectProfile = async (p: string) => {
    const next = String(p ?? '').trim();
    if (!next) return;
    await setActiveAndPersist(next);
  };

  const renderTab = () => {
    const disableAll = bch.isRunning;

    if (tab === 'transparent') return <TransparentSendTab run={run} disableAll={disableAll} />;
    if (tab === 'rpa_send') return <RpaSendTab run={run} disableAll={disableAll} />;

    // Updated tabs get fast/batched runner support
    if (tab === 'rpa_scan')
      return (
        <RpaScanTab
          run={run}
          runFast={runFast}
          refreshNow={refreshNow}
          disableAll={disableAll}
          profile={activeProfile}
        />
      );
    if (tab === 'pool_init')
      return <PoolInitTab profile={activeProfile} run={run} runFast={runFast} refreshNow={refreshNow} disableAll={disableAll} />;
    if (tab === 'pool_import')
      return (
        <PoolImportTab
          run={run}
          runFast={runFast}
          refreshNow={refreshNow}
          disableAll={disableAll}
          profile={activeProfile}
        />
      );

    if (tab === 'pool_withdraw') return <PlaceholderTab title="Pool withdraw" />;

    return null;
  };

  const disableAll = bch.isRunning;

  return (
    <div style={{ padding: 16, color: '#eee', background: '#050505', height: '100vh', boxSizing: 'border-box' }}>
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

      <div style={{ marginTop: 12 }}>
        <Gauges profile={activeProfile} state={state} onRefresh={refreshNow} onInitWallet={initWallet} disableAll={disableAll} />
      </div>

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
          <LogPane lines={bch.lines} onClear={bch.clearLog} activeTab={tab} />
        </div>
      </div>

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
        {profiles?.length ? (
          <span>
            {' '}
            | profiles on disk: <code>{profiles.length}</code>
          </span>
        ) : null}
      </div>
    </div>
  );
}