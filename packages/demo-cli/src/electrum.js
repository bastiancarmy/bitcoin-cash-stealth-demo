// src/electrum.js (updated)
import { ElectrumClient } from '@electrum-cash/network';
import { bytesToNumberBE } from '@noble/curves/utils.js';
import { ELECTRUM_SERVERS, NETWORK } from './config.js';
import { shuffleArray, hexToBytes, bytesToHex, reverseBytes, concat, bytesToBigInt, decodeVarInt } from './utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeCashAddress } from './cashaddr.js';

export async function getPrevoutScript(txid, vout, network) {
  const client = await connectElectrum(network);
  const txHex = await client.request('blockchain.transaction.get', txid);
  await client.disconnect();

  const bytes = hexToBytes(txHex);
  let pos = 0;
  pos += 4; // version

  const inCountInfo = decodeVarInt(bytes, pos); pos += inCountInfo.length;
  for (let i = 0; i < inCountInfo.value; i++) {
    pos += 32 + 4; // txid + vout
    const sigLenInfo = decodeVarInt(bytes, pos); pos += sigLenInfo.length + sigLenInfo.value; // scriptSig
    pos += 4; // sequence
  }

  const outCountInfo = decodeVarInt(bytes, pos); pos += outCountInfo.length;
  for (let i = 0; i < outCountInfo.value; i++) {
    pos += 8; // value
    const scriptLenInfo = decodeVarInt(bytes, pos); pos += scriptLenInfo.length;
    const script = bytes.slice(pos, pos + scriptLenInfo.value);
    pos += scriptLenInfo.value;
    if (i === vout) return script;
  }
  throw new Error('vout not found');
}


export function scriptToScripthash(script) {
  if (!(script instanceof Uint8Array)) throw new Error('Script must be Uint8Array');
  const hash = sha256(script);
  const reversed = reverseBytes(hash);
  return bytesToHex(reversed);
}

