// src/derivation.ts (new RPA-aligned helpers)

/**
 * RPA derivation + session key helpers (Phase 1).
 *
 * This module implements:
 *   - Static/RPA paycode shared-secret derivation (inspired by EC's outpoint-based scheme)
 *   - One-time address derivation for sender/receiver (RPA)
 *   - RPA "lock intent" objects used as a front-end to:
 *       • confidential assets (covenants + ZK proofs + NFTs),
 *       • stealth P2PKH,
 *       • future PQ vault scripts.
 *
 * High-level:
 *   - Wallets expose a stable paycode (scan + spend keys in the full design).
 *   - Each payment derives a unique one-time child key from:
 *       • sender key material,
 *       • receiver paycode pubkey(s),
 *       • an on-chain outpoint (txid:vout),
 *       • a derivation index.
 *   - The chain only sees the child pubkey / hash160; paycodes never appear on-chain.
 *
 * Phase-1 notes:
 *   - For the demo, scan/spend are folded together; production should keep them distinct.
 *   - deriveRpaLockIntent is the unified entry point used by all higher-level flows:
 *       • conf-asset: covenant-guarded confidential transfers,
 *       • stealth-p2pkh: simple stealth sends without a covenant,
 *       • pq-vault: future Quantumroot-style vault scripts.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import aesjs from 'aes-js';

import {
  sha256,
  concat,
  bytesToHex,
  hexToBytes,
  bytesToBigInt,
  bigIntToBytes,
  hash160,
} from '@bch-stealth/utils';

// Curve order
function curveOrder(): bigint {
  // noble-curves v2: curve params are exposed via Point.CURVE()
  return secp256k1.Point.CURVE().n;
}

// Big-endian uint32
function uint32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

// HMAC-SHA512 using @noble/hashes (portable: Electron, web, extensions)
function hmacSHA512(keyBytes: Uint8Array, dataBytes: Uint8Array): Uint8Array {
  return hmac(sha512, keyBytes, dataBytes);
}

function randomBytesCompat(n: number): Uint8Array {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('Secure randomness unavailable (crypto.getRandomValues missing).');
  }
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}

// Modes of use for RPA in this repo:
// - 'confidential-asset' : covenant + ZK range proof + NFT
// - 'stealth-p2pkh'      : simple stealth P2PKH without covenant
// - 'pq-vault'           : front door for a post-quantum vault (Quantumroot-style)
export const RPA_MODE_CONF_ASSET = 'confidential-asset' as const;
export const RPA_MODE_STEALTH_P2PKH = 'stealth-p2pkh' as const;
export const RPA_MODE_PQ_VAULT = 'pq-vault' as const;

export type RpaMode =
  | typeof RPA_MODE_CONF_ASSET
  | typeof RPA_MODE_STEALTH_P2PKH
  | typeof RPA_MODE_PQ_VAULT;

/**
 * RPA derivation metadata — PSBT-friendly (Phase-1 helper).
 *
 * This small context object is what you would embed in a PSBT extension
 * instead of embedding any random "ephemeral" keys. A signer with the
 * correct seed can re-derive all child keys from:
 *   - paycode scan/spend secrets,
 *   - this context (sender pub, outpoint, index, mode),
 *   - and the blockchain.
 */
export type RpaContext = {
  paycodeId: string | null;
  senderPub33: Uint8Array; // 33 bytes
  prevoutTxidHex: string;  // 64 hex chars
  prevoutN: number;
  index: number;
  mode: RpaMode;
};

export type DeriveRpaLockIntentParams = {
  paycodeId?: string | null;
  mode: RpaMode;
  senderPrivBytes: Uint8Array; // 32 bytes
  receiverPub33: Uint8Array;   // 33 bytes
  prevoutTxidHex: string;      // 64 hex
  prevoutN: number;
  index?: number;
  extraCtx?: Uint8Array;
};

export type RpaSessionKeys = {
  sessionKey: Uint8Array; // 32
  amountKey: Uint8Array;  // 16
  memoKey: Uint8Array;    // 16
  zkSeed: Uint8Array;     // 32
};

export type RpaLockIntent = {
  mode: RpaMode;
  address: string | null;
  childPubkey: Uint8Array;   // 33
  childHash160: Uint8Array;  // 20
  sharedSecret: Uint8Array;  // 32
  session: Omit<RpaSessionKeys, 'sessionKey'>;
  extraCtx: Uint8Array;
  context: RpaContext;
};

