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
  getBobRedeemScript(bobPubKeyHash: any): Uint8Array;
};

export type BuilderDeps = {
  txb?: TxBuilderLike;

  // Optional: allow caller to define covenant policy without "bob"
  redeemScriptFactory?: (poolId20: Uint8Array) => Uint8Array;
};