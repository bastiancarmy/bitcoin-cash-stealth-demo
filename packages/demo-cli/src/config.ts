// src/config.js
// Constants and configuration for the demo
// No additional research needed; these are static values from the POC.

// export const NETWORK = 'mainnet'; // Mainnet as requested
export const NETWORK: "chipnet" | "mainnet" = "chipnet";
export const DUST = 546;
export const AMOUNT = 100000;
export const FEE = 5000;
export const MIX_COUNT = 5;
export const MIX_AMOUNT = AMOUNT + FEE + DUST;

// Electrum servers
export const ELECTRUM_SERVERS = [
  // { host: '31.97.150.114', port: 50000, protocol: 'tls' }, // Changed 'ssl' to 'tls' to fix HTTP parse error
  { host: 'chipnet.imaginary.cash', port: 50004, protocol: 'wss' }, 
  // { host: 'fulcrum.criptolayer.net', port: 50002, protocol: 'ssl' },
  // { host: 'fulcrum.jettscythe.xyz', port: 50002, protocol: 'ssl' },
  // { host: 'blackie.c3-soft.com', port: 50002, protocol: 'ssl' },
  // { host: 'fulcrum-cash.1209k.com', port: 50002, protocol: 'ssl' },
  // { host: 'electrum.imaginary.cash', port: 50002, protocol: 'ssl' },
  // { host: 'bch.imaginary.cash', port: 50002, protocol: 'ssl' },
  // { host: 'bitcoincash.stackwallet.com', port: 50002, protocol: 'ssl' },
  // { host: 'bch.soul-dev.com', port: 50002, protocol: 'ssl' },
];