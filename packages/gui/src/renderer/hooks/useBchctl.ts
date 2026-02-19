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

      setRunningOps((cur) => {
        const next = { ...cur };
        delete next[m.opId];
        return next;
      });
    });

    return () => {
      offChunk();
      offExit();
    };
  }, []);

  const isRunning = useMemo(() => Object.keys(runningOps).length > 0, [runningOps]);

  const waitForExit = (opId: string): Promise<number> => {
    const already = exitSeenRef.current[opId];
    if (typeof already === 'number') return Promise.resolve(already);

    return new Promise<number>((resolve) => {
      const list = exitWaitersRef.current[opId] ?? [];
      list.push(resolve);
      exitWaitersRef.current[opId] = list;
    });
  };

  async function runText(args: {
    profile: ProfileId;
    label: string;
    argv: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<RunResult> {
    const { profile, label, argv, env } = args;

    const { opId } = await window.bchStealth.runBchctl({ profile, argv, env });

    const meta: OpMeta = { opId, profile, label, argv, startedAt: Date.now(), exitCode: null };
    runningRef.current[opId] = meta;
    setRunningOps((cur) => ({ ...cur, [opId]: meta }));

    const timeout = Math.max(5_000, args.timeoutMs ?? 60_000);

    const code = await Promise.race([
      waitForExit(opId),
      new Promise<number>((resolve) => setTimeout(() => resolve(124), timeout)),
    ]);

    const res = await window.bchStealth.getBchctlResult({ opId });
    const stdout = String(res?.stdout ?? '');
    const stderr = String(res?.stderr ?? '');

    return { opId, code, stdout, stderr };
  }

  async function runJson<T = unknown>(args: {
    profile: ProfileId;
    label: string;
    argv: string[];
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<{ result: RunResult; json: T | null }> {
    const result = await runText(args);
    const json = (tryParseJson<T>(result.stdout) ?? tryParseJson<T>(result.stderr)) as T | null;
    return { result, json };
  }

  function clearLog() {
    setLines([]);
  }

  return {
    lines,
    clearLog,
    runningOps,
    isRunning,
    runText,
    runJson,
  };
}