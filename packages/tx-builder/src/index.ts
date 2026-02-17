// packages/tx-builder/src/index.ts
export * from './tx.js';

// Explicit re-export (strongest / least fragile)
export {
  getFullScriptPubKeyHex,
  getFullScriptPubKeyBytes,
  encodeTokenPrefixFromElectrum,
} from './token-script.js';

export type { ElectrumTokenData } from './token-script.js';