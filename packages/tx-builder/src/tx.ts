// src/tx.js
// -----------------------------------------------------------------------------
// BCH-compatible transaction helpers (CashTokens aware)
// - Uses custom BCH Schnorr sign/verify from utils.js (not noble schnorr)
// - Jacobi via modPow implemented in utils.js
// - Preimage builder supports CashTokens token prefix (HF-20230515)
//
// NOTE: Keep tx.outputs as an array of { value, scriptPubKey } objects in callers.
//       buildRawTx() supports blobs, but arrays are clearer and less error prone.
// -----------------------------------------------------------------------------

import { normalizeCategory32 } from './token.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  concat,
  hexToBytes,
  bytesToHex,
  varInt,
  uint32le,
  uint64le,
  hash160,
  pushDataPrefix,
  minimalScriptNumber,
} from '@bch-stealth/utils';

import { bchSchnorrSign, bchSchnorrVerify } from '@bch-stealth/crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/* ========================================================================== */
/* Local serialization utilities                                              */
/* ========================================================================== */

/** Serialize outpoint: little-endian txid (32B) + vout (u32 LE) */
export function getOutpoint(input) {
  return concat(hexToBytes(input.txid).reverse(), uint32le(input.vout));
}

export function getAllPrevOut(inputs: any) {
  const parts: Uint8Array[] = [];
  for (const inp of inputs) parts.push(getOutpoint(inp));
  return concat(...parts);
}

export function getAllSequences(inputs: any) {
  const parts: Uint8Array[] = [];
  for (const inp of inputs) parts.push(uint32le(inp.sequence));
  return concat(...parts);
}

/* ========================================================================== */
/* Token prefix splitter (CashTokens)                                         */
/* ========================================================================== */
/**
 * Split a raw locking script into { prefix, locking } where `prefix` is the
 * 0xef... CashTokens prefix if present; otherwise prefix=null and locking=raw.
 *
 * Heuristic: if first byte is 0xef, scan forward until we hit a standard P2PKH
 * (76 a9 14 .. 88 ac) or P2SH (a9 14 .. 87) start; everything before that is prefix.
 */
export function splitTokenPrefix(rawScript) {
  if (!(rawScript instanceof Uint8Array)) rawScript = new Uint8Array(rawScript);
  if (rawScript.length === 0 || rawScript[0] !== 0xef) {
    return { prefix: null, locking: rawScript };
  }

  const isP2PKHAt = (i) =>
    i + 25 <= rawScript.length &&
    rawScript[i] === 0x76 &&
    rawScript[i + 1] === 0xa9 &&
    rawScript[i + 2] === 0x14 &&
    rawScript[i + 23] === 0x88 &&
    rawScript[i + 24] === 0xac;

  const isP2SHAt = (i) =>
    i + 23 <= rawScript.length &&
    rawScript[i] === 0xa9 &&
    rawScript[i + 1] === 0x14 &&
    rawScript[i + 22] === 0x87;

  for (let i = 1; i < rawScript.length; i++) {
    if (isP2PKHAt(i) || isP2SHAt(i)) {
      const prefix = rawScript.slice(0, i);
      const locking = rawScript.slice(i);
      return { prefix, locking };
    }
  }

  // Fallback: treat all as locking if we couldn't parse
  return { prefix: null, locking: rawScript };
}

/* ========================================================================== */
/* Script builders                                                            */
/* ========================================================================== */

export function getP2PKHScript(hash160) {
  return concat(hexToBytes('76a914'), hash160, hexToBytes('88ac'));
}

export function getP2SHScript(scriptHash20) {
  return concat(
    new Uint8Array([0xa9, 0x14]), // OP_HASH160 push(20)
    scriptHash20,
    new Uint8Array([0x87]) // OP_EQUAL
  );
}