function assertMode(mode: unknown): asserts mode is RpaMode {
  if (
    mode !== RPA_MODE_CONF_ASSET &&
    mode !== RPA_MODE_STEALTH_P2PKH &&
    mode !== RPA_MODE_PQ_VAULT
  ) {
    throw new Error('Invalid RPA mode');
  }
}

/**
 * Build and validate an RPA context object.
 *
 * Note: This function is intentionally strict because the context is designed
 * to be persisted (e.g. PSBT extension) and re-used for deterministic re-derivation.
 */
export function buildRpaContext(args: RpaContext): RpaContext {
  const { paycodeId, senderPub33, prevoutTxidHex, prevoutN, index, mode } = args;

  assertMode(mode);

  if (!(senderPub33 instanceof Uint8Array) || senderPub33.length !== 33) {
    throw new Error('buildRpaContext: senderPub33 must be 33-byte compressed pubkey');
  }
  if (typeof prevoutTxidHex !== 'string' || prevoutTxidHex.length !== 64) {
    throw new Error('buildRpaContext: prevoutTxidHex must be 32-byte txid hex (64 chars)');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(prevoutTxidHex)) {
    throw new Error('buildRpaContext: prevoutTxidHex must be hex');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('buildRpaContext: prevoutN must be a non-negative integer');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('buildRpaContext: index must be a non-negative integer');
  }

  return {
    paycodeId: paycodeId ?? null,
    senderPub33,
    prevoutTxidHex,
    prevoutN,
    index,
    mode,
  };
}

/**
 * Derive an RPA "lock intent" from the sender's key + receiver paycode + outpoint.
 *
 * This is deliberately generic so it can front:
 *   - confidential assets (current Phase-1 covenant)
 *   - simple stealth P2PKH (future, no covenant)
 *   - PQ vaults (future Quantumroot scripts)
 */
export function deriveRpaLockIntent(params: DeriveRpaLockIntentParams): RpaLockIntent {
  const {
    mode,
    senderPrivBytes,
    receiverPub33,
    prevoutTxidHex,
    prevoutN,
    index = 0,
    extraCtx = new Uint8Array(0),
    paycodeId = null,
  } = params;

  assertMode(mode);

  if (!(senderPrivBytes instanceof Uint8Array) || senderPrivBytes.length !== 32) {
    throw new Error('deriveRpaLockIntent: senderPrivBytes must be 32-byte Uint8Array');
  }
  if (!(receiverPub33 instanceof Uint8Array) || receiverPub33.length !== 33) {
    throw new Error('deriveRpaLockIntent: receiverPub33 must be 33-byte compressed pubkey');
  }
  if (
    typeof prevoutTxidHex !== 'string' ||
    prevoutTxidHex.length !== 64 ||
    !/^[0-9a-fA-F]{64}$/.test(prevoutTxidHex)
  ) {
    throw new Error('deriveRpaLockIntent: prevoutTxidHex must be 32-byte txid hex (64 chars)');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('deriveRpaLockIntent: prevoutN must be a non-negative integer');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('deriveRpaLockIntent: index must be a non-negative integer');
  }
  if (!(extraCtx instanceof Uint8Array)) {
    throw new Error('deriveRpaLockIntent: extraCtx must be Uint8Array');
  }

  // Sender pubkey P for the RPA context (derived from senderPrivBytes).
  const senderPub33 = secp256k1.getPublicKey(senderPrivBytes, true);

  // Demo: scan/spend folded together, so receiverPub33 plays both roles.
  const { address, childPubkey, childHash160, sharedSecret } = deriveRpaOneTimeAddressSender(
    senderPrivBytes,
    receiverPub33, // scan Q
    receiverPub33, // spend R
    prevoutTxidHex,
    prevoutN,
    index
  );

  const { amountKey, memoKey, zkSeed } = deriveRpaSessionKeys(sharedSecret, prevoutTxidHex, prevoutN);

  const context = buildRpaContext({
    paycodeId,
    senderPub33,
    prevoutTxidHex,
    prevoutN,
    index,
    mode,
  });

  return {
    mode,
    address, // intentionally null until address encoding lives in UI/wallet layer
    childPubkey,
    childHash160,
    sharedSecret,
    session: { amountKey, memoKey, zkSeed },
    extraCtx,
    context,
  };
}

