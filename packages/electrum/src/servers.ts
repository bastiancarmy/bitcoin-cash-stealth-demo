// packages/electrum/src/servers.ts
import type { ElectrumServer } from './types.js';

// Prefer Fulcrum SSL servers first (tend to be reliable).
export const ELECTRUM_SERVERS: ElectrumServer[] = [
  // // Chaingraph chipnet (Fulcrum)
  // { host: 'chipnet.chaingraph.cash', port: 50004, protocol: 'wss' },

  // // BCH Ninja chipnet (Fulcrum)
  // { host: 'chipnet.bch.ninja', port: 50004, protocol: 'wss' },

  // Imaginary chipnet (wss) – keep as fallback
  { host: 'chipnet.imaginary.cash', port: 50004, protocol: 'wss' },
];
