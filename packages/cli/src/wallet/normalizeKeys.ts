// packages/cli/src/wallet/normalizeKeys.ts
import { bytesToHex } from '@bch-stealth/utils';
import { deriveSpendPriv32FromScanPriv32 } from '@bch-stealth/rpa-derive';

export type WalletKeyMaterialLike = {
  privBytes?: Uint8Array | null;
  scanPrivBytes?: Uint8Array | null;
  spendPrivBytes?: Uint8Array | null;
};

export type NormalizedWalletKeyFlags = {
  scanFallbackToPriv: boolean;
  spendWasDerived: boolean;
  spendWasOverridden: boolean;
};

export type NormalizedWalletKeys = {
  basePriv32: Uint8Array;
  scanPriv32: Uint8Array;
  spendPriv32: Uint8Array;
  flags: NormalizedWalletKeyFlags;
};

function parseBoolishEnv(name: string): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on';
}

export function normalizeWalletKeys(wallet: WalletKeyMaterialLike): NormalizedWalletKeys {
  const basePriv32 = wallet.privBytes ?? null;
  if (!(basePriv32 instanceof Uint8Array) || basePriv32.length !== 32) {
    throw new Error('normalizeWalletKeys: wallet.privBytes must be 32 bytes');
  }

  const scanPriv32 = (wallet.scanPrivBytes ?? wallet.privBytes) ?? null;
  if (!(scanPriv32 instanceof Uint8Array) || scanPriv32.length !== 32) {
    throw new Error('normalizeWalletKeys: scanPriv32 must be 32 bytes');
  }

  const scanFallbackToPriv = !(wallet.scanPrivBytes instanceof Uint8Array) || wallet.scanPrivBytes.length !== 32;

  const expectedSpend = deriveSpendPriv32FromScanPriv32(scanPriv32);

  const spendIn = wallet.spendPrivBytes ?? null;
  if (!(spendIn instanceof Uint8Array) || spendIn.length !== 32) {
    return {
      basePriv32,
      scanPriv32,
      spendPriv32: expectedSpend,
      flags: { scanFallbackToPriv, spendWasDerived: true, spendWasOverridden: false },
    };
  }

  const a = bytesToHex(spendIn).toLowerCase();
  const b = bytesToHex(expectedSpend).toLowerCase();
  if (a !== b) {
    return {
      basePriv32,
      scanPriv32,
      spendPriv32: expectedSpend,
      flags: { scanFallbackToPriv, spendWasDerived: false, spendWasOverridden: true },
    };
  }

  return {
    basePriv32,
    scanPriv32,
    spendPriv32: spendIn,
    flags: { scanFallbackToPriv, spendWasDerived: false, spendWasOverridden: false },
  };
}

/**
 * Optional: call-site helper so every command prints the same one-liner.
 * Never prints key material.
 */
export function debugPrintKeyFlags(prefix: string, flags: NormalizedWalletKeyFlags): void {
  if (!parseBoolishEnv('BCH_STEALTH_DEBUG_KEYS')) return;
  console.log(
    `[keys] ${prefix} scanFallbackToPriv=${flags.scanFallbackToPriv} spendWasDerived=${flags.spendWasDerived} spendWasOverridden=${flags.spendWasOverridden}`
  );
}