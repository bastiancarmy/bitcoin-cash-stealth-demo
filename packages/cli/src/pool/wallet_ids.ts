export const WALLET_A = { id: 'wallet_a', label: 'Wallet A' } as const;
export const WALLET_B = { id: 'wallet_b', label: 'Wallet B' } as const;

export type WalletId = typeof WALLET_A.id | typeof WALLET_B.id;