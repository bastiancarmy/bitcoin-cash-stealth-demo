// packages/pool-state/src/repair.ts
import type { PoolState } from './state.js';

export type RepairFromChainOptions = {
  electrumIO: unknown;
  walletsOrPaycodes: unknown;
  scanWindow?: unknown;
};

export type RepairDiagnosticsReceived = {
  hasElectrumIO: boolean;
  hasWalletsOrPaycodes: boolean;
  walletsOrPaycodesType: string;
  scanWindowProvided: boolean;
};

/**
 * Diagnostics are intentionally extensible. We standardize a small "spine"
 * of fields so callers can log/report consistently, while leaving room for
 * future repair implementations to add additional detail.
 */
export type RepairDiagnostics = {
  status: 'stub' | string;
  message: string;
  version: number;
  timestamp: string;
  received: RepairDiagnosticsReceived;
} & Record<string, unknown>;

export type RepairFromChainResult = {
  repairedState: PoolState | null;
  diagnostics: RepairDiagnostics;
};

export async function repairFromChain(
  opts: RepairFromChainOptions
): Promise<RepairFromChainResult> {
  const isObject = typeof opts === 'object' && opts !== null;

  const hasElectrumIO = isObject && 'electrumIO' in opts;
  const hasWalletsOrPaycodes = isObject && 'walletsOrPaycodes' in opts;
  const scanWindowProvided = isObject && 'scanWindow' in opts;

  const received: RepairDiagnosticsReceived = {
    hasElectrumIO,
    hasWalletsOrPaycodes,
    walletsOrPaycodesType: hasWalletsOrPaycodes
      ? typeof (opts as any).walletsOrPaycodes
      : 'missing',
    scanWindowProvided,
  };

  // Minimal presence validation only (no IO, no dependency coupling yet)
  if (!hasElectrumIO || !hasWalletsOrPaycodes) {
    return {
      repairedState: null,
      diagnostics: {
        status: 'stub',
        message:
          'repairFromChain placeholder API: required fields missing (electrumIO and/or walletsOrPaycodes).',
        received,
        version: 1,
        timestamp: new Date().toISOString(),
      },
    };
  }

  return {
    repairedState: null,
    diagnostics: {
      status: 'stub',
      message: 'repairFromChain not implemented yet; this is a stable placeholder API.',
      received: {
        ...received,
        // When fields are present we can provide a slightly more helpful view:
        walletsOrPaycodesType: typeof (opts as any).walletsOrPaycodes,
      },
      version: 1,
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Example (future shape):
 *
 * await repairFromChain({
 *   electrumIO,
 *   walletsOrPaycodes: [paycodeA, paycodeB],
 *   scanWindow: { fromHeight: 0, toHeight: 'tip' },
 * });
 */