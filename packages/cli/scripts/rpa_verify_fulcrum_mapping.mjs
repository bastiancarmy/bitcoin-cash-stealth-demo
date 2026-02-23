// packages/cli/scripts/rpa_verify_fulcrum_mapping.mjs
//
// Verify what Fulcrum indexes for blockchain.rpa.get_history(prefix, ...)
// using a ground-truth txid by:
//  - fetching raw tx via electrum
//  - computing electrum scripthash = hex(reverse(sha256(scriptPubKey)))
//  - querying rpa.get_history for prefix16/prefix8 and checking membership
//
// Usage:
//   node packages/cli/scripts/rpa_verify_fulcrum_mapping.mjs chipnet <txid>
//
// Optional env:
//   BCH_STEALTH_RPA_HISTORY_BLOCKS=60   (defaults to server.features.rpa.history_block_limit or 60)
//

import { connectElectrum } from '../../electrum/dist/electrum.js'; // repo uses dist at runtime
import { sha256, reverseBytes, bytesToHex, hexToBytes } from '../../utils/dist/index.js';

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function readVarInt(b, o) {
  const x = b[o];
  if (x < 0xfd) return { n: x, o: o + 1 };
  if (x === 0xfd) {
    const n = b[o + 1] | (b[o + 2] << 8);
    return { n, o: o + 3 };
  }
  if (x === 0xfe) {
    const n =
      (b[o + 1]) |
      (b[o + 2] << 8) |
      (b[o + 3] << 16) |
      (b[o + 4] << 24);
    return { n: n >>> 0, o: o + 5 };
  }
  // 0xff (u64)
  let n = 0n;
  for (let i = 0; i < 8; i++) n |= BigInt(b[o + 1 + i]) << (8n * BigInt(i));
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    // for our usage (output script length), this should never happen
    throw new Error('varint too large');
  }
  return { n: Number(n), o: o + 9 };
}

function readU32LE(b, o) {
  return (
    (b[o]) |
    (b[o + 1] << 8) |
    (b[o + 2] << 16) |
    (b[o + 3] << 24)
  ) >>> 0;
}

function readU64LEBig(b, o) {
  let n = 0n;
  for (let i = 0; i < 8; i++) n |= BigInt(b[o + i]) << (8n * BigInt(i));
  return n;
}

function scriptToScripthashHex(scriptBytes) {
  // Electrum scripthash: hex(reverse(sha256(script)))
  return bytesToHex(reverseBytes(sha256(scriptBytes))).toLowerCase();
}

function parseOutputsFromRawTxHex(txHex) {
  const b = hexToBytes(txHex);
  let o = 0;

  const version = readU32LE(b, o); o += 4;

  // handle optional segwit marker/flag just in case (BCH txs should not have it)
  if (b[o] === 0x00 && b[o + 1] === 0x01) {
    throw new Error('unexpected segwit marker/flag in BCH tx');
  }

  const vinN = readVarInt(b, o); o = vinN.o;

  // skip inputs
  for (let i = 0; i < vinN.n; i++) {
    o += 32; // prev txid (LE in raw tx)
    o += 4;  // prev vout
    const scriptLen = readVarInt(b, o); o = scriptLen.o;
    o += scriptLen.n; // scriptSig
    o += 4; // sequence
  }

  const voutN = readVarInt(b, o); o = voutN.o;

  const outs = [];
  for (let i = 0; i < voutN.n; i++) {
    const value = readU64LEBig(b, o); o += 8;
    const pkLen = readVarInt(b, o); o = pkLen.o;
    const script = b.slice(o, o + pkLen.n); o += pkLen.n;
    outs.push({ vout: i, valueSats: value, script });
  }

  const locktime = readU32LE(b, o); o += 4;
  if (o !== b.length) {
    // not fatal, but indicates we mis-parsed
    throw new Error(`raw tx parse ended at ${o} but length is ${b.length}`);
  }

  return { version, locktime, outs };
}

async function getHistoryLimit(client) {
  try {
    const features = await client.request('server.features');
    const lim = Number(features?.rpa?.history_block_limit);
    if (Number.isFinite(lim) && lim > 0) return lim | 0;
  } catch {}
  const env = Number(process.env.BCH_STEALTH_RPA_HISTORY_BLOCKS || '60');
  if (Number.isFinite(env) && env > 0) return env | 0;
  return 60;
}

