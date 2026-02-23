// packages/cli/scripts/rpa_probe.mjs
// Usage:
//   node packages/cli/scripts/rpa_probe.mjs chipnet 38
//   node packages/cli/scripts/rpa_probe.mjs chipnet 38 293880 293945
//   node packages/cli/scripts/rpa_probe.mjs chipnet --txid <txid> [--range 120]
//
// In txid mode, it:
// - gets tx height
// - parses tx outputs for P2PKH hash160 prefixes
// - probes rpa.get_history + rpa.get_mempool for 1-byte and 2-byte prefixes
// - prints whether the txid is returned by the server index

import { connectElectrum } from '@bch-stealth/electrum';
import { hexToBytes, bytesToHex, decodeVarInt } from '@bch-stealth/utils';

function asInt(x, dflt) {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return null;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function parseTxOutputsP2pkhHash160s(rawHex) {
  const b = hexToBytes(rawHex);
  let pos = 0;

  // version
  pos += 4;

  // inputs
  const inCount = decodeVarInt(b, pos);
  pos += inCount.length;

  for (let i = 0; i < inCount.value; i++) {
    pos += 32 + 4; // prev txid + vout
    const scrLen = decodeVarInt(b, pos);
    pos += scrLen.length + scrLen.value;
    pos += 4; // sequence
  }

  // outputs
  const outCount = decodeVarInt(b, pos);
  pos += outCount.length;

  const outs = [];
  for (let i = 0; i < outCount.value; i++) {
    pos += 8; // value
    const scrLen = decodeVarInt(b, pos);
    pos += scrLen.length;

    const script = b.slice(pos, pos + scrLen.value);
    pos += scrLen.value;

    // P2PKH: 76 a9 14 <20> 88 ac
    if (script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
      const h160 = script.slice(3, 23);
      outs.push({ vout: i, hash160Hex: bytesToHex(h160) });
    }
  }

  return outs;
}

async function getTipHeight(client) {
  try {
    const tipResp = await client.request('blockchain.headers.get_tip');
    if (typeof tipResp?.height === 'number') return tipResp.height;
  } catch {
    // ignore
  }

  try {
    const sub = await client.request('blockchain.headers.subscribe');
    if (typeof sub?.height === 'number') return sub.height;
  } catch {
    // ignore
  }

  return null;
}

async function rpaHistoryChunked(client, prefix, startHeight, endHeightInclusive, chunk = 60) {
  const endExclusive = endHeightInclusive + 1;
  const out = [];
  for (let a = startHeight; a < endExclusive; a += chunk) {
    const b = Math.min(endExclusive, a + chunk);
    const h = await client.request('blockchain.rpa.get_history', prefix, a, b);
    if (Array.isArray(h)) {
      for (const it of h) if (typeof it?.tx_hash === 'string') out.push(it.tx_hash);
    }
  }
  return [...new Set(out)];
}

async function main() {
  const network = process.argv[2] ?? 'chipnet';

  const txid = argValue('--txid');
  const rangeN = asInt(argValue('--range'), 240); // default ±240 blocks if txid mode
  const chunkRaw = asInt(argValue('--chunk'), 60);
  const chunk = Math.max(1, chunkRaw || 60);

  const client = await connectElectrum(network);

  try {
    const features = await client.request('server.features');
    console.log('server.features:', JSON.stringify(features, null, 2));

    const tip = await getTipHeight(client);
    console.log('tipHeight:', tip);

    // ----------------------------
    // TXID MODE
    // ----------------------------
    if (txid) {
      const t = String(txid).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(t)) {
        console.error('--txid must be 64 hex');
        process.exit(2);
      }

      const heightResp = await client.request('blockchain.transaction.get_height', t);
      const height = typeof heightResp === 'number' ? heightResp : (typeof heightResp?.height === 'number' ? heightResp.height : null);

      console.log('tx.height:', height);

      const raw = await client.request('blockchain.transaction.get', t, false);
      if (typeof raw !== 'string') {
        console.error('transaction.get did not return raw hex');
        process.exit(2);
      }

      const p2pkhOuts = parseTxOutputsP2pkhHash160s(raw);
      console.log('tx.p2pkh_outputs:', p2pkhOuts);

      if (!p2pkhOuts.length) {
        console.log('No P2PKH outputs found in tx (cannot derive prefix test).');
        process.exit(0);
      }

      // Derive prefixes from the FIRST P2PKH output’s hash160
      const h0 = p2pkhOuts[0].hash160Hex;
      const p1 = h0.slice(0, 2);
      const p2 = h0.slice(0, 4);

      console.log('derived prefixes:', { p1, p2 });

      // Choose a probe range
      const endHeight = height != null ? height : (tip ?? 0);
      const startHeight = Math.max(0, endHeight - rangeN);

      console.log(`probe range: ${startHeight}..${endHeight} (chunk=${chunk})`);

      // mempool checks
      for (const p of [p1, p2]) {
        const mp = await client.request('blockchain.rpa.get_mempool', p);
        const mpTxs = Array.isArray(mp) ? mp.map((x) => x?.tx_hash).filter((x) => typeof x === 'string') : [];
        console.log(`rpa.get_mempool(${p}) len=${mpTxs.length} contains_txid=${mpTxs.includes(t)}`);
      }

      // history checks (chunked)
      for (const p of [p1, p2]) {
        const txs = await rpaHistoryChunked(client, p, startHeight, endHeight, chunk);
        console.log(`rpa.get_history(${p}) unique_txids=${txs.length} contains_txid=${txs.includes(t)}`);
        console.log('sample:', txs.slice(0, 10).map((x) => `  ${x}`).join('\n'));
      }

      process.exit(0);
    }

    // ----------------------------
    // PREFIX MODE (existing behavior)
    // ----------------------------
    const prefix = (process.argv[3] ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{2}$/.test(prefix)) {
      console.error('prefix must be 1 byte hex (e.g. "38") OR use --txid');
      process.exit(2);
    }

    const fromArg = process.argv[4];
    const toArg = process.argv[5];

    const endHeight = asInt(toArg, tip ?? 0);
    const startHeight = asInt(fromArg, Math.max(0, endHeight - 120));

    console.log(`range: ${startHeight}..${endHeight} (exclusive end passed as end+1 in scan)`);

    const mp = await client.request('blockchain.rpa.get_mempool', prefix);
    console.log(`rpa.get_mempool(${prefix}) len=`, Array.isArray(mp) ? mp.length : 'non-array', mp);

    const hist = await client.request('blockchain.rpa.get_history', prefix, startHeight, endHeight + 1);
    console.log(`rpa.get_history(${prefix},${startHeight},${endHeight + 1}) len=`, Array.isArray(hist) ? hist.length : 'non-array');
    if (Array.isArray(hist) && hist.length) {
      console.log('first:', hist[0]);
      console.log('last :', hist[hist.length - 1]);
    }

    // chunked probe
    const chunkStart = Math.max(0, endHeight - 180);
    const txids = new Set();

    for (let a = chunkStart; a <= endHeight; a += chunk) {
      const b = Math.min(endHeight + 1, a + chunk);
      const h = await client.request('blockchain.rpa.get_history', prefix, a, b);
      console.log(`chunk ${a}..${b} len=${Array.isArray(h) ? h.length : 'non-array'}`);
      if (Array.isArray(h)) for (const it of h) if (typeof it?.tx_hash === 'string') txids.add(it.tx_hash);
    }

    console.log('unique txids from chunks:', txids.size);
    console.log([...txids].slice(0, 25).map((t) => `  ${t}`).join('\n'));
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});