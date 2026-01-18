// packages/pool-shards/src/di.ts
export type TxBuilderLike = {
  buildRawTx(tx: any, opts: { format: 'bytes' }): Uint8Array | string;

  signInput(tx: any, inputIndex: any, privBytes: any, scriptPubKey: any, value: any): any;

  signCovenantInput(
    tx: any,
    inputIndex: any,
    privBytes: any,
    redeemScript: any,
    value: any,
    rawPrevScript: any,
    amount: any,
    hashtype?: number
  ): any;

  addTokenToScript(token: any, lockingScript: any): Uint8Array;
  getP2PKHScript(hash160: any): Uint8Array;
  getP2SHScript(scriptHash20: any): Uint8Array;

  // Optional legacy helper (discouraged): implement in CLI if needed.
  // Prefer passing cfg.redeemScriptHex or deps.redeemScriptFactory.
  // getRedeemScript?(poolId20: Uint8Array): Uint8Array;
};

export type BuilderDeps = {
  txb?: TxBuilderLike;

  // Optional: allow caller to define covenant policy without actor naming.
  redeemScriptFactory?: (poolId20: Uint8Array) => Uint8Array;
};