/**
 * JS port of EC's _calculate_paycode_shared_secret:
 *
 * private_key : Uint8Array(32)  (scalar e)
 * public_key  : Uint8Array(33)  (compressed Q)
 * outpointStr : string          (prevout_hash + prevout_n, as EC does)
 *
 * Returns Uint8Array(32) "shared_secret".
 */
export function calculatePaycodeSharedSecret(
  privateKeyBytes: Uint8Array,
  publicKey33: Uint8Array,
  outpointStr: string
): Uint8Array {
  if (!(privateKeyBytes instanceof Uint8Array) || privateKeyBytes.length !== 32) {
    throw new Error('privateKeyBytes must be 32-byte Uint8Array');
  }
  if (!(publicKey33 instanceof Uint8Array) || publicKey33.length !== 33) {
    throw new Error('publicKey33 must be 33-byte compressed pubkey');
  }
  if (typeof outpointStr !== 'string' || outpointStr.length === 0) {
    throw new Error('outpointStr must be a non-empty string');
  }

  const privBig = bytesToBigInt(privateKeyBytes);
  const pubPoint = secp256k1.Point.fromHex(bytesToHex(publicKey33));

  // ECDH: e * Q
  const product = pubPoint.multiply(privBig);
  const { x: xBig } = product.toAffine(); // v2-friendly, explicit affine coords

  // Convert x to 33-byte big-endian (EC does to_bytes(33))
  const xHex = xBig.toString(16).padStart(64, '0'); // 32 bytes
  const xHex33 = xHex.padStart(66, '0');            // 33 bytes
  const xBytes33 = hexToBytes(xHex33);

  const shaX = sha256(xBytes33);
  const shaXBig = bytesToBigInt(shaX);

  // Hash of outpoint string (EC hashes the string)
  const outBytes = new TextEncoder().encode(outpointStr);
  const outHash = sha256(outBytes);
  const outBig = bytesToBigInt(outHash);

  const grand = shaXBig + outBig;
  const grandHex = grand.toString(16);
  const grandHexEven = grandHex.length % 2 ? '0' + grandHex : grandHex;
  const grandBytes = hexToBytes(grandHexEven);

  return sha256(grandBytes); // 32-byte shared_secret
}

/**
 * Minimal BIP32 CKDpub: non-hardened child with chainCode = secret (32 bytes).
 *
 * parentPub33 : Uint8Array(33) parent public key (compressed).
 * chainCode   : Uint8Array(32) shared_secret from RPA.
 * index       : number  (usually 0 for our use).
 *
 * Returns Uint8Array(33) child pubkey.
 */
export function ckdPubFromSecret(
  parentPub33: Uint8Array,
  chainCode: Uint8Array,
  index = 0
): Uint8Array {
  if (!(parentPub33 instanceof Uint8Array) || parentPub33.length !== 33) {
    throw new Error('parentPub33 must be 33-byte compressed pubkey');
  }
  if (!(chainCode instanceof Uint8Array) || chainCode.length !== 32) {
    throw new Error('chainCode must be 32-byte Uint8Array');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index must be a non-negative integer');
  }

  // BIP32 CKDpub (non-hardened):
  // I = HMAC-SHA512(key=chainCode, data=serP(parentPub) || ser32(index))
  // childPub = (IL * G) + parentPub
  const data = concat(parentPub33, uint32be(index));
  const I = hmacSHA512(chainCode, data);
  const IL = I.slice(0, 32);
  // const IR = I.slice(32); // If later you want a child chain code

  const ilBig = bytesToBigInt(IL) % curveOrder();
  if (ilBig === 0n) throw new Error('Invalid derived IL (zero) in ckdPub');

  const parentPoint = secp256k1.Point.fromHex(bytesToHex(parentPub33));
  const childPoint = secp256k1.Point.BASE.multiply(ilBig).add(parentPoint);

  return childPoint.toBytes(true); // compressed 33-byte
}

/**
 * Minimal BIP32 CKDpriv: non-hardened child with chainCode = secret (32 bytes).
 */
