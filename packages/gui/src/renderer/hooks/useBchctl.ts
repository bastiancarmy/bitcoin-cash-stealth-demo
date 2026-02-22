// packages/gui/src/renderer/hooks/useBchctl.ts
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BchctlChunk, ConfigJsonV1 } from '../types';
import { tryParseJson } from '../types';

declare global {
  interface Window {
    bchStealth: {
      appInfo: () => Promise<any>;
      getConfig: () => Promise<{ ok: boolean; config?: ConfigJsonV1; path?: string; error?: string }>;
      setCurrentProfile: (profile: string) => Promise<{ ok: boolean; error?: string }>;
      listProfiles: () => Promise<string[]>;
      createProfile: (name: string) => Promise<{ ok: boolean; profile?: string; error?: string }>;
      renameProfile: (oldName: string, newName: string) => Promise<{ ok: boolean; profile?: string; error?: string }>;

      runBchctl: (args: { profile: string; argv: string[]; env?: Record<string, string> }) => Promise<{ opId: string }>;
      getBchctlResult: (args: { opId: string }) => Promise<{ ok: boolean; stdout?: string; stderr?: string; error?: string }>;
      killBchctl: (args: { opId: string }) => Promise<{ ok: boolean; error?: string }>;

      onBchctlChunk: (cb: (m: BchctlChunk) => void) => () => void;
      onBchctlExit: (cb: (m: { opId: string; code: number }) => void) => () => void;
    };
  }
}

export type ProfileId = string;

export type ConsoleLine = {
  ts: number;
  opId: string;
  profile: ProfileId;
  label: string;
  stream: 'stdout' | 'stderr';
  text: string;
};

type OpMeta = {
  opId: string;
  profile: ProfileId;
  label: string;
  argv: string[];
  startedAt: number;
  exitCode: number | null;
};

export type RunResult = {
  opId: string;
  code: number;
  stdout: string;
  stderr: string;
};

function isExpectedNoWalletText(s: string): boolean {
  const t = String(s ?? '');
  // Matches current CLI message:
  // ❌ Error: [wallet] no wallet found for profile "default"
  return t.includes('[wallet] no wallet found for profile');
}

function shouldSuppressChunk(meta: OpMeta, m: BchctlChunk): boolean {
  if (m.stream !== 'stderr') return false;

  // Only suppress for the wallet gauges where "no wallet found" is expected.
  if (meta.label !== 'wallet:show' && meta.label !== 'wallet:utxos') return false;

  return isExpectedNoWalletText(m.chunk);
}

export function useBchctl() {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [runningOps, setRunningOps] = useState<Record<string, OpMeta>>({});

  const runningRef = useRef<Record<string, OpMeta>>({});
  const exitSeenRef = useRef<Record<string, number>>({});
  const exitWaitersRef = useRef<Record<string, Array<(code: number) => void>>>({});

  const pushLine = (l: ConsoleLine) => {
    setLines((cur) => {
      const next = [...cur, l];
      if (next.length > 3000) return next.slice(next.length - 3000);
      return next;
    });
  };

  useEffect(() => {
    const offChunk = window.bchStealth.onBchctlChunk((m) => {
      const meta = runningRef.current[m.opId];
      if (!meta) return;

      if (shouldSuppressChunk(meta, m)) return;

      pushLine({
        ts: Date.now(),
        opId: m.opId,
        profile: meta.profile,
        label: meta.label,
        stream: m.stream,
        text: m.chunk,
      });
    });

    const offExit = window.bchStealth.onBchctlExit((m) => {
      exitSeenRef.current[m.opId] = m.code;

      const waiters = exitWaitersRef.current[m.opId];
      if (waiters && waiters.length) {
        for (const w of waiters) w(m.code);
      }
      delete exitWaitersRef.current[m.opId];

      const meta = runningRef.current[m.opId];
      if (meta) {
        runningRef.current[m.opId] = { ...meta, exitCode: m.code };
      }

      setRunningOps({ ...runningRef.current });
    });

    return () => {
      offChunk();
      offExit();
    };
  }, []);

  const isRunning = useMemo(() => Object.values(runningOps).some((o) => o.exitCode === null), [runningOps]);

  const clearLog = () => setLines([]);

  const runText = async (args: {
    profile: string;
    label: string;
    argv: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
  }) => {
    const profile = String(args.profile ?? '').trim() || 'default';
    const label = String(args.label ?? '').trim() || 'cmd';

    const { opId } = await window.bchStealth.runBchctl({ profile, argv: args.argv, env: args.env });

    const meta: OpMeta = {
      opId,
      profile,
      label,
      argv: args.argv,
      startedAt: Date.now(),
      exitCode: null,
    };

    runningRef.current[opId] = meta;
    setRunningOps({ ...runningRef.current });

    const waitForExit = async (): Promise<number> => {
      const seen = exitSeenRef.current[opId];
      if (typeof seen === 'number') return seen;

      return new Promise((resolve) => {
        exitWaitersRef.current[opId] = exitWaitersRef.current[opId] ?? [];
        exitWaitersRef.current[opId].push(resolve);
      });
    };

    const timeoutMs = args.timeoutMs ?? 60_000;

    const code = await Promise.race<number>([
      waitForExit(),
      new Promise<number>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
    ]);

    const res = await window.bchStealth.getBchctlResult({ opId });

    const stdout = String(res?.stdout ?? '');
    const stderr = String(res?.stderr ?? '');

    // keep a trailing line for parity/debug
    pushLine({
      ts: Date.now(),
      opId,
      profile,
      label,
      stream: 'stdout',
      text: `\n(exit ${code})\n`,
    });

    // cleanup runningRef
    delete runningRef.current[opId];
    setRunningOps({ ...runningRef.current });

    if (!res?.ok) {
      throw new Error(res?.error ?? 'command failed');
    }

    return { opId, code, stdout, stderr };
  };

  const runJson = async <T,>(args: {
    profile: string;
    label: string;
    argv: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
  }) => {
    const result = await runText(args);
    const json = tryParseJson<T>(result.stdout) ?? null;
    return { result, json };
  };

  return { lines, clearLog, isRunning, runText, runJson };
}