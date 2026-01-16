export type RpaContext = {
  senderPub33Hex: string;
  prevoutHashHex: string;
  prevoutN: number;
  index: number;
};

export type StealthUtxoRecord = {
  owner: string;
  purpose: string;
  txid: string;
  vout: number;
  value: string;
  hash160Hex: string;
  rpaContext: RpaContext;
  createdAt: string;
  spentInTxid?: string;
  spentAt?: string;
};

export type DepositRecord = {
  txid: string;
  vout: number;
  value: string;
  receiverRpaHash160Hex: string;
  createdAt: string;
  rpaContext: RpaContext;
  importTxid?: string;
  importedIntoShard?: number;
  spentTxid?: string;
  spentAt?: string;
};

export type WithdrawalRecord = {
  txid: string;
  shardIndex: number;
  amountSats: number;
  receiverRpaHash160Hex: string;
  createdAt: string;
  rpaContext: RpaContext;
  receiverPaycodePub33Hex?: string;
  shardBefore?: any;
  shardAfter?: any;
};

export type ShardPointer = {
  txid: string;
  vout: number;
  value: string;
  commitmentHex: string;
  index?: number;
};

export type PoolState = {
  network?: string;
  txid?: string;
  categoryHex?: string;
  poolVersion?: any;
  redeemScriptHex?: string;

  shards: ShardPointer[];
  stealthUtxos: StealthUtxoRecord[];
  deposits: DepositRecord[];
  withdrawals: WithdrawalRecord[];

  lastDeposit?: DepositRecord;
  lastImport?: any;
  lastWithdraw?: any;

  createdAt?: string;
  repairedAt?: string;
};