// packages/cli/src/commands/wallet-utxos.ts
import { Command } from 'commander';

function toBigIntSats(u: any): bigint {
  const v = u?.valueSats ?? u?.value_sats ?? u?.value ?? 0;
  return typeof v === 'bigint' ? v : BigInt(v);
}

function hasToken(u: any): boolean {
  return !!(u?.tokenData ?? u?.token_data);
}

export function registerWalletUtxosCommand(
  walletCmd: Command,
  deps: {
    loadMeWallet: () => Promise<any>;
    getUtxos: (address: string, network: string, includeUnconfirmed: boolean) => Promise<any[]>;
    getActivePaths: () => { profile: string };
    network: string;
  }
) {
  walletCmd
    .command('utxos')
    .description('List base wallet UTXOs for the active profile.')
    .option('--include-unconfirmed', 'include mempool UTXOs', false)
    .option('--json', 'print raw JSON', false)
    .option('--sum', 'only print total sats', false)
    .action(async (opts: any) => {
      const includeUnconfirmed = !!opts.includeUnconfirmed;
      const { profile } = deps.getActivePaths();
      const me = await deps.loadMeWallet();

      const utxos = await deps.getUtxos(me.address, deps.network, includeUnconfirmed);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              network: deps.network,
              profile,
              address: me.address,
              includeUnconfirmed,
              utxos,
            },
            null,
            2
          )
        );
        return;
      }

      let total = 0n;
      const rows = (utxos ?? []).map((u: any) => {
        const sats = toBigIntSats(u);
        total += sats;
        const conf = typeof u?.confirmations === 'number' ? u.confirmations : u?.height ? 1 : 0;
        return {
          outpoint: `${u.txid}:${u.vout}`,
          sats,
          conf,
          token: hasToken(u),
        };
      });

      if (opts.sum) {
        console.log(total.toString());
        return;
      }

      console.log(`network: ${deps.network}`);
      console.log(`profile: ${profile}`);
      console.log(`address: ${me.address}`);
      console.log(`includeUnconfirmed: ${includeUnconfirmed}`);
      console.log(`utxos: ${rows.length}`);
      for (const r of rows) {
        console.log(
          `- ${r.outpoint} sats=${r.sats.toString()} conf=${r.conf}${r.token ? ' token=1' : ''}`
        );
      }
      console.log(`totalSats: ${total.toString()}`);
    });
}