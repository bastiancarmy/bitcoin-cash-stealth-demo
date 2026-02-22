// packages/cli/scripts/rpa_find_prefix16.mjs
//
// Find the 16-bit (2-byte) Fulcrum RPA prefix(es) that index a specific txid.
// - If the tx is confirmed: probe only its confirmed height (height..height+1) via rpa.get_history.
// - If the tx is unconfirmed (height <= 0): probe mempool via rpa.get_mempool in two stages:
//     (1) scan all 256 8-bit prefixes to find matching bucket(s)
//     (2) refine within those bucket(s) across 16-bit prefixes (bb00..bbff)
//
// Usage:
//   node packages/cli/scripts/rpa_find_prefix16.mjs chipnet <txid> [--concurrency N]
//
// Output:
//   - server.features.rpa
//   - server.version
//   - tx height
//   - discovered 2-byte prefixes (xxxx)

import { connectElectrum } from '@bch-stealth/electrum';

function parseArg(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  return process.argv[i + 1] ?? null;
}

function asInt(x, dflt) {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

function isTxid(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

function hex2(n) {
  return n.toString(16).padStart(2, '0');
}

function hex4(n) {
  return n.toString(16).padStart(4, '0');
}

async function main() {
  const network = process.argv[2] ?? 'chipnet';
  const txid = (process.argv[3] ?? '').trim().toLowerCase();
  if (!isTxid(txid)) {
    console.error('Usage: node .../rpa_find_prefix16.mjs <network> <txid> [--concurrency N]');
    process.exit(2);
  }

  const concurrency = Math.max(1, asInt(parseArg('--concurrency'), 16));
  const client = await connectElectrum(network);

  try {
    const features = await client.request('server.features');
    console.log('server.features.rpa:', JSON.stringify(features?.rpa ?? null, null, 2));
    console.log('server.version:', features?.server_version ?? '(unknown)');

    // Get tx height (Fulcrum sometimes returns 0 for unconfirmed)
    let height = null;
    try {
      const h = await client.request('blockchain.transaction.get_height', txid);
      if (typeof h === 'number' && Number.isFinite(h)) height = h;
    } catch {
      // ignore
    }

    console.log('tx.height:', height);

    // -----------------------
    // Confirmed history mode
    // -----------------------
    if (height != null && height > 0) {
      const start = height;
      const end = height + 1;

      console.log(`probing 65536 prefixes with concurrency=${concurrency} (history @ ${start}..${end})`);

      const found = [];
      let next = 0;
      let done = 0;

      async function worker() {
        while (true) {
          const i = next++;
          if (i >= 65536) return;

          const prefix = hex4(i);
          try {
            const hist = await client.request('blockchain.rpa.get_history', prefix, start, end);
            if (Array.isArray(hist) && hist.some((it) => String(it?.tx_hash ?? '').toLowerCase() === txid)) {
              found.push(prefix);
            }
          } catch {
            // ignore
          } finally {
            done++;
            if (done % 2048 === 0) {
              process.stderr.write(`\rprogress: ${done}/65536... found=${found.length}`);
            }
          }
        }
      }

      const workers = Array.from({ length: concurrency }, () => worker());
      await Promise.all(workers);
      process.stderr.write(`\rprogress: 65536/65536... found=${found.length}\n`);

      console.log('\nRESULTS');
      console.log('-------');
      console.log('txid:', txid);
      console.log('height:', height);
      console.log('history prefixes (16-bit):', found.length ? found.join(',') : '(none)');

      if (!found.length) {
        console.log(
          '\n❌ Not found under any 16-bit prefix at its confirmed height.\n' +
            'This can happen if the server did not index the tx as RPA, or if get_height is wrong.'
        );
      } else {
        console.log('\n✅ These should match what scan() derives as its default prefix when send/scan are aligned.');
      }

      return;
    }

    // -----------------------
    // Mempool mode (height<=0)
    // -----------------------
    console.log('\n(tx not confirmed or height unknown; probing mempool buckets)');
    console.log('stage 1: probing 256 8-bit prefixes via rpa.get_mempool(prefix8)');

    const hit8 = []; // list of 8-bit prefixes that contain the tx
    for (let i = 0; i < 256; i++) {
      const p8 = hex2(i);
      try {
        const mp = await client.request('blockchain.rpa.get_mempool', p8);
        if (Array.isArray(mp) && mp.some((it) => String(it?.tx_hash ?? '').toLowerCase() === txid)) {
          hit8.push(p8);
        }
      } catch {
        // ignore per-prefix failures
      }
      if (i % 32 === 0) process.stderr.write(`\rprogress8: ${i}/256... hits=${hit8.length}`);
    }
    process.stderr.write(`\rprogress8: 256/256... hits=${hit8.length}\n`);

    if (!hit8.length) {
      console.log('\nRESULTS');
      console.log('-------');
      console.log('txid:', txid);
      console.log('mempool prefixes (8-bit): (none)');
      console.log(
        '\n❌ Not found in any 8-bit mempool bucket.\n' +
          'This implies the server is not indexing this mempool tx via RPA, or it already left the mempool.'
      );
      return;
    }

    console.log('stage 2: refining to 16-bit prefixes within hit 8-bit buckets');

    const found16 = [];
    for (const p8 of hit8) {
      for (let j = 0; j < 256; j++) {
        const p16 = p8 + hex2(j);
        try {
          const mp = await client.request('blockchain.rpa.get_mempool', p16);
          if (Array.isArray(mp) && mp.some((it) => String(it?.tx_hash ?? '').toLowerCase() === txid)) {
            found16.push(p16);
          }
        } catch {
          // ignore
        }
      }
    }

    console.log('\nRESULTS');
    console.log('-------');
    console.log('txid:', txid);
    console.log('height:', height);
    console.log('mempool prefixes (8-bit):', hit8.join(','));
    console.log('mempool prefixes (16-bit):', found16.length ? found16.join(',') : '(none)');

    if (!found16.length) {
      console.log(
        '\n❌ Found in an 8-bit bucket, but not in any 16-bit bucket.\n' +
          'This would be unusual given prefix_bits=16; worth double-checking server behavior.'
      );
    } else {
      console.log('\n✅ Use one of these 16-bit prefixes as the ground-truth for alignment.');
    }
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});