export function ckdPrivFromSecret(
  parentPriv: Uint8Array,
  chainCode: Uint8Array,
  index = 0
): Uint8Array {
  if (!(parentPriv instanceof Uint8Array) || parentPriv.length !== 32) {
    throw new Error('parentPriv must be 32-byte Uint8Array');
  }
  if (!(chainCode instanceof Uint8Array) || chainCode.length !== 32) {
    throw new Error('chainCode must be 32-byte Uint8Array');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index must be a non-negative integer');
  }

  const parentPub33 = secp256k1.getPublicKey(parentPriv, true);
  const data = concat(parentPub33, uint32be(index));
  const I = hmacSHA512(chainCode, data);
  const IL = I.slice(0, 32);
  // const IR = I.slice(32); // If later you want a child chain code

  const ilBig = bytesToBigInt(IL) % curveOrder();
  const kparBig = bytesToBigInt(parentPriv) % curveOrder();
  const childPrivBig = (ilBig + kparBig) % curveOrder();

  if (childPrivBig === 0n) throw new Error('Invalid derived private key (zero) in ckdPriv');

  return bigIntToBytes(childPrivBig, 32);
}

/**
 * Sender-side: derive one-time P2PKH address from:
 *  - sender input priv (e),
 *  - receiver scan/spend pubkeys (Q,R),
 *  - outpoint (prevout_hash, prevout_n),
 *  - index (usually 0).
 *
 * Returns { address, childPubkey, childHash160, sharedSecret }.
 */
export function deriveRpaOneTimeAddressSender(
  senderPrivBytes: Uint8Array,
  scanPub33: Uint8Array,
  spendPub33: Uint8Array,
  prevoutHashHex: string,
  prevoutN: number,
  index = 0
): { address: string | null; childPubkey: Uint8Array; childHash160: Uint8Array; sharedSecret: Uint8Array } {
  if (!(senderPrivBytes instanceof Uint8Array) || senderPrivBytes.length !== 32) {
    throw new Error('senderPrivBytes must be 32-byte Uint8Array');
  }
  if (!(scanPub33 instanceof Uint8Array) || scanPub33.length !== 33) {
    throw new Error('scanPub33 must be 33-byte compressed pubkey');
  }
  if (!(spendPub33 instanceof Uint8Array) || spendPub33.length !== 33) {
    throw new Error('spendPub33 must be 33-byte compressed pubkey');
  }
  if (typeof prevoutHashHex !== 'string' || prevoutHashHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(prevoutHashHex)) {
    throw new Error('prevoutHashHex must be 32-byte txid hex (64 chars)');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('prevoutN must be a non-negative integer');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index must be a non-negative integer');
  }

  const outpointStr = `${prevoutHashHex}${String(prevoutN)}`;
  const sharedSecret = calculatePaycodeSharedSecret(senderPrivBytes, scanPub33, outpointStr);

  const childPubkey = ckdPubFromSecret(spendPub33, sharedSecret, index);
  const childHash160 = hash160(childPubkey);

  // Address encoding is intentionally left to callers (UI or wallet layer).
  const address: string | null = null;

  return { address, childPubkey, childHash160, sharedSecret };
}

/**
 * Receiver-side: derive matching one-time private key from:
 *  - scanPriv (d),
 *  - spendPriv (f),
 *  - senderPub33 (P from scriptsig),
 *  - outpoint,
 *  - index (0).
 *
 * Returns { oneTimePriv, sharedSecret }.
 */
export function deriveRpaOneTimePrivReceiver(
  scanPrivBytes: Uint8Array,
  spendPrivBytes: Uint8Array,
  senderPub33: Uint8Array,
  prevoutHashHex: string,
  prevoutN: number,
  index = 0
): { oneTimePriv: Uint8Array; sharedSecret: Uint8Array } {
  if (!(scanPrivBytes instanceof Uint8Array) || scanPrivBytes.length !== 32) {
    throw new Error('scanPrivBytes must be 32-byte Uint8Array');
  }
  if (!(spendPrivBytes instanceof Uint8Array) || spendPrivBytes.length !== 32) {
    throw new Error('spendPrivBytes must be 32-byte Uint8Array');
  }
  if (!(senderPub33 instanceof Uint8Array) || senderPub33.length !== 33) {
    throw new Error('senderPub33 must be 33-byte compressed pubkey');
  }
  if (typeof prevoutHashHex !== 'string' || prevoutHashHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(prevoutHashHex)) {
    throw new Error('prevoutHashHex must be 32-byte txid hex (64 chars)');
  }
  if (!Number.isInteger(prevoutN) || prevoutN < 0) {
    throw new Error('prevoutN must be a non-negative integer');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('index must be a non-negative integer');
  }

  const outpointStr = `${prevoutHashHex}${String(prevoutN)}`;
  const sharedSecret = calculatePaycodeSharedSecret(scanPrivBytes, senderPub33, outpointStr);
  const oneTimePriv = ckdPrivFromSecret(spendPrivBytes, sharedSecret, index);
  return { oneTimePriv, sharedSecret };
}