async function main() {
  const [network, txid] = process.argv.slice(2);
  if (!network) die('usage: node .../rpa_verify_fulcrum_mapping.mjs <network> <txid>');
  if (!txid || !/^[0-9a-f]{64}$/i.test(txid)) die('txid must be 64-hex');

  const client = await connectElectrum(network);

  try {
    const features = await client.request('server.features');
    console.log('[features] rpa.prefix_bits      =', features?.rpa?.prefix_bits);
    console.log('[features] rpa.prefix_bits_min  =', features?.rpa?.prefix_bits_min);
    console.log('[features] rpa.history_block_limit =', features?.rpa?.history_block_limit);

    // verbose get: Fulcrum typically supports (txid, verbose=true)
    const txv = await client.request('blockchain.transaction.get', txid, true);
    const txHex = txv?.hex || txv; // some servers return object, some return hex
    const height = Number(txv?.blockheight ?? txv?.height ?? txv?.block_height ?? -1);

    if (typeof txHex !== 'string' || !/^[0-9a-f]+$/i.test(txHex)) {
      throw new Error('unexpected blockchain.transaction.get response (no hex)');
    }
    console.log('[tx] blockheight =', height);

    const { outs } = parseOutputsFromRawTxHex(txHex);

    const historyLimit = await getHistoryLimit(client);
    const startH = Number.isFinite(height) && height > 0 ? height : 0;
    const endH = Number.isFinite(height) && height > 0 ? height + 1 : 999999999;

    console.log('[tx] outputs =', outs.length);
    console.log('');

    for (const out of outs) {
      const sh = scriptToScripthashHex(out.script);
      const prefix16 = sh.slice(0, 4);
      const prefix8 = sh.slice(0, 2);

      console.log(`--- vout ${out.vout} ---`);
      console.log('valueSats:', out.valueSats.toString());
      console.log('scriptPubKeyHex:', bytesToHex(out.script).toLowerCase());
      console.log('scripthashHex:  ', sh);
      console.log('prefix16:', prefix16, 'prefix8:', prefix8);

      if (height > 0) {
        // query exact-height window first (most deterministic)
        const a = height;
        const b = height + 1;

        const h16 = await client.request('blockchain.rpa.get_history', prefix16, a, b);
        const txs16 = Array.isArray(h16) ? h16.map((x) => x?.tx_hash).filter(Boolean) : [];
        const hit16 = txs16.includes(txid);
        console.log(`rpa.get_history(${prefix16}, ${a}..${b}) len=${txs16.length} containsTx=${hit16}`);

        const h8 = await client.request('blockchain.rpa.get_history', prefix8, a, b);
        const txs8 = Array.isArray(h8) ? h8.map((x) => x?.tx_hash).filter(Boolean) : [];
        const hit8 = txs8.includes(txid);
        console.log(`rpa.get_history(${prefix8}, ${a}..${b}) len=${txs8.length} containsTx=${hit8}`);

        // If neither hits, also try chunked around the height within historyLimit
        if (!hit16 && !hit8) {
          const a2 = Math.max(0, height - historyLimit);
          const b2 = height + 1;
          const h16b = await client.request('blockchain.rpa.get_history', prefix16, a2, b2);
          const txs16b = Array.isArray(h16b) ? h16b.map((x) => x?.tx_hash).filter(Boolean) : [];
          console.log(`(wider) rpa.get_history(${prefix16}, ${a2}..${b2}) containsTx=${txs16b.includes(txid)}`);

          const h8b = await client.request('blockchain.rpa.get_history', prefix8, a2, b2);
          const txs8b = Array.isArray(h8b) ? h8b.map((x) => x?.tx_hash).filter(Boolean) : [];
          console.log(`(wider) rpa.get_history(${prefix8}, ${a2}..${b2}) containsTx=${txs8b.includes(txid)}`);
        }
      } else {
        console.log('(tx unconfirmed or height unknown; skipping height-window membership checks)');
      }

      console.log('');
    }

    console.log('Done.');
  } finally {
    try { await client.disconnect(); } catch {}
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});