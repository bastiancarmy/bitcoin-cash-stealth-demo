// packages/cli/src/wallet/birthday.ts
export async function estimateBirthdayHeightFromAddress(args: {
  Electrum: any;            // namespace import: * as Electrum from '@bch-stealth/electrum'
  address: string;
  network: string;          // 'chipnet' | 'mainnet' | ...
  safetyMargin?: number;    // optional: rewind a bit to be safe
}): Promise<number> {
  const { Electrum, address, network } = args;
  const safetyMargin = Number(args.safetyMargin ?? 0);

  const clamp = (h: number) => Math.max(0, Math.floor(h));

  try {
    const sh = Electrum.addressToScripthash(address);
    const client = await Electrum.connectElectrum(network);

    try {
      const hist = await client.request('blockchain.scripthash.get_history', sh);
      const rows = Array.isArray(hist) ? hist : [];

      let min = Number.POSITIVE_INFINITY;
      for (const r of rows) {
        const h = Number((r as any)?.height ?? 0);
        // Electrum uses height=0 for mempool/unconfirmed
        if (Number.isFinite(h) && h > 0 && h < min) min = h;
      }

      if (!Number.isFinite(min)) return 0;

      const estimated = min - (Number.isFinite(safetyMargin) ? safetyMargin : 0);
      return clamp(estimated);
    } finally {
      await client.disconnect();
    }
  } catch {
    return 0;
  }
}