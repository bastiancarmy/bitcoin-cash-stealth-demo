// packages/gui/src/renderer/tabs/PoolImport.tsx
import React, { useEffect, useMemo, useState } from 'react';
import type { RunResult } from '../hooks/useBchctl';
import { MostRecentResult } from '../components/MostRecentResult';
import {
  type LastRun,
  type DepositRow,
  buildPoolDepositsArgv,
  parsePoolDeposits,
  buildPoolStageArgv,
  buildPoolImportArgv,
  toLastRun,
  chipnetTxUrl,
  shortHex,
  formatSats,
  splitOutpoint,
} from './poolImportModel';

export function PoolImportTab(props: {
  run: (args: { label: string; argv: string[] }) => Promise<RunResult>;
  disableAll: boolean;
}) {
  const { run, disableAll } = props;

  const [busy, setBusy] = useState(false);

  // Stage panel state
  const [stageSats, setStageSats] = useState('2000');
  const [depositMode, setDepositMode] = useState<'rpa' | 'base'>('rpa');
  const [changeMode, setChangeMode] = useState<'auto' | 'transparent' | 'stealth'>('auto');

  // Deposit/ingest panel state
  const [useLatest, setUseLatest] = useState(true);
  const [outpoint, setOutpoint] = useState('');
  const [shardIndex, setShardIndex] = useState('');
  const [fresh, setFresh] = useState(false);

  const [allowBase, setAllowBase] = useState(false);
  const [depositWif, setDepositWif] = useState('');
  const [depositPrivHex, setDepositPrivHex] = useState('');

  // Staged deposits list state
  const [checkChain, setCheckChain] = useState(true);
  const [unimportedOnly, setUnimportedOnly] = useState(true);
  const [allowUnconfirmed, setAllowUnconfirmed] = useState(false);
  const [rows, setRows] = useState<DepositRow[]>([]);
  const [selectedOutpoint, setSelectedOutpoint] = useState<string>('');

  // Most recent outputs (tab-local)
  const [lastStage, setLastStage] = useState<LastRun | null>(null);
  const [lastDeposit, setLastDeposit] = useState<LastRun | null>(null);
  const [lastList, setLastList] = useState<LastRun | null>(null);

  const outpointParsed = useMemo(() => splitOutpoint(outpoint), [outpoint]);
  const stageSatsOk = useMemo(() => /^\d+$/.test(stageSats.trim()) && Number(stageSats) > 0, [stageSats]);

  async function loadDeposits() {
    const argv = buildPoolDepositsArgv({ unimportedOnly, checkChain });
    const res = await run({ label: 'pool:deposits', argv });
    setLastList(toLastRun(argv, res));

    const parsed = parsePoolDeposits(res.stdout ?? '');
    setRows(parsed.deposits);
  }

  useEffect(() => {
    void loadDeposits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadDeposits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkChain, unimportedOnly]);

  const canStage = useMemo(() => !disableAll && !busy && stageSatsOk, [disableAll, busy, stageSatsOk]);

  const canDeposit = useMemo(() => {
    if (disableAll || busy) return false;
    if (useLatest) return true;
    if (!outpoint.trim()) return false;
    return !!outpointParsed;
  }, [disableAll, busy, useLatest, outpoint, outpointParsed]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.outpoint === selectedOutpoint) ?? null,
    [rows, selectedOutpoint]
  );

  const onPickRow = (r: DepositRow) => {
    setSelectedOutpoint(r.outpoint);
    setUseLatest(false);
    setOutpoint(r.outpoint);
  };

  const runStage = async () => {
    const argv = buildPoolStageArgv({ sats: stageSats.trim(), depositMode, changeMode });
    setBusy(true);
    try {
      const res = await run({ label: 'pool:stage', argv });
      setLastStage(toLastRun(argv, res));
      await loadDeposits();
    } finally {
      setBusy(false);
    }
  };

  const runDepositIntoPool = async (mode: 'latest' | 'row' | 'manual') => {
    let outpointArg: string | null = null;
    let latest = false;

    if (mode === 'latest') {
      latest = true;
    } else if (mode === 'row') {
      outpointArg = selectedRow?.outpoint ?? null;
      if (!outpointArg) latest = true;
    } else {
      if (useLatest) latest = true;
      else outpointArg = outpointParsed ? `${outpointParsed.txid}:${outpointParsed.vout}` : null;
      if (!latest && !outpointArg) latest = true;
    }

    const argv = buildPoolImportArgv({
      outpoint: outpointArg,
      latest,
      shard: shardIndex,
      fresh,
      allowBase,
      depositWif,
      depositPrivHex,
    });

    setBusy(true);
    try {
      const res = await run({ label: 'pool:import', argv });
      setLastDeposit(toLastRun(argv, res));
      await loadDeposits();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>Pool deposit (stage → ingest)</div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', minHeight: 260 }}>
        {/* Stage pane */}
        <div style={{ flex: 1, minWidth: 520, border: '1px solid #222', borderRadius: 8, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontWeight: 700 }}>Stage deposit</div>
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              Uses: <code>pool stage</code> or <code>pool stage-from</code>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ minWidth: 80 }}>amount:</span>
              <input
                value={stageSats}
                onChange={(e) => setStageSats(e.target.value)}
                style={{ width: 160 }}
                placeholder="2000"
              />
              <span style={{ opacity: 0.75, fontSize: 12 }}>sats</span>
            </label>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>deposit mode:</span>
                <select value={depositMode} onChange={(e) => setDepositMode(e.target.value as any)}>
                  <option value="rpa">rpa (recommended)</option>
                  <option value="base">base (not stealth)</option>
                </select>
              </label>

              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>change mode:</span>
                <select value={changeMode} onChange={(e) => setChangeMode(e.target.value as any)}>
                  <option value="auto">auto</option>
                  <option value="transparent">transparent</option>
                  <option value="stealth">stealth</option>
                </select>
              </label>
            </div>

            {depositMode === 'base' ? (
              <div style={{ fontSize: 12, opacity: 0.8, border: '1px solid #333', borderRadius: 6, padding: 8 }}>
                Base deposits are not stealth. Only use this if your coins are already mixed externally.
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button disabled={!canStage} onClick={() => void runStage()}>
                {busy ? 'Staging…' : 'Stage deposit'}
              </button>

              <button disabled={disableAll || busy} onClick={() => void loadDeposits()}>
                Refresh staged deposits
              </button>

              <div style={{ opacity: 0.75, fontSize: 12 }}>
                For inbound (including unconfirmed) RPA receives, use <code>pool stage-from txid:vout</code> to promote
                the scanned UTXO into staged deposits.
              </div>
            </div>
          </div>
        </div>

        {/* Ingest pane */}
        <div style={{ flex: 1, minWidth: 520, border: '1px solid #222', borderRadius: 8, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontWeight: 700 }}>Deposit into pool</div>
            <div style={{ opacity: 0.7, fontSize: 12 }}>
              Uses: <code>pool import</code>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={useLatest} onChange={(e) => setUseLatest(e.target.checked)} />
              use <code>--latest</code> (prefers latest unimported staged deposit)
            </label>

            <label style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ minWidth: 110 }}>deposit outpoint:</span>
              <input
                style={{ flex: 1, minWidth: 260 }}
                value={outpoint}
                onChange={(e) => setOutpoint(e.target.value)}
                placeholder="txid:vout"
                disabled={useLatest}
              />
              {outpointParsed ? (
                <a href={chipnetTxUrl(outpointParsed.txid)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  explorer
                </a>
              ) : null}
            </label>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ minWidth: 220 }}>
                shard index:
                <input
                  style={{ width: '100%' }}
                  value={shardIndex}
                  onChange={(e) => setShardIndex(e.target.value)}
                  placeholder="(optional)"
                />
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} />
                fresh
              </label>
            </div>

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={allowBase} onChange={(e) => setAllowBase(e.target.checked)} />
                allow base (advanced)
              </label>
            </div>

            {allowBase ? (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <label style={{ flex: 1, minWidth: 320 }}>
                  deposit wif:{' '}
                  <input
                    style={{ width: '100%' }}
                    value={depositWif}
                    onChange={(e) => setDepositWif(e.target.value)}
                    placeholder="(optional)"
                  />
                </label>
                <label style={{ flex: 1, minWidth: 320 }}>
                  deposit privhex:{' '}
                  <input
                    style={{ width: '100%' }}
                    value={depositPrivHex}
                    onChange={(e) => setDepositPrivHex(e.target.value)}
                    placeholder="(optional)"
                  />
                </label>
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button disabled={!canDeposit} onClick={() => void runDepositIntoPool('manual')}>
                {busy ? 'Depositing…' : 'Deposit into pool'}
              </button>

              <button disabled={disableAll || busy} onClick={() => void runDepositIntoPool('latest')}>
                Deposit latest
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Staged deposits list */}
      <div style={{ border: '1px solid #222', borderRadius: 8, padding: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Staged deposits</div>
          <div style={{ opacity: 0.7, fontSize: 12 }}>
            Source: <code>pool deposits --json</code>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.85 }}>
            <input type="checkbox" checked={unimportedOnly} onChange={(e) => setUnimportedOnly(e.target.checked)} />
            unimported only
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.85 }}>
            <input type="checkbox" checked={checkChain} onChange={(e) => setCheckChain(e.target.checked)} />
            check chain
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.85 }}>
            <input
              type="checkbox"
              checked={allowUnconfirmed}
              onChange={(e) => setAllowUnconfirmed(e.target.checked)}
              disabled={!checkChain}
            />
            allow unconfirmed/unknown
          </label>

          <button style={{ marginLeft: 'auto' }} disabled={disableAll || busy} onClick={() => void loadDeposits()}>
            Refresh
          </button>
        </div>

        <div style={{ marginTop: 10, maxHeight: 220, overflow: 'auto' }}>
          {rows.length ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.85 }}>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>value</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>outpoint</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>kind</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }}>status</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid #222' }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const isSel = selectedOutpoint === r.outpoint;
                  const imported = !!r.importTxid;

                  // New behavior:
                  // - spent (false) always blocks
                  // - unknown (null) blocks only if allowUnconfirmed is OFF
                  const chainBad =
                    checkChain &&
                    (r.chainOk === false || (r.chainOk == null && !allowUnconfirmed));

                  const disabled = disableAll || busy || imported || chainBad;

                  const status = imported
                    ? 'imported'
                    : checkChain
                      ? (r.chainOk === true ? 'unspent' : r.chainOk === false ? 'spent' : 'unknown')
                      : 'unchecked';

                  return (
                    <tr
                      key={r.outpoint}
                      onClick={() => onPickRow(r)}
                      style={{
                        cursor: 'pointer',
                        background: isSel ? '#10161d' : undefined,
                        opacity: disabled ? 0.55 : 1,
                      }}
                      title="Click to select"
                    >
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111' }}>
                        {formatSats(r.valueSats)} sats
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111' }}>
                        <a href={chipnetTxUrl(r.txid)} target="_blank" rel="noreferrer">
                          <code>{shortHex(r.txid, 10)}</code>
                        </a>
                        <span style={{ opacity: 0.8 }}>:{r.vout}</span>
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', opacity: 0.85 }}>
                        <code>{r.depositKind || 'rpa'}</code>
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', opacity: 0.85 }}>
                        <code>{status}</code>
                        {r.importedIntoShard != null ? (
                          <span style={{ opacity: 0.8 }}> • shard={String(r.importedIntoShard)}</span>
                        ) : null}
                      </td>
                      <td style={{ padding: '6px 8px', borderBottom: '1px solid #111', textAlign: 'right' }}>
                        <button
                          disabled={disabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            onPickRow(r);
                            void runDepositIntoPool('row');
                          }}
                        >
                          {imported ? 'Imported' : 'Deposit'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ opacity: 0.75, fontSize: 12 }}>
              No staged deposits found. If you just received an RPA payment, promote it with{' '}
              <code>pool stage-from txid:vout</code>, then refresh.
            </div>
          )}
        </div>
      </div>

      {/* Most recent panes */}
      <div style={{ display: 'flex', gap: 12, minHeight: 260, flex: 1 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <MostRecentResult
            title="Stage output"
            result={lastStage}
            onClear={() => setLastStage(null)}
            disableClear={disableAll || busy}
            emptyText="Run Stage deposit to see the most recent CLI output here."
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <MostRecentResult
            title="Deposit output"
            result={lastDeposit}
            onClear={() => setLastDeposit(null)}
            disableClear={disableAll || busy}
            emptyText="Run Deposit into pool to see the most recent CLI output here."
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <MostRecentResult
            title="Staged deposits fetch output"
            result={lastList}
            onClear={() => setLastList(null)}
            disableClear={disableAll || busy}
            emptyText="Click Refresh to fetch staged deposits (pool deposits --json)."
          />
        </div>
      </div>
    </div>
  );
}