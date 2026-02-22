// packages/cli/scripts/rpa_find_prefix.mjs
//
// Find which Fulcrum RPA prefix (if any) indexes a given txid.
//
// Usage:
//   node packages/cli/scripts/rpa_find_prefix.mjs chipnet <txid>
//   node packages/cli/scripts/rpa_find_prefix.mjs chipnet <txid> --concurrency 8
//
// What it does:
//  1) Connects to Electrum/Fulcrum using @bch-stealth/electrum
//  2) Fetches tx height (blockchain.transaction.get_height)
//  3) Brute-forces all 1-byte prefixes 00..ff:
//      - blockchain.rpa.get_history(prefix, height, height+1)
//      - blockchain.rpa.get_mempool(prefix)
//     and checks whether txid is included.
//
// Output:
//   - tx height
//   - any matching prefixes (history and/or mempool)

import { connectElectrum } from '@bch-stealth/electrum';

function parseArgs(argv) {
  const out = {
    network: argv[2] ?? 'chipnet',
    txid: (argv[3] ?? '').trim().toLowerCase(),
    concurrency: 8,
  };

  for (let i = 4; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--concurrency' || a === '-c') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n >= 1 && n <= 64) out.concurrency = Math.floor(n);
      i++;
      continue;
    }
  }
  return out;
}

function assertTxid(txid) {
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    console.error('txid must be 64-char hex');
    process.exit(2);
  }
}

function toHex2(n) {
  return n.toString(16).padStart(2, '0');
}

async function withConcurrency(items, limit, fn) {
  const results = [];
  let idx = 0;

  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

async function main() {
  const { network, txid, concurrency } = parseArgs(process.argv);
  assertTxid(txid);

  const client = await connectElectrum(network);

  try {
    // features (optional but helpful)
    let features = null;
    try {
      features = await client.request('server.features');
    } catch {}
    if (features) {
      console.log('server.features.rpa:', JSON.stringify(features?.rpa ?? null, null, 2));
      console.log('server.version:', features?.server_version ?? '(unknown)');
    } else {
      console.log('server.features: (unavailable)');
    }

    // tip height (best effort)
    let tip = null;
    try {
      const tipResp = await client.request('blockchain.headers.get_tip');
      if (typeof tipResp?.height === 'number') tip = tipResp.height;
    } catch {}
    if (tip == null) {
      try {
        const sub = await client.request('blockchain.headers.subscribe');
        if (typeof sub?.height === 'number') tip = sub.height;
      } catch {}
    }
    console.log('tipHeight:', tip);

    // tx height
    let txHeight = null;
    try {
      const h = await client.request('blockchain.transaction.get_height', txid);
      if (typeof h === 'number' && Number.isFinite(h)) txHeight = h;
      // some servers might return {height: n}
      if (txHeight == null && typeof h?.height === 'number') txHeight = h.height;
    } catch (e) {
      console.error('❌ failed blockchain.transaction.get_height:', e?.message ?? String(e));
    }

    if (txHeight == null) {
      console.error('❌ could not determine tx height; cannot do per-block RPA probe.');
      process.exit(1);
    }
    console.log('tx.height:', txHeight);

    // build prefixes 00..ff
    const prefixes = [];
    for (let i = 0; i < 256; i++) prefixes.push(toHex2(i));

    console.log(`probing 256 prefixes with concurrency=${concurrency} (history @ height ${txHeight}..${txHeight + 1}, plus mempool)`);

    const foundHistory = [];
    const foundMempool = [];

    // probe history in that exact block
    await withConcurrency(prefixes, concurrency, async (p) => {
      try {
        const hist = await client.request('blockchain.rpa.get_history', p, txHeight, txHeight + 1);
        if (Array.isArray(hist) && hist.some((it) => String(it?.tx_hash ?? '').toLowerCase() === txid)) {
          foundHistory.push(p);
        }
      } catch {
        // ignore (server might reject some prefix formats, etc.)
      }
    });

    // probe mempool
    await withConcurrency(prefixes, concurrency, async (p) => {
      try {
        const mp = await client.request('blockchain.rpa.get_mempool', p);
        if (Array.isArray(mp) && mp.some((it) => String(it?.tx_hash ?? '').toLowerCase() === txid)) {
          foundMempool.push(p);
        }
      } catch {
        // ignore
      }
    });

    foundHistory.sort();
    foundMempool.sort();

    console.log('');
    console.log('RESULTS');
    console.log('-------');
    console.log('txid:', txid);
    console.log('height:', txHeight);

    console.log('history prefixes:', foundHistory.length ? foundHistory.join(',') : '(none)');
    console.log('mempool prefixes :', foundMempool.length ? foundMempool.join(',') : '(none)');

    if (!foundHistory.length && !foundMempool.length) {
      console.log('');
      console.log(
        '⚠️  Not found under any 1-byte prefix. This strongly suggests this tx is NOT indexed by Fulcrum RPA at all.'
      );
      console.log(
        '    If you expected it to be discoverable via blockchain.rpa.*, the send-side output format likely does not match Fulcrum RPA indexing.'
      );
    } else {
      console.log('');
      console.log('✅ Found. Next step: make scan() query the discovered prefix(es) (or auto-detect).');
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