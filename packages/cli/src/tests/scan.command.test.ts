// packages/cli/src/tests/scan.command.test.ts
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Command } from 'commander';

import { bytesToHex, hexToBytes, sha256, concat, encodeCashAddr } from '@bch-stealth/utils';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { registerScanCommand } from '../commands/scan.js';

function b32(fill: number): Uint8Array {
  const a = new Uint8Array(32);
  a.fill(fill & 0xff);
  return a;
}

function makeWallet(scanPrivHex: string) {
  // scan command now normalizes keys and requires a 32-byte base priv
  const basePrivBytes = b32(0x99);
  const basePrivHex = bytesToHex(basePrivBytes);

  return {
    privBytes: basePrivBytes,
    wallet: {
      privHex: basePrivHex,
      scanPrivHex,
      birthdayHeight: 0,
    },
    birthdayHeight: 0,
  } as any;
}

function deriveExpectedDefaultPrefix(scanPriv32: Uint8Array): string {
  const Q = secp256k1.getPublicKey(scanPriv32, true);
  const tag = new TextEncoder().encode('bch-stealth:rpa:grind:');
  const h = sha256(concat(tag, Q));
  return bytesToHex(h.slice(0, 1)).toLowerCase();
}

function makeFakeElectrumClient(calls: any[]) {
  return {
    request: async (...args: any[]) => {
      calls.push(args);

      const [method] = args;
      if (method === 'blockchain.headers.subscribe') return { height: 123 };
      if (method === 'blockchain.rpa.get_history') return []; // no candidates
      if (method === 'blockchain.rpa.get_mempool') return [];
      if (method === 'blockchain.transaction.get') return '01000000';
      throw new Error(`unexpected electrum method: ${method}`);
    },
    disconnect: async () => {},
  };
}

/**
 * IMPORTANT:
 * When using { from: 'user' }, Commander expects argv to be ONLY user args,
 * e.g. ['scan', '--rpa-prefix', '56'].
 * Do NOT include ['node','bchctl', ...] or it will treat 'node' as a command.
 */
async function runCmd(userArgv: string[], deps: any) {
  const program = new Command();
  registerScanCommand(program, deps);
  await program.parseAsync(userArgv, { from: 'user' });
}

describe('cli scan: prefix normalization + defaults (Fulcrum 1–2 byte prefix)', () => {
  it('normalizes --rpa-prefix hash160 prefix "56" to server prefix "56"', async () => {
    const calls: any[] = [];
    const me = makeWallet('11'.repeat(32));

    await runCmd(['scan', '--rpa-prefix', '56'], {
      loadMeWallet: async () => me,
      getActivePaths: () => ({ profile: 'bob', stateFile: '/tmp/ignore.json' }),
      electrum: { connectElectrum: async () => makeFakeElectrumClient(calls) },
      scanChainWindow: async () => [],
    });

    const hist = calls.find((c) => c[0] === 'blockchain.rpa.get_history');
    assert.ok(hist, 'expected rpa.get_history call');
    assert.equal(hist[1], '56');
  });

  it('extracts prefix from script prefix input "76a91456" => "56"', async () => {
    const calls: any[] = [];
    const me = makeWallet('22'.repeat(32));

    await runCmd(['scan', '--rpa-prefix', '76a91456'], {
      loadMeWallet: async () => me,
      getActivePaths: () => ({ profile: 'bob', stateFile: '/tmp/ignore.json' }),
      electrum: { connectElectrum: async () => makeFakeElectrumClient(calls) },
      scanChainWindow: async () => [],
    });

    const hist = calls.find((c) => c[0] === 'blockchain.rpa.get_history');
    assert.ok(hist);
    assert.equal(hist[1], '56');
  });

  it('truncates longer hex to 2 bytes max (e.g. "aabbccdd" => "aabb")', async () => {
    const calls: any[] = [];
    const me = makeWallet('33'.repeat(32));

    await runCmd(['scan', '--rpa-prefix', 'aabbccdd'], {
      loadMeWallet: async () => me,
      getActivePaths: () => ({ profile: 'bob', stateFile: '/tmp/ignore.json' }),
      electrum: { connectElectrum: async () => makeFakeElectrumClient(calls) },
      scanChainWindow: async () => [],
    });

    const hist = calls.find((c) => c[0] === 'blockchain.rpa.get_history');
    assert.ok(hist);
    assert.equal(hist[1], 'aabb');
  });

  it('normalizes cashaddr --rpa-prefix to first hash byte (e.g. "56")', async () => {
    const calls: any[] = [];
    const me = makeWallet('44'.repeat(32));

    const h160 = hexToBytes('56' + '00'.repeat(19));
    const addr = encodeCashAddr('bchtest', 'P2PKH', h160);

    await runCmd(['scan', '--rpa-prefix', addr], {
      loadMeWallet: async () => me,
      getActivePaths: () => ({ profile: 'bob', stateFile: '/tmp/ignore.json' }),
      electrum: { connectElectrum: async () => makeFakeElectrumClient(calls) },
      scanChainWindow: async () => [],
    });

    const hist = calls.find((c) => c[0] === 'blockchain.rpa.get_history');
    assert.ok(hist);
    assert.equal(hist[1], '56');
  });

  it('defaults to wallet-derived prefix when no --txid and no --rpa-prefix', async () => {
    const calls: any[] = [];
    const scanPrivHex = '55'.repeat(32);
    const me = makeWallet(scanPrivHex);
    const expected = deriveExpectedDefaultPrefix(hexToBytes(scanPrivHex));

    let gotMaxRoleIndex = -1;
    const scanChainWindow = async (args: any) => {
      gotMaxRoleIndex = args.maxRoleIndex;
      return [];
    };

    await runCmd(['scan'], {
      loadMeWallet: async () => me,
      getActivePaths: () => ({ profile: 'bob', stateFile: '/tmp/ignore.json' }),
      electrum: { connectElectrum: async () => makeFakeElectrumClient(calls) },
      scanChainWindow,
    });

    const hist = calls.find((c) => c[0] === 'blockchain.rpa.get_history');
    assert.ok(hist);
    assert.equal(hist[1], expected);
    assert.ok(gotMaxRoleIndex >= 256, `expected maxRoleIndex >= 256, got ${gotMaxRoleIndex}`);
  });

  it('in --txid mode, rpaPrefix is optional and bypasses rpa.get_history', async () => {
    const calls: any[] = [];
    const me = makeWallet('66'.repeat(32));

    await runCmd(['scan', '--txid', 'aa'.repeat(32)], {
      loadMeWallet: async () => me,
      getActivePaths: () => ({ profile: 'bob', stateFile: '/tmp/ignore.json' }),
      electrum: { connectElectrum: async () => makeFakeElectrumClient(calls) },
      // critical: ensure we don’t hit the real scanner which fetches raw tx
      scanChainWindow: async () => [],
    });

    const hist = calls.find((c) => c[0] === 'blockchain.rpa.get_history');
    assert.equal(hist, undefined, 'expected no rpa.get_history in txid mode');
  });
});