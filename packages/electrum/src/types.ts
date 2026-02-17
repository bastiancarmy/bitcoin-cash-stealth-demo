export type Network = 'chipnet' | 'mainnet';

export type ElectrumServer = {
  host: string;
  port: number;
  protocol: 'tcp' | 'tls' | 'ws' | 'wss';
};

export type Utxo = {
  txid: string;
  vout: number;
  value: number;
  height: number; // 0 for unconfirmed
  token_data?: any; // keep loose until we formalize CashTokens types
};

export type Prevout = {
  scriptPubKey: Uint8Array;
  value: number;
};