export function getBobRedeemScript(bobPubKeyHash) {
  return concat(
    new Uint8Array([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 push(20)
    bobPubKeyHash,
    new Uint8Array([0x88, 0xac]) // OP_EQUALVERIFY OP_CHECKSIG
  );
}

function toU8Script(lockingScript) {
  // Accept: Uint8Array (incl Buffer), hex string, number[], or libauth object shapes
  if (lockingScript instanceof Uint8Array) return lockingScript;

  // libauth shape: { success:true, bytecode: Uint8Array }
  if (
    lockingScript &&
    typeof lockingScript === 'object' &&
    lockingScript.bytecode instanceof Uint8Array
  ) {
    return lockingScript.bytecode;
  }

  if (typeof lockingScript === 'string') {
    const h = lockingScript.startsWith('0x') ? lockingScript.slice(2) : lockingScript;
    return hexToBytes(h);
  }

  if (Array.isArray(lockingScript)) return Uint8Array.from(lockingScript);

  throw new TypeError(`lockingScript must be Uint8Array/hex/number[]/bytecode-object, got ${typeof lockingScript}`);
}

/**
 * Prepend a CashTokens token prefix to a locking script.
 */
export function addTokenToScript(token, lockingScript) {
  console.log('Using updated addTokenToScript with nft handling');

  // 🔒 Normalize lockingScript FIRST
  const script = toU8Script(lockingScript);

  // No token info → leave script unchanged
  if (!token || !token.category) return script;

  if (!(token.category instanceof Uint8Array) || token.category.length !== 32) {
    throw new Error('token.category must be Uint8Array of 32 bytes');
  }

  const prefixParts: Uint8Array[] = [new Uint8Array([0xef])]; // CashTokens prefix marker
  prefixParts.push(token.category);

  let bitfield = 0x00;
  const hasNft = !!token.nft;
  const hasAmount = token.amount !== undefined && token.amount > 0n;

  // Normalize capability to a number 0–2
  let capability = 0;
  /** @type {Uint8Array | undefined} */
  let commitment;
  let hasCommitment = false;

  if (hasNft) {
    const rawCap = token.nft.capability ?? 0;

    if (typeof rawCap === 'string') {
      if (rawCap === 'none') capability = 0;
      else if (rawCap === 'mutable') capability = 1;
      else if (rawCap === 'minting') capability = 2;
      else throw new Error(`Invalid NFT capability string: ${rawCap}`);
    } else {
      capability = rawCap;
    }

    commitment = token.nft.commitment;
    hasCommitment = commitment instanceof Uint8Array && commitment.length > 0;
  }

  // Spec validations
  if (!hasNft && !hasAmount) {
    throw new Error('Invalid token: No NFT or amount (empty prefix invalid per spec)');
  }
  if (hasCommitment && !hasNft) {
    throw new Error('Invalid token: Commitment without NFT (spec violation)');
  }
  if (hasNft && (capability < 0 || capability > 2)) {
    throw new Error('Invalid NFT capability (must be 0-2 per spec)');
  }
  if (!hasNft && capability !== 0) {
    throw new Error('Invalid: Capability set without NFT (must be 0 per spec)');
  }
  if (hasCommitment && (commitment.length < 1 || commitment.length > 40)) {
    throw new Error('Commitment must be 1-40 bytes per spec');
  }
  if (hasAmount && (token.amount < 1n || token.amount > 9223372036854775807n)) {
    throw new Error('Amount must be 1 to max VM number per spec');
  }

  // Build bitfield
  if (hasCommitment) bitfield |= 0x40;
  if (hasNft) bitfield |= 0x20;
  if (hasAmount) bitfield |= 0x10;
  bitfield |= capability & 0x0f;

  prefixParts.push(new Uint8Array([bitfield]));

  if (hasCommitment) {
    const commitLen = commitment.length;
    prefixParts.push(varInt(commitLen) as unknown as Uint8Array, commitment);
  }

  if (hasAmount) {
    prefixParts.push(varInt(Number(token.amount)) as unknown as Uint8Array);
  }

  const tokenPrefix = concat(...prefixParts);
  console.log('Token Prefix (hex):', bytesToHex(tokenPrefix));

  // 🔒 Concat only Uint8Arrays
  return concat(tokenPrefix, script);
}

/* ========================================================================== */
/* Helpers for normalizing satoshi values & scripts                           */
/* ========================================================================== */

function toNumberLE(u8) {
  if (!(u8 instanceof Uint8Array)) {
    throw new Error('toNumberLE: expected Uint8Array');
  }
  let acc = 0n;
  const n = Math.min(8, u8.length); // uint64
  for (let i = 0; i < n; i++) acc |= BigInt(u8[i]) << (8n * BigInt(i));
  return Number(acc);
}

export function normalizeSats(v) {
  if (typeof v === 'number') return v; // number
  if (typeof v === 'bigint') return Number(v); // bigint
  if (v instanceof Uint8Array) return toNumberLE(v); // LE bytes
  if (v && typeof v === 'object') {
    if ('value' in v) return normalizeSats(v.value);
  }
  throw new Error('normalizeSats: unsupported value type for satoshis');
}

function scriptToBytesLoose(s) {
  if (!s) throw new Error('scriptToBytesLoose: missing script');
  if (s instanceof Uint8Array) return s;
  if (typeof s === 'string') return hexToBytes(s);
  if (typeof s === 'object') {
    if (typeof s.hex === 'string') return hexToBytes(s.hex);
    if (s.scriptPubKey) return scriptToBytesLoose(s.scriptPubKey);
    if (s.lockingScript) return scriptToBytesLoose(s.lockingScript);
    if (s.pkScript) return scriptToBytesLoose(s.pkScript);
  }
  throw new Error('scriptToBytesLoose: unsupported script representation');
}

/* ========================================================================== */
/* VarInt reader & outputs blob helpers                                      */
/* ========================================================================== */

// Minimal varInt reader: returns { value, size } where size is bytes read
function readVarInt(u8, offset = 0) {
  const first = u8[offset];
  if (first < 0xfd) return { value: first, size: 1 };
  if (first === 0xfd) {
    const v = u8[offset + 1] | (u8[offset + 2] << 8);
    return { value: v, size: 3 };
  }
  if (first === 0xfe) {
    const v =
      u8[offset + 1] |
      (u8[offset + 2] << 8) |
      (u8[offset + 3] << 16) |
      (u8[offset + 4] << 24);
    return { value: v >>> 0, size: 5 };
  }
  // 0xff -> uint64le (we only need length; JS will safely hold up to 2^53-1)
  const lo =
    u8[offset + 1] |
    (u8[offset + 2] << 8) |
    (u8[offset + 3] << 16) |
    (u8[offset + 4] << 24);
  const hi =
    u8[offset + 5] |
    (u8[offset + 6] << 8) |
    (u8[offset + 7] << 16) |
    (u8[offset + 8] << 24);
  const v = hi * 2 ** 32 + (lo >>> 0);
  return { value: v, size: 9 };
}

// Count outputs in a pre-serialized outputs blob (concat of [value][len][script])
function countOutputsFromBlob(blob) {
  if (!(blob instanceof Uint8Array)) {
    throw new Error('countOutputsFromBlob: blob must be Uint8Array');
  }
  let off = 0;
  let count = 0;
  while (off < blob.length) {
    if (off + 8 > blob.length) throw new Error('countOutputsFromBlob: truncated at value');
    off += 8;
    if (off >= blob.length) throw new Error('countOutputsFromBlob: truncated at script length');
    const { value: scriptLen, size } = readVarInt(blob, off);
    off += size;
    if (off + scriptLen > blob.length)
      throw new Error('countOutputsFromBlob: truncated at script bytes');
    off += scriptLen;
    count++;
  }
  if (off !== blob.length) throw new Error('countOutputsFromBlob: leftover bytes after parse');
  return count;
}

/* ========================================================================== */
/* Outputs aggregator (for hashOutputs)                                       */
/* ========================================================================== */
/**
 * Accepts:
 *  - Array of outputs (objects or [value, script] tuples)
 *  - Pre-serialized Uint8Array of outputs (without a leading count)
 *  - { raw: Uint8Array } wrapper
 */
export function getAllOutputs(outputs: any): Uint8Array {
  // passthrough: already serialized (no count prefix)
  if (outputs instanceof Uint8Array) return outputs;

  // wrapper shape
  if (outputs && typeof outputs === 'object' && outputs.raw instanceof Uint8Array) {
    return outputs.raw;
  }

  if (!Array.isArray(outputs)) {
    throw new Error('getAllOutputs: unsupported outputs shape');
  }

  const resolveValueBigInt = (out: any): bigint => {
    // tuple form: [value, script]
    if (Array.isArray(out) && out.length === 2) {
      return normalizeSatsBigInt(out[0]);
    }

    // object form: { value | satoshis | amount | val, scriptPubKey? ... }
    if (out && typeof out === 'object') {
      const rawValue =
        'value' in out ? out.value
        : 'satoshis' in out ? out.satoshis
        : 'amount' in out ? out.amount
        : 'val' in out ? out.val
        : (() => { throw new Error('getAllOutputs: output value missing'); })();

      return normalizeSatsBigInt(rawValue);
    }

    throw new Error('getAllOutputs: unsupported output item type');
  };

  const resolveScript = (out: any): Uint8Array => {
    if (Array.isArray(out) && out.length === 2) return scriptToBytesLoose(out[1]);
    if (out && typeof out === 'object') return scriptToBytesLoose(out.scriptPubKey ?? out);
    throw new Error('getAllOutputs: unsupported output item type');
  };

  const parts: Uint8Array[] = [];
  for (const item of outputs) {
    const v = resolveValueBigInt(item);
    const spk = resolveScript(item);
    parts.push(uint64le(v), varInt(spk.length), spk);
  }

  return concat(...parts);
}

/* ========================================================================== */
/* Sighash preimage builder (BCH ForkID + CashTokens)                          */
/* ========================================================================== */
/**
 * Build BCH/ChipFork preimage for SIGHASH_ALL|FORKID with optional CashTokens
 * token prefix from the previous output.
 *
 * @param {*} tx
 * @param {number} inputIndex
 * @param {Uint8Array} scriptCode       Redeem script or scriptCode for this input
 * @param {number|bigint} value         Prevout value (sats)
 * @param {number} [sigHashType=0x41]   Default 0x41 (SIGHASH_ALL | FORKID)
 * @param {Uint8Array|null} [prevTokenPrefix] Raw 0xef... prefix if present (optional)
 */
export function getPreimage(
  tx: any,
  inputIndex: number,
  scriptCode: Uint8Array,
  value: number | bigint,
  sigHashType: number = 0x41,
  prevTokenPrefix?: Uint8Array | null
): Uint8Array {
  const parts: Uint8Array[] = [];
  const normValue = normalizeSats(value);

  // nVersion
  parts.push(uint32le(tx.version));

  // hashPrevouts
  parts.push(sha256(sha256(getAllPrevOut(tx.inputs))));

  // hashSequence
  parts.push(sha256(sha256(getAllSequences(tx.inputs))));

  // outpoint
  parts.push(getOutpoint(tx.inputs[inputIndex]));

  // previous output token contents (if present)
  if (prevTokenPrefix && prevTokenPrefix.length > 0) {
    parts.push(prevTokenPrefix);
  }

  // scriptCode
  parts.push(varInt(scriptCode.length), scriptCode);

  // prevout value
  parts.push(uint64le(normValue));

  // sequence
  parts.push(uint32le(tx.inputs[inputIndex].sequence));

  // hashOutputs
  parts.push(sha256(sha256(getAllOutputs(tx.outputs))));

  // nLockTime
  parts.push(uint32le(tx.locktime));

  // sighash type (LE)
  parts.push(uint32le(sigHashType));

  return concat(...parts);
}

/* ========================================================================== */
/* Schnorr input signers                                                      */
/* ========================================================================== */

/**
 * Sign a standard P2PKH input with BCH Schnorr (65B sig incl. hashtype + 33B pub).
 */
export function signInput(tx, inputIndex, privBytes, scriptPubKey, value) {
  if (!(privBytes instanceof Uint8Array)) throw new Error('privBytes must be Uint8Array');
  if (!(scriptPubKey instanceof Uint8Array)) throw new Error('scriptPubKey must be Uint8Array');

  const pubCompressed = secp256k1.getPublicKey(privBytes, true);

  // Preimage
  const preimage = concat(
    uint32le(tx.version),
    sha256(sha256(getAllPrevOut(tx.inputs))),
    sha256(sha256(getAllSequences(tx.inputs))),
    getOutpoint(tx.inputs[inputIndex]),
    varInt(scriptPubKey.length),
    scriptPubKey,
    uint64le(normalizeSats(value)),
    uint32le(tx.inputs[inputIndex].sequence),
    sha256(sha256(getAllOutputs(tx.outputs))),
    uint32le(tx.locktime),
    uint32le(0x41) // SIGHASH_ALL|FORKID
  );
  const sighash = sha256(sha256(preimage));

  // Sign
  const sig64 = bchSchnorrSign(sighash, privBytes, pubCompressed);
  const sig65 = concat(sig64, new Uint8Array([0x41]));

  // Verify
  if (!bchSchnorrVerify(sig65, sighash, pubCompressed)) {
    console.error('Preimage hex:', bytesToHex(preimage));
    console.error('Sighash  hex:', bytesToHex(sighash));
    throw new Error('Schnorr verification failed');
  }

  // scriptSig = <sig65> <pub33>
  const scriptSig = concat(
    pushDataPrefix(sig65.length),
    sig65,
    pushDataPrefix(pubCompressed.length),
    pubCompressed
  );
  tx.inputs[inputIndex].scriptSig = scriptSig;
  return tx;
}

/**
 * Sign a P2SH input (non-covenant). If prevout had a CashTokens prefix,
 * include it in the preimage via the dedicated parameter (do NOT merge it into scriptCode).
 */
export function signP2SHInput(tx, inputIndex, privBytes, redeemScript, value, rawPrevScript) {
  if (!(privBytes instanceof Uint8Array)) throw new Error('privBytes must be Uint8Array');
  if (!(redeemScript instanceof Uint8Array)) throw new Error('redeemScript must be Uint8Array');
  if (!(rawPrevScript instanceof Uint8Array)) throw new Error('rawPrevScript must be Uint8Array');

  const pubCompressed = secp256k1.getPublicKey(privBytes, true);
  const { prefix: prevTokenPrefix } = splitTokenPrefix(rawPrevScript);
  const scriptCode = redeemScript;

  const preimage = getPreimage(tx, inputIndex, scriptCode, value, 0x41, prevTokenPrefix);
  const sighash = sha256(sha256(preimage));

  const sig64 = bchSchnorrSign(sighash, privBytes, pubCompressed);
  const sig65 = concat(sig64, new Uint8Array([0x41]));

  if (!bchSchnorrVerify(sig65, sighash, pubCompressed)) {
    console.error('Preimage hex:', bytesToHex(preimage));
    console.error('Sighash  hex:', bytesToHex(sighash));
    console.error('tokenPrefix len:', prevTokenPrefix ? prevTokenPrefix.length : 0);
    throw new Error('Schnorr verification failed');
  }

  // scriptSig = <sig65> <pub33> <redeemScript>
  const scriptSig = concat(
    pushDataPrefix(sig65.length),
    sig65,
    pushDataPrefix(pubCompressed.length),
    pubCompressed,
    pushDataPrefix(redeemScript.length),
    redeemScript
  );
  tx.inputs[inputIndex].scriptSig = scriptSig;
  return tx;
}

/**
 * Sign covenant input:
 * New unlocking stack (top is rightmost):
 *   [ amountCommitment(minimal-int) ][ pubkey33 ][ sig65 ][ redeemScript ]
 *
 * Coverage: BCH HF-20230515 preimage including prevTokenPrefix (if present).
 */
export function signCovenantInput(
  tx,
  inputIndex,
  privBytes,        // 32-byte Uint8Array
  redeemScript,     // Uint8Array
  value,            // prevout satoshis (number|bigint)
  rawPrevScript,    // full prevout scriptPubKey (may include CashTokens prefix)
  amount,           // bigint | number
  hashtype = 0x41   // SIGHASH_ALL | FORKID
) {
  // --- Defensive type checks (keep them!) ---
  if (!(privBytes instanceof Uint8Array) || privBytes.length !== 32) {
    throw new Error('privBytes must be 32-byte Uint8Array');
  }
  if (!(redeemScript instanceof Uint8Array)) {
    throw new Error('redeemScript must be Uint8Array');
  }
  if (!(rawPrevScript instanceof Uint8Array)) {
    throw new Error('rawPrevScript must be Uint8Array');
  }
  if (typeof amount !== 'number' && typeof amount !== 'bigint') {
    throw new Error('amount must be number or bigint');
  }

  // --- Keys & scriptCode ---
  const pub33 = secp256k1.getPublicKey(privBytes, true);
  const { prefix: prevTokenPrefix } = splitTokenPrefix(rawPrevScript);
  const scriptCode = redeemScript;

  // --- Build preimage per BCH + CashTokens ---
  const preimage = getPreimage(tx, inputIndex, scriptCode, value, hashtype, prevTokenPrefix);
  const sighash = sha256(sha256(preimage));

  // --- Sign & verify (keeps your nice debug paths) ---
  const sig64 = bchSchnorrSign(sighash, privBytes, pub33);
  const sig65 = concat(sig64, Uint8Array.of(hashtype));

  if (!bchSchnorrVerify(sig65, sighash, pub33)) {
    console.error('COVENANT verify failed');
    console.error('preimage (hex):', bytesToHex(preimage));
    console.error('sighash  (hex):', bytesToHex(sighash));
    console.error('tokenPrefix len:', prevTokenPrefix ? prevTokenPrefix.length : 0);
    throw new Error('Schnorr verification failed');
  }

  // --- Assemble unlocking script (NO envelope) ---
  const pushBytes = (b) => concat(pushDataPrefix(b.length), b);
  const amountBytes = minimalScriptNumber(
    typeof amount === 'bigint' ? amount : BigInt(amount)
  );

  const unlocking = concat(
    pushBytes(amountBytes),          // <amountCommitment>   (minimal-int)
    pushBytes(pub33),                // <pubkey33>
    pushBytes(sig65),                // <sig65>
    pushBytes(redeemScript)          // <redeemScript> (P2SH requires last push)
  );

  tx.inputs[inputIndex].scriptSig = unlocking;

  // Optional debug
  console.log('COVENANT preimage (hex):', bytesToHex(preimage));
  console.log('COVENANT sighash  (hex):', bytesToHex(sighash));
  console.log('COVENANT sig65    (hex):', bytesToHex(sig65));

  return tx;
}

function normalizeSatsBigInt(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (v instanceof Uint8Array) return BigInt(toNumberLE(v));
  if (v && typeof v === 'object' && 'value' in v) return normalizeSatsBigInt(v.value);
  throw new Error('normalizeSatsBigInt: unsupported value type for satoshis');
}

export function buildRawTxBytes(tx: any, opts: any = {}) {
  const inputsArr = tx.inputs ?? [];

  // ---- inputs ----
  const inputs = inputsArr.map((inp) => {
    const scriptSig =
      inp.scriptSig instanceof Uint8Array
        ? inp.scriptSig
        : typeof inp.scriptSig === 'string'
        ? hexToBytes(inp.scriptSig.startsWith('0x') ? inp.scriptSig.slice(2) : inp.scriptSig)
        : new Uint8Array();

    return concat(
      hexToBytes(inp.txid).reverse(),
      uint32le(inp.vout ?? 0),
      varInt(scriptSig.length),
      scriptSig,
      uint32le(inp.sequence ?? 0xffffffff)
    );
  });

  // ---- outputs ----
  let outputsBytes;
  let outputsCount;

  if (tx.outputs instanceof Uint8Array) {
    const blob = tx.outputs;
    outputsCount = tx.outputsCount ?? tx.outputs_count ?? tx.nOutputs ?? tx.count;

    if (typeof outputsCount === 'number') {
      outputsBytes = blob;
    } else {
      // Try: [count][outputs...]
      try {
        const { value: n, size } = readVarInt(blob, 0);
        const rest = blob.subarray(size);
        const counted = countOutputsFromBlob(rest);
        if (counted !== n) throw new Error('mismatch');
        outputsCount = n;
        outputsBytes = rest;
      } catch {
        // Try: [outputs...]
        try {
          const counted = countOutputsFromBlob(blob);
          outputsCount = counted;
          outputsBytes = blob;
        } catch {
          // Legacy fallback behavior: don’t hard-fail
          console.warn('buildRawTxBytes: could not infer outputs count; assuming 1');
          outputsCount = 1;
          outputsBytes = blob;
        }
      }
    }
  } else {
    const outArr = Array.isArray(tx.outputs) ? tx.outputs : tx.outputs ? [tx.outputs] : [];
    outputsCount = outArr.length;

    const outsSerialized = outArr.map((outItem) => {
      let v, spk;

      if (Array.isArray(outItem) && outItem.length === 2) {
        v = normalizeSatsBigInt(outItem[0]);
        spk = scriptToBytesLoose(outItem[1]);
      } else if (outItem && typeof outItem === 'object') {
        const rawValue =
          'value' in outItem ? outItem.value
          : 'satoshis' in outItem ? outItem.satoshis
          : 'amount' in outItem ? outItem.amount
          : 'val' in outItem ? outItem.val
          : (() => { throw new Error('buildRawTxBytes: output.value missing'); })();

        v = normalizeSatsBigInt(rawValue);
        spk = scriptToBytesLoose(outItem.scriptPubKey ?? outItem);
      } else {
        throw new Error('buildRawTxBytes: unsupported output item type');
      }

      return concat(uint64le(v), varInt(spk.length), spk);
    });

    outputsBytes = concat(...outsSerialized);
  }

  return concat(
    uint32le(tx.version ?? 1),
    varInt(inputsArr.length),
    ...inputs,
    varInt(outputsCount),
    outputsBytes,
    uint32le(tx.locktime ?? 0)
  );
}

/**
 * Legacy: return hex string (preserved)
 * Optional: buildRawTx(tx, { format: 'bytes' }) returns Uint8Array
 */
export function buildRawTx(tx, opts) {
  const format = opts?.format ?? 'hex';
  const bytes = buildRawTxBytes(tx);
  return format === 'bytes' ? bytes : bytesToHex(bytes);
}

/** Rough size estimate; Schnorr P2PKH ≈ 140B per input, ~34B per output, header ~10B */
export function estimateTxSize(numInputs, numOutputs) {
  return 10 + numInputs * 140 + numOutputs * 34;
}

function cloneTokenNoMutation(token) {
  if (token == null) return null;
  const category = normalizeCategory32(token.category);
  const amount = token.amount == null ? 0n : BigInt(token.amount);
  const nft = token.nft
    ? {
        capability: token.nft.capability,
        commitment:
          token.nft.commitment == null
            ? new Uint8Array()
            : (token.nft.commitment instanceof Uint8Array
                ? token.nft.commitment
                : hexToBytes(token.nft.commitment)),
      }
    : undefined;
  // IMPORTANT: return a new object so downstream encoding can't mutate caller-owned objects.
  return { category, amount, nft };
}