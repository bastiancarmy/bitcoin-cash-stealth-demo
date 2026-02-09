// packages/src/types.ts

export type Hex = string;

export type RpaMatch = {
  txid: Hex;
  vout: number;
  valueSats?: bigint; // keep bigint
  lockingBytecodeHex: Hex;
  hash160Hex: Hex;
  roleIndex?: number;
  note?: string;
  // optionally: rpaContext/matchedInput
};

export type ScanRawTxForRpaOutputsParams = {
  rawTxHex: Hex;

  scanPrivBytes: Uint8Array;
  spendPrivBytes: Uint8Array;

  /**
   * How far to scan role/index space (kept small in Phase 2).
   * You can widen later as you add checkpoints.
   */
  maxRoleIndex: number;

  /**
   * Optional: cap on candidates per tx so we never blow up.
   */
  maxMatches?: number;
};

export type ScanChainWindowParams = {
  /**
   * Your electrum helper (so this package stays pure/portable).
   * Implement this in your repo using your existing electrum.js.
   */
  fetchRawTxHex: (txid: Hex) => Promise<Hex>;

  /**
   * Return txids in the window. Again implemented in your repo.
   * You might back this by: scripthash history, block ranges, or mempool.
   */
  listTxidsInWindow: (opts: { startHeight: number; endHeight: number }) => Promise<Hex[]>;

  startHeight: number;
  endHeight: number;

  scanPrivBytes: Uint8Array;
  spendPrivBytes: Uint8Array;
  maxRoleIndex: number;
};