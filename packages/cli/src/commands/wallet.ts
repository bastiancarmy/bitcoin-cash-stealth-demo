// packages/cli/src/commands/wallet.ts
import type { Command } from 'commander';
import * as Electrum from '@bch-stealth/electrum';

import fs from 'node:fs';

import { bytesToHex } from '@bch-stealth/utils';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { registerWalletInit, type GetActivePaths } from '../wallet/init.js';
import { getWalletFromConfig } from '../wallets.js';
import { decodePaycode, generatePaycode } from '../paycodes.js';

import { deriveSpendPriv32FromScanPriv32 } from '@bch-stealth/rpa-derive';

// Optional (only used when --check-chain is set)
import type { Network } from '@bch-stealth/electrum';
import { connectElectrum } from '@bch-stealth/electrum';
import { outpointIsUnspentViaVerboseTx } from '../pool/electrum-unspent.js';

function normalizeNetwork(n: unknown): Network {
  const s = String(n ?? '').trim().toLowerCase();
  if (s === 'mainnet' || s === 'testnet' || s === 'chipnet') return s as Network;
  return 'chipnet';
}

function getOrCreateSubcommand(program: Command, name: string, description: string): Command {
  const existing = (program.commands ?? []).find((c) => c.name() === name);
  if (existing) return existing;
  return program.command(name).description(description);
}

function safePub33FromPriv32(priv32?: Uint8Array): Uint8Array | null {
  if (!(priv32 instanceof Uint8Array) || priv32.length !== 32) return null;
  return secp256k1.getPublicKey(priv32, true);
}

function toBigIntSats(u: any): bigint {
  const v = u?.valueSats ?? u?.value_sats ?? u?.value ?? 0;
  return typeof v === 'bigint' ? v : BigInt(v);
}

function hasToken(u: any): boolean {
  return !!(u?.tokenData ?? u?.token_data);
}

