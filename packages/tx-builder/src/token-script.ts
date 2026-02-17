// packages/tx-builder/src/token-script.ts
import { hexToBytes, bytesToHex, concat } from '@bch-stealth/utils';
import { addTokenToScript } from './tx.js';

/**
 * Minimal “Electrum tokenData” shape we need.
 * (Electrum typically returns tokenData with amount/category/nft fields.)
 */
export type ElectrumTokenData = {
  amount?: string; // stringified integer
  category: string; // 32-byte hex (no 0x)
  nft?: {
    capability: 'none' | 'mutable' | 'minting';
    commitment?: string; // hex (0..40 bytes typically)
  };
};

function assertEvenHex(name: string, hex: string) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new Error(`${name}: invalid hex`);
}

/**
 * Build the CashTokens prefix bytes (starting with 0xef) from Electrum's tokenData.
 *
 * We reuse tx-builder's encoder: addTokenToScript(token, lockingScript).
 * Passing an empty locking script returns the prefix bytes only.
 */
export function encodeTokenPrefixFromElectrum(tokenData: ElectrumTokenData): Uint8Array {
  const categoryHex = String(tokenData?.category ?? '').toLowerCase().trim();
  assertEvenHex('tokenData.category', categoryHex);
  if (categoryHex.length !== 64) throw new Error(`tokenData.category: expected 32-byte hex (64 chars)`);

  // ✅ addTokenToScript expects category as Uint8Array(32)
  const token: any = {
    category: hexToBytes(categoryHex),
  };

  // Electrum returns amount as string; include only if non-zero
  const amt = tokenData?.amount;
  if (amt != null) {
    const s = String(amt).trim();
    if (s !== '' && s !== '0') token.amount = s;
  }

  if (tokenData?.nft) {
    const cap = tokenData.nft.capability;

    const commitmentHex = tokenData.nft.commitment ? String(tokenData.nft.commitment).toLowerCase().trim() : '';
    if (commitmentHex) assertEvenHex('tokenData.nft.commitment', commitmentHex);

    token.nft = {
      capability: cap,
      // ✅ safest: bytes (tx.js may also accept hex, but bytes avoids ambiguity)
      commitment: commitmentHex ? hexToBytes(commitmentHex) : undefined,
    };
  }

  // Return prefix-only bytes by appending to empty locking script
  return addTokenToScript(token, new Uint8Array(0));
}

/**
 * Return full scriptPubKey bytes for scripthash computations:
 * - If tokenData is present, prefix must be included.
 * - Otherwise just the locking bytecode.
 */
export function getFullScriptPubKeyBytes(args: {
  lockingBytecodeHex: string;
  tokenData?: ElectrumTokenData | null;
}): Uint8Array {
  const lockingHex = String(args.lockingBytecodeHex ?? '').toLowerCase().trim();
  assertEvenHex('lockingBytecodeHex', lockingHex);

  const locking = hexToBytes(lockingHex);
  if (!args.tokenData) return locking;

  const prefix = encodeTokenPrefixFromElectrum(args.tokenData);
  return concat([prefix, locking]);
}

/**
 * Same as getFullScriptPubKeyBytes, but returned as hex.
 */
export function getFullScriptPubKeyHex(args: {
  lockingBytecodeHex: string;
  tokenData?: ElectrumTokenData | null;
}): string {
  return bytesToHex(getFullScriptPubKeyBytes(args));
}