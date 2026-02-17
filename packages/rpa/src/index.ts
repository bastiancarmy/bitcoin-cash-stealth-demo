// packages/rpa/src/index.ts

// Canonical exports (derive owns the core types like RpaContext)
export * from '@bch-stealth/rpa-derive';

// Selective exports from rpa-scan to avoid name collisions
export {
  scanRawTxForRpaOutputs,
  scanChainWindow,
} from '@bch-stealth/rpa-scan';

export type {
  // keep these only if you actually want them at the umbrella level
  RpaMatch,
  ScanRawTxForRpaOutputsParams,
  ScanChainWindowParams,
} from '@bch-stealth/rpa-scan';