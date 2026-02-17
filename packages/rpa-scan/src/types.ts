// packages/rpa-scan/src/types.ts

export type Hex = string;

export type RpaContext = {
  senderPub33Hex: string;
  prevoutTxidHex: string;
  prevoutHashHex: string;
  prevoutN: number;
  index: number;
  sharedSecretHex?: string; // optional
};

export type MatchedInput = {
  vin: number;
  prevoutTxidHex: string;
  prevoutHashHex: string;
  prevoutN: number;
  senderPub33Hex: string;
};

export type RpaMatch = {
  txid: Hex;
  vout: number;

  // keep both names if your callers use either (safe)
  valueSats: string;
  value?: string;

  lockingBytecodeHex?: string;
  hash160Hex: string;

  roleIndex?: number;

  rpaContext: RpaContext;
  matchedInput: MatchedInput;
};

export type ScanRawTxForRpaOutputsParams = {
  rawTxHex: Hex;
  scanPrivBytes: Uint8Array;
  spendPrivBytes: Uint8Array;

  /**
   * Treated as a RANGE LENGTH. Indices scanned are [0 .. maxRoleIndex-1]
   * (off-by-one fix vs older <= behavior).
   */
  maxRoleIndex?: number;

  parsedTx?: any;

  // NEW
  indexHints?: number[] | null;
  stopOnFirstMatch?: boolean;

  // Optional: cap number of matches returned from this tx
  maxMatches?: number;
};

export type ScanChainWindowParams = {
  fetchRawTxHex: (txid: Hex) => Promise<Hex>;
  listTxidsInWindow: (opts: { startHeight: number; endHeight: number }) => Promise<Hex[]>;

  startHeight: number;
  endHeight: number;

  scanPrivBytes: Uint8Array;
  spendPrivBytes: Uint8Array;
  maxRoleIndex: number;

  // NEW pass-through
  indexHints?: number[] | null;
  stopOnFirstMatch?: boolean;
};