/**
 * Derive a per-payment session key schedule from sharedSecret.
 */
export function deriveRpaSessionKeys(
  sharedSecret: Uint8Array,
  txidHex = '',
  vout = 0
): RpaSessionKeys {
  if (!(sharedSecret instanceof Uint8Array) || sharedSecret.length !== 32) {
    throw new Error('sharedSecret must be 32-byte Uint8Array');
  }
  if (typeof txidHex !== 'string') {
    throw new Error('txidHex must be a string');
  }
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error('vout must be a non-negative integer');
  }

  const ctx = new TextEncoder().encode(`${txidHex}:${vout}`);
  const base = sha256(concat(sharedSecret, ctx)); // session_key

  const amountKey = sha256(concat(base, new TextEncoder().encode('amount'))).slice(0, 16);
  const memoKey   = sha256(concat(base, new TextEncoder().encode('memo'))).slice(0, 16);
  const zkSeed    = sha256(concat(base, new TextEncoder().encode('zk-seed')));

  return { sessionKey: base, amountKey, memoKey, zkSeed };
}

// ------------ Legacy ephem-based helpers (Phase 1 demo) ------------

export function encryptAmount(
  ephemPrivBytes: Uint8Array,
  receiverPubBytes: Uint8Array,
  amount: number
): Uint8Array {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('Amount must be positive number');
  }
  if (!(ephemPrivBytes instanceof Uint8Array) || ephemPrivBytes.length !== 32) {
    throw new Error('ephemPrivBytes must be 32-byte Uint8Array');
  }
  if (
    !(receiverPubBytes instanceof Uint8Array) ||
    (receiverPubBytes.length !== 33 && receiverPubBytes.length !== 32)
  ) {
    throw new Error('receiverPubBytes must be 32 or 33-byte Uint8Array');
  }

  const sharedSecret = secp256k1.getSharedSecret(ephemPrivBytes, receiverPubBytes);
  const aesKey = sha256(sharedSecret).slice(0, 16);
  const iv = randomBytesCompat(16);

  const amountData = `{"v":${amount}}`;
  const aesCtr = new aesjs.ModeOfOperation.ctr(aesKey, new aesjs.Counter(iv));
  const ciphertext = aesCtr.encrypt(new TextEncoder().encode(amountData));

  return concat(iv, ciphertext);
}

export function decryptAmount(
  privBytes: Uint8Array,
  senderEphemPubBytes: Uint8Array,
  encryptedAmount: Uint8Array
): string {
  if (!(privBytes instanceof Uint8Array) || privBytes.length !== 32) {
    throw new Error('privBytes must be 32-byte Uint8Array');
  }
  if (
    !(senderEphemPubBytes instanceof Uint8Array) ||
    (senderEphemPubBytes.length !== 33 && senderEphemPubBytes.length !== 32)
  ) {
    throw new Error('senderEphemPubBytes must be 32 or 33-byte Uint8Array');
  }
  if (!(encryptedAmount instanceof Uint8Array) || encryptedAmount.length < 16) {
    throw new Error('encryptedAmount must be Uint8Array >= 16 bytes');
  }

  const sharedSecret = secp256k1.getSharedSecret(privBytes, senderEphemPubBytes);
  const aesKey = sha256(sharedSecret).slice(0, 16);

  const iv = encryptedAmount.slice(0, 16);
  const ciphertext = encryptedAmount.slice(16);

  const aesCtr = new aesjs.ModeOfOperation.ctr(aesKey, new aesjs.Counter(iv));
  const decryptedBytes = aesCtr.decrypt(ciphertext);

  // Legacy demo helper: return JSON string, caller can parse.
  const decryptedStr = new TextDecoder().decode(decryptedBytes);
  return decryptedStr;
}