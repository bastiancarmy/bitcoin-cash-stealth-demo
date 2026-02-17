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

function readJsonFile(filename: string): any {
  const raw = fs.readFileSync(filename, 'utf8');
  return JSON.parse(raw);
}

function safeLower(s: unknown): string {
  return String(s ?? '').toLowerCase();
}

/**
 * Extract stealth/RPA utxos from state.json across schema evolutions.
 *
 * Known shapes seen in your pasted files:
 * - state.data.pool.state.stealthUtxos  (bob)
 * - state.data.pool.state.data.pool.state.stealthUtxos (some nested legacy/migration artifacts)
 * - state.pool.state.stealthUtxos (older)
 * - state.stealthUtxos (very old)
 */
function extractStealthUtxosFromState(st: any): any[] {
  const candidates: any[] = [
    st?.data?.pool?.state?.stealthUtxos,
    st?.data?.pool?.state?.data?.pool?.state?.stealthUtxos,
    st?.pool?.state?.stealthUtxos,
    st?.stealthUtxos,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

export function registerWalletCommands(
  program: Command,
  deps: { getActivePaths: GetActivePaths; network?: string }
) {
  const wallet = getOrCreateSubcommand(program, 'wallet', 'Wallet commands (single-user)');

  // Existing: wallet init
  registerWalletInit(wallet, { getActivePaths: deps.getActivePaths, Electrum });

  // wallet utxos (base address)
  wallet
    .command('utxos')
    .description('List base wallet UTXOs for the active profile.')
    .option('--include-unconfirmed', 'include mempool UTXOs', false)
    .option('--json', 'print raw JSON', false)
    .option('--sum', 'only print total sats', false)
    .action(async (opts: { includeUnconfirmed?: boolean; json?: boolean; sum?: boolean }) => {
      const { profile, configFile } = deps.getActivePaths();
      const network = String(deps.network ?? '').trim() || 'chipnet';

      const me = getWalletFromConfig({ configFile, profile });
      if (!me) {
        throw new Error(
          `[wallet] no wallet found for profile "${profile}"\n` + `Try: bchctl --profile ${profile} wallet init`
        );
      }

      const includeUnconfirmed = !!opts.includeUnconfirmed;

      const { getUtxos } = Electrum as any;
      if (typeof getUtxos !== 'function') throw new Error('[wallet utxos] Electrum.getUtxos is not available');

      const address = (me as any).address;
      const utxos = await getUtxos(address, network, includeUnconfirmed);

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

        let conf = 0;
        if (typeof u?.confirmations === 'number') conf = u.confirmations;
        else if (typeof u?.height === 'number' && u.height > 0) conf = 1;

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
        const network = String(deps.network ?? '').trim() || 'chipnet';

        const stateFile = String(ap.stateFile ?? '').trim();
        if (!stateFile) {
          throw new Error(
            `[wallet rpa-utxos] activePaths missing stateFile.\n` +
              `Ensure getActivePaths() returns { stateFile } and index.ts passes it through.`
          );
        }

        const st = readJsonFile(stateFile);

        // ✅ FIX: correct extraction from nested pool state
        const stealthUtxos: any[] = extractStealthUtxosFromState(st);

        // normalize "spent" heuristics (support multiple legacy shapes)
        const rows0 = stealthUtxos.map((u) => {
          const txid = String(u?.txid ?? u?.outpointTxid ?? '').trim();
          const vout = Number(u?.vout ?? u?.outpointVout ?? u?.n ?? -1);
          const valueSats = toBigIntSats(u);

          // support: spentByTxid / spentInTxid / spentAt (your bob file uses spentInTxid + spentAt)
          const spentBy =
            String(u?.spentByTxid ?? u?.spentInTxid ?? u?.spentBy ?? '').trim() ||
            (u?.spentAt ? '1' : '');
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

        // keep only valid outpoints
        const rows1 = rows0.filter((r) => r.txid && r.vout >= 0);

        // default: filter to current profile owner, because state may contain mixed records in dev
        const rowsOwned = opts.allOwners
          ? rows1
          : rows1.filter((r) => safeLower(r.owner) === safeLower(profile));

        const rows2 = opts.includeSpent ? rowsOwned : rowsOwned.filter((r) => !r.isSpent);

        // optional chain check by outpoint
        let chainChecks: Record<string, any> | null = null;
        if (opts.checkChain) {
          chainChecks = {};
          const c = await connectElectrum(network as unknown as Network);
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
        console.log(`stealthUtxos(tracked): ${stealthUtxos.length}`);
        console.log(`shown: ${rows2.length}${opts.includeSpent ? ' (including spent)' : ''}${opts.allOwners ? ' (all owners)' : ''}`);
        if (opts.checkChain) console.log(`checkChain: true`);

        for (const r of rows2) {
          const chainOk =
            opts.checkChain && chainChecks
              ? chainChecks[r.outpoint]?.ok === true
                ? ' ✅unspent'
                : ' ❌spent'
              : '';
          const spentTag = r.isSpent ? ` spentBy=${r.spentByTxid ?? '1'}` : '';
          console.log(`- ${r.outpoint} sats=${r.valueSats.toString()} owner=${r.owner || '-'} kind=${r.kind || '-'}${spentTag}${chainOk}`);
        }

        console.log(`totalSats: ${total.toString()}`);
      }
    );

  // Existing: wallet show
  wallet
    .command('show')
    .description(
      'Show active profile wallet identifiers (address + paycode). Use --all for full key material identifiers.'
    )
    .option('--all', 'include all derived identifiers (pubkeys/hash160). Never prints private keys.', false)
    .option('--json', 'print as JSON (machine-friendly)', false)
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const { profile, configFile } = deps.getActivePaths();

      const me = getWalletFromConfig({ configFile, profile });
      if (!me) {
        throw new Error(
          `[wallet] no wallet found for profile "${profile}"\n` + `Try: bchctl --profile ${profile} wallet init`
        );
      }

      const scanPriv = (me as any).scanPrivBytes;
      if (!scanPriv) {
        throw new Error(
          `[wallet] scanPrivHex is required to generate a paycode.\n` +
            `Your config appears to be missing scanPrivHex for this profile.\n` +
            `Fix: run "bchctl --profile ${profile} wallet init" again (or migrate the profile to include scanPrivHex).`
        );
      }
      const paycode = generatePaycode(scanPriv);

      const scanPriv32: Uint8Array | undefined = (me as any).scanPrivBytes;
      const spendPriv32: Uint8Array | undefined =
        (me as any).spendPrivBytes ?? (scanPriv32 ? deriveSpendPriv32FromScanPriv32(scanPriv32) : undefined);

      const scanPub33 = safePub33FromPriv32(scanPriv32);
      const spendPub33 = safePub33FromPriv32(spendPriv32);

      let paycodePub33Hex: string | null = null;
      if (opts.all) {
        try {
          const decoded = decodePaycode(paycode);
          paycodePub33Hex = bytesToHex(decoded.pubkey33);
        } catch {
          paycodePub33Hex = null;
        }
      }

      const baseOut = {
        profile,
        address: (me as any).address,
        paycode,
      };

      const allOut = !opts.all
        ? null
        : {
            base: {
              pub33Hex: bytesToHex((me as any).pubBytes),
              hash160Hex: bytesToHex((me as any).hash160),
            },
            paycode: paycodePub33Hex ? { pub33Hex: paycodePub33Hex } : null,
            scan: scanPub33 ? { pub33Hex: bytesToHex(scanPub33) } : null,
            spend: spendPub33 ? { pub33Hex: bytesToHex(spendPub33) } : null,
          };

      if (opts.json) {
        const out = allOut ? { ...baseOut, ...allOut } : baseOut;
        process.stdout.write(JSON.stringify(out, null, 2) + '\n');
        return;
      }

      console.log(`profile: ${baseOut.profile}`);
      console.log(`address: ${baseOut.address}`);
      console.log(`paycode: ${baseOut.paycode}`);

      if (allOut) {
        console.log(`base.pub33Hex:     ${allOut.base.pub33Hex}`);
        console.log(`base.hash160:      ${allOut.base.hash160Hex}`);
        if (allOut.paycode) console.log(`paycode.pub33Hex:  ${allOut.paycode.pub33Hex}`);
        if (allOut.scan) console.log(`scan.pub33Hex:     ${allOut.scan.pub33Hex}`);
        if (allOut.spend) console.log(`spend.pub33Hex:    ${allOut.spend.pub33Hex}`);

        if (allOut.paycode?.pub33Hex && allOut.scan?.pub33Hex && allOut.paycode.pub33Hex !== allOut.scan.pub33Hex) {
          console.log('');
          console.log('⚠️  warning: paycode.pub33Hex != scan.pub33Hex');
          console.log('   This means the paycode is not being derived from the scan key you are using to scan.');
        }
      }
    });

  // Existing: wallet paycode
  wallet
    .command('paycode')
    .description('Print the active profile paycode (single line; safe for scripts).')
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

  return wallet;
}