export async function connectElectrum(network = NETWORK, retries = 10) {
  const servers = shuffleArray([...ELECTRUM_SERVERS]);
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const server of servers) {
      try {
        console.log(`Connecting to ${server.host}:${server.port} (${server.protocol}) - Attempt ${attempt + 1}`);
        let clientOptions = {};
        if (network === 'chipnet') {
          console.warn('⚠️ Using self-signed cert options for chipnet (insecure for prod)');
          clientOptions = { rejectUnauthorized: false };
        }
        const client = new ElectrumClient('bch-pz-sqh-demo', '1.4.1', server.host, server.port, server.protocol, clientOptions);
        const connectionPromise = client.connect();
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 10000));
        await Promise.race([connectionPromise, timeoutPromise]);
        console.log(`Connected to ${server.host}`);
        return client;
      } catch (err) {
        console.error(`Failed to connect to ${server.host} (attempt ${attempt + 1}):`, err.message);
      }
    }
    const delay = Math.pow(2, attempt) * 1000;
    console.log(`Backoff delay: ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('No Electrum servers available after retries');
}

export async function getUtxosFromScripthash(scriptHash, network = NETWORK, includeUnconfirmed = true) {
  const client = await connectElectrum(network);
  try {
    const utxos = await client.request('blockchain.scripthash.listunspent', scriptHash);
    console.log('Fetched', utxos.length, 'UTXOs');

    const processed = utxos.map((utxo) => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      value: utxo.value,
      height: utxo.height,           // 0 for unconfirmed
      token_data: utxo.token_data,   // if server provides it
    }));

    return includeUnconfirmed ? processed : processed.filter((u) => u.height > 0);
  } finally {
    await client.disconnect();
  }
}

// getUtxos to pass includeUnconfirmed=true for 0-conf support
export async function getUtxos(address, network, includeUnconfirmed = true) {
  const scriptHash = addressToScripthash(address);
  return getUtxosFromScripthash(scriptHash, network, includeUnconfirmed);
}

export async function getFeeRate(network = NETWORK) {
  global.lastFeeRate = global.lastFeeRate || null;
  global.lastFeeRateTime = global.lastFeeRateTime || 0;

  if (global.lastFeeRate && Date.now() - global.lastFeeRateTime < 300000) {
    return global.lastFeeRate;
  }

  const client = await connectElectrum(network);
  let feeRate = 1;

  try {
    // relay fee
    let relayFeeBCHPerKB = await client.request('blockchain.relayfee');
    if (relayFeeBCHPerKB < 0) relayFeeBCHPerKB = 0.00001;
    const relayFeeSatPerByte = Math.ceil((relayFeeBCHPerKB * 1e8) / 1000);
    console.log(`Server relay fee: ${relayFeeBCHPerKB} BCH/kB (${relayFeeSatPerByte} sat/byte)`);

    // estimatefee
    let estimatedFeeBCHPerKB = await client.request('blockchain.estimatefee', 2);
    let estimatedFeeSatPerByte = 1;
    if (estimatedFeeBCHPerKB >= 0) {
      estimatedFeeSatPerByte = Math.ceil((estimatedFeeBCHPerKB * 1e8) / 1000);
    } else {
      console.warn('Estimatefee returned -1; using relay fee as base');
    }

    feeRate = Math.max(relayFeeSatPerByte, estimatedFeeSatPerByte, 1);

    // chipnet guardrail
    if (network === 'chipnet') feeRate = Math.max(feeRate, 2);
  } catch (err) {
    console.error('Fee fetch failed:', err);
    feeRate = network === 'chipnet' ? 2 : 1;
  } finally {
    await client.disconnect();
  }

  global.lastFeeRate = feeRate;
  global.lastFeeRateTime = Date.now();
  return feeRate;
}

export async function estimateFee() {
  const client = await connectElectrum(NETWORK);
  try {
    const feeBCHPerKB = await client.request('blockchain.estimatefee', 1); // 1 block target
    console.log(`Raw fee estimate: ${feeBCHPerKB} BCH/KB`);
    let feeSatPerKB = Math.ceil(feeBCHPerKB * 1e8);
    feeSatPerKB = Math.max(feeSatPerKB, 1000); // 1 sat/vB minimum
    console.log(`Adjusted fee rate: ${feeSatPerKB} sat/KB (${feeSatPerKB/1000} sat/byte)`);
    return feeSatPerKB;
  } catch (err) {
    console.error('Fee estimation failed:', err);
    return 1000;
  } finally {
    await client.disconnect();
  }
}

export async function broadcastTx(txHex, network = NETWORK) {
  const client = await connectElectrum(network);
  try {
    const response = await client.request('blockchain.transaction.broadcast', txHex);

    // Some stacks return an Error object instead of throwing:
    if (response instanceof Error) throw response;

    if (typeof response === 'string' && response.length === 64 && /^[0-9a-f]{64}$/i.test(response)) {
      return response;
    }
    if (typeof response === 'object' && response?.error) {
      throw new Error(`Broadcast error: ${response.error.message ?? JSON.stringify(response.error)}`);
    }

    throw new Error(`Invalid broadcast response: ${String(response)}`);
  } catch (e) {
    // Preserve the original message
    throw new Error(e?.message ?? String(e));
  } finally {
    await client.disconnect();
  }
}

export function addressToScripthash(address) {
  const decoded = decodeCashAddress(address);
  if (decoded.prefix !== 'bitcoincash' && decoded.prefix !== 'bchtest') throw new Error('Invalid CashAddr prefix');
  if (decoded.type !== 'P2PKH') throw new Error('Only P2PKH (type 0) supported');
  const hash = decoded.hash;
  if (hash.length !== 20) throw new Error('Invalid PKH length');
  const script = concat(hexToBytes('76a914'), hash, hexToBytes('88ac'));
  const hashed = sha256(script);
  const reversed = reverseBytes(hashed);
  return bytesToHex(reversed);
}

export async function filterNftsByCategory(categoryHex, address, startHeight) {
  const client = await connectElectrum(NETWORK);
  try {
    const utxos = await getUtxos(address);
    return utxos.filter(utxo => utxo.token_data && utxo.token_data.category === categoryHex);
  } finally {
    await client.disconnect();
  }
}

/**
 * Helper: fetch prevout (scriptPubKey bytes + value) for a given txid:vout.
 * Tries verbose JSON first; falls back to parsing raw hex if necessary.
 */
export async function getPrevoutScriptAndValue(txid, vout, network = NETWORK) {
  const client = await connectElectrum(network);
  try {
    // Try verbose=true (some servers support it)
    let tx = await client.request('blockchain.transaction.get', txid, true);
    if (typeof tx === 'object' && tx && tx.vout) {
      const out = tx.vout[vout];
      // Electrum/Fulcrum values are in BCH; some servers in sats; normalize below.
      // Prefer satoshis if provided, else convert from BCH
      let valueSats;
      if (typeof out.value_satoshi === 'number') {
        valueSats = out.value_satoshi;
      } else if (typeof out.value === 'number') {
        valueSats = Math.round(out.value * 1e8);
      } else if (typeof out.value === 'string') {
        // Some servers return decimal string in BCH
        valueSats = Math.round(parseFloat(out.value) * 1e8);
      } else {
        throw new Error('Unsupported verbose tx format for value');
      }
      const scriptHex = out.scriptPubKey?.hex || out.scriptPubKey;
      if (!scriptHex) throw new Error('Missing scriptPubKey in verbose tx');
      return { scriptPubKey: hexToBytes(scriptHex), value: valueSats };
    }

    // Fallback: raw hex
    if (typeof tx !== 'string') {
      // Some servers ignore verbose flag and still return hex
      tx = await client.request('blockchain.transaction.get', txid);
      if (typeof tx !== 'string') throw new Error('Unexpected electrum response for transaction.get');
    }
    const bytes = hexToBytes(tx);
    let pos = 0;
    // version
    pos += 4;
    // inputs
    const inCount = decodeVarInt(bytes, pos); pos += inCount.length;
    for (let i = 0; i < inCount.value; i++) {
      pos += 32; // txid
      pos += 4;  // vout
      const scrLen = decodeVarInt(bytes, pos); pos += scrLen.length;
      pos += scrLen.value; // scriptSig
      pos += 4; // sequence
    }
    // outputs
    const outCount = decodeVarInt(bytes, pos); pos += outCount.length;
    if (vout >= outCount.value) throw new Error('vout index out of range');
    // iterate until target vout
    for (let i = 0; i < outCount.value; i++) {
      const valueLE = bytes.slice(pos, pos + 8);
      const value = Number(bytesToBigInt(reverseBytes(valueLE))); pos += 8;
      const scrLen = decodeVarInt(bytes, pos); pos += scrLen.length;
      const script = bytes.slice(pos, pos + scrLen.value); pos += scrLen.value;
      if (i === vout) {
        return { scriptPubKey: script, value };
      }
    }
    throw new Error('Could not locate vout');
  } finally {
    await client.disconnect();
  }
}

export function parseTx(txHex) {
  const bytes = hexToBytes(txHex);
  let pos = 0;

  const version = bytesToBigInt(reverseBytes(bytes.slice(pos, pos + 4)));
  pos += 4;

  const inputCountInfo = decodeVarInt(bytes, pos);
  pos += inputCountInfo.length;
  const inputCount = inputCountInfo.value;

  const inputs = [];
  for (let i = 0; i < inputCount; i++) {
    const txid = bytesToHex(reverseBytes(bytes.slice(pos, pos + 32)));
    pos += 32;
    const vout = Number(bytesToBigInt(reverseBytes(bytes.slice(pos, pos + 4))));
    pos += 4;

    const scriptSigSizeInfo = decodeVarInt(bytes, pos);
    pos += scriptSigSizeInfo.length;
    const scriptSig = bytes.slice(pos, pos + scriptSigSizeInfo.value);
    pos += scriptSigSizeInfo.value;

    const sequence = bytesToBigInt(reverseBytes(bytes.slice(pos, pos + 4)));
    pos += 4;

    inputs.push({ txid, vout, scriptSig, sequence });
  }

  const outputCountInfo = decodeVarInt(bytes, pos);
  pos += outputCountInfo.length;
  const outputCount = outputCountInfo.value;

  const outputs = [];
  for (let i = 0; i < outputCount; i++) {
    const value = bytesToBigInt(reverseBytes(bytes.slice(pos, pos + 8)));
    pos += 8;

    const scriptSizeInfo = decodeVarInt(bytes, pos);
    pos += scriptSizeInfo.length;

    const scriptPubKey = bytes.slice(pos, pos + scriptSizeInfo.value);
    pos += scriptSizeInfo.value;

    let token_data = null;
    if (scriptPubKey[0] === 0xef) {
      token_data = parseTokenPrefix(scriptPubKey);
    }
    outputs.push({ value, scriptPubKey, token_data });
  }

  const locktime = bytesToBigInt(reverseBytes(bytes.slice(pos, pos + 4)));
  pos += 4;

  return { version, inputs, outputs, locktime };
}

function parseTokenPrefix(script) {
  let pos = 0;
  if (script[pos] !== 0xef) return null;
  pos += 1;
  const category = script.slice(pos, pos + 32); pos += 32;
  const bitfield = script[pos]; pos += 1;

  const hasCommitment = (bitfield & 0x40) !== 0;
  const hasNft        = (bitfield & 0x20) !== 0;
  const hasAmount     = (bitfield & 0x10) !== 0;

  const capabilityCode = bitfield & 0x0f;
  const capabilities = ['none', 'mutable', 'minting'];
  const capability = hasNft ? capabilities[capabilityCode] : null;

  let commitment = new Uint8Array(0);
  if (hasCommitment) {
    const commitLenInfo = decodeVarInt(script, pos);
    pos += commitLenInfo.length;
    commitment = script.slice(pos, pos + commitLenInfo.value);
    pos += commitLenInfo.value;
  }

  let amount = 0n;
  if (hasAmount) {
    const amountInfo = decodeVarInt(script, pos);
    pos += amountInfo.length;
    amount = BigInt(amountInfo.value);
  }

  return {
    category,
    nft: hasNft ? { capability, commitment } : undefined,
    amount: hasAmount ? amount : 0n
  };
}

export async function getTxDetails(txId, network) {
  const client = await connectElectrum(network);
  const txHex = await client.request('blockchain.transaction.get', txId);
  await client.disconnect();
  return parseTx(txHex);
}

export async function getTipHeader(network) {
  const client = await connectElectrum(network);
  try {
    const tip = await client.request('blockchain.headers.subscribe');
    // Extract timestamp from header hex (bytes 68-71 LE, reverse for BE parse)
    const headerBytes = hexToBytes(tip.hex);
    const timestampLE = headerBytes.slice(68, 72);
    const timestamp = bytesToNumberBE(reverseBytes(timestampLE));
    return { height: tip.height, timestamp };
  } finally {
    await client.disconnect();
  }
}