// missing file is normal on first run
function readJsonFile(filename: string): any {
  try {
    const raw = fs.readFileSync(filename, 'utf8');
    return JSON.parse(raw);
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

function safeLower(s: unknown): string {
  return String(s ?? '').toLowerCase();
}

/**
 * Extract stealth/RPA utxos from state.json across schema evolutions.
 */
function extractStealthUtxosFromState(st: any): any[] {
  if (!st || typeof st !== 'object') return [];

  const candidates: any[] = [];

  if (Array.isArray((st as any)?.poolState?.utxos)) candidates.push((st as any).poolState.utxos);
  if (Array.isArray((st as any)?.state?.poolState?.utxos)) candidates.push((st as any).state.poolState.utxos);

  if (Array.isArray((st as any)?.utxos)) candidates.push((st as any).utxos);
  if (Array.isArray((st as any)?.pool?.utxos)) candidates.push((st as any).pool.utxos);

  if (Array.isArray((st as any)?.data?.pool?.state?.stealthUtxos))
    candidates.push((st as any).data.pool.state.stealthUtxos);

  if (Array.isArray((st as any)?.data?.pool?.state?.data?.pool?.state?.stealthUtxos))
    candidates.push((st as any).data.pool.state.data.pool.state.stealthUtxos);

  const flat = candidates.flat().filter(Boolean);

  const seen = new Set<string>();
  const out: any[] = [];

  for (const u of flat) {
    const txid = String(u?.txid ?? u?.outpointTxid ?? '').trim();
    const vout = Number(u?.vout ?? u?.outpointVout ?? u?.n ?? -1);
    const k = txid && Number.isFinite(vout) ? `${txid}:${vout}` : '';
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(u);
  }

  return out;
}

export function registerWalletCommands(program: Command, deps: { getActivePaths: GetActivePaths; network?: string }) {
  const wallet = getOrCreateSubcommand(program, 'wallet', 'Wallet commands (single-user)');

  // wallet init
  registerWalletInit(wallet, { getActivePaths: deps.getActivePaths, Electrum });

  // wallet utxos (base address)
  wallet
    .command('utxos')
    .description('List base wallet UTXOs (electrum).')
    .option('--json', 'print raw JSON', false)
    .option('--sum', 'only print total sats', false)
    .option('--include-unconfirmed', 'include mempool UTXOs', false)
    .action(async (opts: { json?: boolean; sum?: boolean; includeUnconfirmed?: boolean }) => {
      const { profile, configFile } = deps.getActivePaths();
      const network = normalizeNetwork(deps.network);

      const me = getWalletFromConfig({ configFile, profile });
      if (!me) {
        throw new Error(
          `[wallet] no wallet found for profile "${profile}"\n` + `Try: bchctl --profile ${profile} wallet init`
        );
      }

      const includeUnconfirmed = !!opts.includeUnconfirmed;
      const address = (me as any).address;

      const utxos = await Electrum.getUtxos(address, network, includeUnconfirmed);

      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              network,
              profile,
              address,
              includeUnconfirmed,
              utxos,
            },
            null,
            2
          ) + '\n'
        );
        return;
      }

      let total = 0n;
      const rows = (utxos ?? []).map((u: any) => {
        const sats = toBigIntSats(u);
        total += sats;

        const conf = typeof u?.confirmations === 'number' ? u.confirmations : 0;

        return {
          outpoint: `${u.txid}:${u.vout}`,
          sats,
          conf,
          token: hasToken(u),
        };
      });

      if (opts.sum) {
        process.stdout.write(total.toString() + '\n');
        return;
      }

      console.log(`network: ${network}`);
      console.log(`profile: ${profile}`);
      console.log(`address: ${address}`);
      console.log(`includeUnconfirmed: ${includeUnconfirmed}`);
      console.log(`utxos: ${rows.length}`);

      for (const r of rows) {
        console.log(`- ${r.outpoint} sats=${r.sats.toString()} conf=${r.conf}${r.token ? ' token=1' : ''}`);
      }

      console.log(`totalSats: ${total.toString()}`);
    });

  // wallet rpa-utxos (state-tracked stealth/RPA UTXOs)
  wallet
    .command('rpa-utxos')
    .description(
      'List state-tracked RPA/stealth UTXOs (from state.json). Optionally verify each outpoint is still unspent via Electrum.'
    )
    .option('--json', 'print raw JSON', false)
    .option('--sum', 'only print total sats', false)
    .option('--include-spent', 'include UTXOs marked spent in state', false)
    .option('--check-chain', 'verify each outpoint is unspent via Electrum (slower)', false)
    .option('--all-owners', 'do not filter by owner=profile (show everything in state)', false)
    .action(
      async (opts: {
        json?: boolean;
        sum?: boolean;
        includeSpent?: boolean;
        checkChain?: boolean;
        allOwners?: boolean;
      }) => {
        const ap: any = deps.getActivePaths() as any;
        const { profile } = ap;
        const network = normalizeNetwork(deps.network);

        const stateFile = String(ap.stateFile ?? '').trim();
        if (!stateFile) {
          throw new Error(
            `[wallet rpa-utxos] activePaths missing stateFile.\n` +
              `Ensure getActivePaths() returns { stateFile } and index.ts passes it through.`
          );
        }

        const st0 = readJsonFile(stateFile);
        const stateMissing = st0 == null;
        const st = st0 ?? {};

        const stealthUtxos: any[] = extractStealthUtxosFromState(st);

        const rows0 = stealthUtxos.map((u) => {
          const txid = String(u?.txid ?? u?.outpointTxid ?? '').trim();
          const vout = Number(u?.vout ?? u?.outpointVout ?? u?.n ?? -1);
          const valueSats = toBigIntSats(u);

          const spentBy =
            String(u?.spentByTxid ?? u?.spentInTxid ?? u?.spentBy ?? '').trim() || (u?.spentAt ? '1' : '');
          const isSpent = !!spentBy || !!u?.spentAt;

          const owner = String(u?.owner ?? u?.ownerTag ?? '').trim();
          const kind = String(u?.purpose ?? u?.kind ?? u?.source ?? 'stealth').trim();
          const h160 = String(u?.hash160Hex ?? u?.receiverHash160Hex ?? '').trim();

          return {
            txid,
            vout,
            outpoint: txid && Number.isFinite(vout) ? `${txid}:${vout}` : '',
            valueSats,
            isSpent,
            spentByTxid: spentBy && spentBy !== '1' ? spentBy : null,
            owner,
            kind,
            hash160Hex: h160 || null,
            raw: u,
          };
        });

        const rows1 = rows0.filter((r) => r.txid && r.vout >= 0);
        const rowsOwned = opts.allOwners ? rows1 : rows1.filter((r) => safeLower(r.owner) === safeLower(profile));
        const rows2 = opts.includeSpent ? rowsOwned : rowsOwned.filter((r) => !r.isSpent);

        let chainChecks: Record<string, any> | null = null;
        if (opts.checkChain) {
          chainChecks = {};
          const c = await connectElectrum(network);
          try {
            for (const r of rows2) {
              const res = await outpointIsUnspentViaVerboseTx({
                c,
                txid: r.txid,
                vout: r.vout,
              });
              chainChecks[r.outpoint] = res;
            }
          } finally {
            await c.disconnect().catch(() => {});
          }
        }

        const total = rows2.reduce((acc, r) => acc + r.valueSats, 0n);

        if (opts.json) {
          process.stdout.write(
            JSON.stringify(
              {
                network,
                profile,
                stateFile,
                stateMissing,
                tracked: stealthUtxos.length,
                shown: rows2.length,
                totalSats: total.toString(),
                utxos: rows2.map((r) => ({
                  outpoint: r.outpoint,
                  valueSats: r.valueSats.toString(),
                  isSpent: r.isSpent,
                  spentByTxid: r.spentByTxid,
                  owner: r.owner,
                  kind: r.kind,
                  hash160Hex: r.hash160Hex,
                })),
                chainChecks,
              },
              null,
              2
            ) + '\n'
          );
          return;
        }

        if (opts.sum) {
          process.stdout.write(total.toString() + '\n');
          return;
        }

        console.log(`network: ${network}`);
        console.log(`profile: ${profile}`);
        console.log(`state: ${stateFile}`);
        if (stateMissing) console.log('stateMissing: true (state.json not found)');
        console.log(`stealthUtxos(tracked): ${stealthUtxos.length}`);
        console.log(
          `shown: ${rows2.length}${opts.includeSpent ? ' (including spent)' : ''}${opts.allOwners ? ' (all owners)' : ''}`
        );
        if (opts.checkChain) console.log(`checkChain: true`);

        for (const r of rows2) {
          const chainOk =
            opts.checkChain && chainChecks
              ? chainChecks[r.outpoint]?.ok === true
                ? ' ✅unspent'
                : ' ❌spent'
              : '';
          const spentTag = r.isSpent ? ` spentBy=${r.spentByTxid ?? '1'}` : '';
          console.log(
            `- ${r.outpoint} sats=${r.valueSats.toString()} owner=${r.owner || '-'} kind=${r.kind || '-'}${spentTag}${chainOk}`
          );
        }

        console.log(`totalSats: ${total.toString()}`);
      }
    );

  // wallet show
  wallet
    .command('show')
    .description('Show wallet info for this profile')
    .option('--all', 'include derived identifiers', false)
    .option('--json', 'print as JSON', false)
    .action((opts: { all?: boolean; json?: boolean }) => {
      const { profile, configFile } = deps.getActivePaths();

      const me = getWalletFromConfig({ configFile, profile });
      if (!me) {
        throw new Error(
          `[wallet] no wallet found for profile "${profile}"\n` + `Try: bchctl --profile ${profile} wallet init`
        );
      }

      const address = (me as any).address;

      const paycodeKey = (me as any).scanPrivBytes ?? (me as any).privBytes;
      const paycode = generatePaycode(paycodeKey);

      const basePub33 = safePub33FromPriv32((me as any).privBytes);
      const scanPub33 = safePub33FromPriv32((me as any).scanPrivBytes);

      const obj: any = {
        profile,
        address,
        paycode,
      };

      if (opts.all) {
        obj.basePub33Hex = basePub33 ? bytesToHex(basePub33) : null;
        obj.scanPub33Hex = scanPub33 ? bytesToHex(scanPub33) : null;

        const scanPriv32 = (me as any).scanPrivBytes as Uint8Array | undefined;
        if (scanPriv32 && scanPriv32.length === 32) {
          const spendPriv32 = deriveSpendPriv32FromScanPriv32(scanPriv32);
          const spendPub33 = safePub33FromPriv32(spendPriv32);
          obj.derivedSpendPub33Hex = spendPub33 ? bytesToHex(spendPub33) : null;
        }
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
        return;
      }

      console.log(`profile: ${profile}`);
      console.log(`address: ${address}`);
      console.log(`paycode: ${paycode}`);

      if (opts.all) {
        console.log(`basePub33: ${obj.basePub33Hex ?? '-'}`);
        console.log(`scanPub33: ${obj.scanPub33Hex ?? '-'}`);
        console.log(`derivedSpendPub33(from scan): ${obj.derivedSpendPub33Hex ?? '-'}`);
      }
    });

  // wallet paycode
  wallet
    .command('paycode')
    .description('Print static paycode for this profile')
    .action(() => {
      const { profile, configFile } = deps.getActivePaths();

      const me = getWalletFromConfig({ configFile, profile });
      if (!me) {
        throw new Error(
          `[wallet] no wallet found for profile "${profile}"\n` + `Try: bchctl --profile ${profile} wallet init`
        );
      }

      const paycodeKey = (me as any).scanPrivBytes ?? (me as any).privBytes;
      const paycode = generatePaycode(paycodeKey);

      process.stdout.write(paycode + '\n');
    });

  // decodePaycode is intentionally left unused for now; keeping import avoids churn if you wire a subcommand later
  void decodePaycode;

  return wallet;
}
