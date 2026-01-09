// src/derivation.js (new RPA-aligned helpers)

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
import {
  sha256,
  _hash160,
  concat,
  bytesToHex,
  hexToBytes,
  bytesToBigInt,
  bigIntToBytes,
} from '@bch/utils';
import aesjs from 'aes-js';
import { randomBytes, createHmac } from 'crypto';

// Curve order
function curveOrder() {
  // noble-curves v2: curve params are exposed via Point.CURVE()
  return secp256k1.Point.CURVE().n;
}

// Big-endian uint32
function uint32be(n) {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

// HMAC-SHA512 using Node crypto
function hmacSHA512(keyBytes, dataBytes) {
  const h = createHmac('sha512', Buffer.from(keyBytes));
  h.update(Buffer.from(dataBytes));
  return new Uint8Array(h.digest());
}

// Modes of use for RPA in this repo:
// - 'confidential-asset' : covenant + ZK range proof + NFT
// - 'stealth-p2pkh'      : simple stealth P2PKH without covenant
// - 'pq-vault'           : front door for a post-quantum vault (Quantumroot-style)
export const RPA_MODE_CONF_ASSET = 'confidential-asset';
export const RPA_MODE_STEALTH_P2PKH = 'stealth-p2pkh';
export const RPA_MODE_PQ_VAULT = 'pq-vault';

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
export function buildRpaContext({
  paycodeId = null,
  senderPub33,
  prevoutTxidHex,
  prevoutN,
  index,
  mode,
}) {
  if (!(senderPub33 instanceof Uint8Array) || senderPub33.length !== 33) {
    throw new Error('buildRpaContext: senderPub33 must be 33-byte compressed pubkey');
  }
  if (typeof prevoutTxidHex !== 'string' || prevoutTxidHex.length !== 64) {
    throw new Error('buildRpaContext: prevoutTxidHex must be 32-byte txid hex');
  }

  return {
    paycodeId,
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
 *
 * @param {{
 *   mode: 'confidential-asset'|'stealth-p2pkh'|'pq-vault',
 *   senderPrivBytes: Uint8Array,      // sender secret scalar e
 *   receiverPub33: Uint8Array,       // 33-byte pub from paycode (scan/spend folded for demo)
 *   prevoutTxidHex: string,          // BE hex txid of RPA context input
 *   prevoutN: number,                // vout of RPA context input
 *   index?: number,                  // derivation index for multiple outputs
 *   extraCtx?: Uint8Array            // optional extra domain separation for PQ/asset IDs
 * }} params
 */
export function deriveRpaLockIntent(params) {
  const {
    mode,
    senderPrivBytes,
    receiverPub33,
    prevoutTxidHex,
    prevoutN,
    index = 0,
    extraCtx = new Uint8Array(0),
  } = params;

  // Sender pubkey P for the RPA context (derived from senderPrivBytes).
  const senderPub33 = secp256k1.getPublicKey(senderPrivBytes, true);

  const {
    address,
    childPubkey,
    childHash160,
    sharedSecret,
  } = deriveRpaOneTimeAddressSender(
    senderPrivBytes,
    receiverPub33, // scan Q (demo: paycode pub used as both scan & spend)
    receiverPub33, // spend R
    prevoutTxidHex,
    prevoutN,
    index,
  );

  const { amountKey, memoKey, zkSeed } = deriveRpaSessionKeys(
    sharedSecret,
    prevoutTxidHex,
    prevoutN,
  );

  const context = buildRpaContext({
    paycodeId: params.paycodeId ?? null,
    senderPub33,
    prevoutTxidHex,
    prevoutN,
    index,
    mode,
  });

  return {
    mode,
    address,        // P2PKH address for this output (stealth)
    childPubkey,    // 33-byte one-time pubkey
    childHash160,   // 20-byte hash160(one-time pubkey)
    sharedSecret,   // raw shared secret from ECDH
    session: {
      amountKey,
      memoKey,
      zkSeed,       // used now for sigma range proofs, later for PQ vault nonce seeds
    },
    extraCtx,
    context,        // RPA context object (PSBT-ready)
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
export function calculatePaycodeSharedSecret(privateKeyBytes, publicKey33, outpointStr) {
  if (!(privateKeyBytes instanceof Uint8Array) || privateKeyBytes.length !== 32) {
    throw new Error('privateKeyBytes must be 32-byte Uint8Array');
  }
  if (!(publicKey33 instanceof Uint8Array) || publicKey33.length !== 33) {
    throw new Error('publicKey33 must be 33-byte compressed pubkey');
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
export function ckdPubFromSecret(parentPub33, chainCode, index = 0) {
  if (!(parentPub33 instanceof Uint8Array) || parentPub33.length !== 33) {
    throw new Error('parentPub33 must be 33-byte compressed pubkey');
  }
  if (!(chainCode instanceof Uint8Array) || chainCode.length !== 32) {
    throw new Error('chainCode must be 32-byte Uint8Array');
  }

  const data = concat(parentPub33, uint32be(index));
  const I = hmacSHA512(chainCode, data);
  const IL = I.slice(0, 32);
  // const IR = I.slice(32); // future childChainCode if you want to chain further

  const ilBig = bytesToBigInt(IL) % curveOrder();
  if (ilBig === 0n) throw new Error('Invalid derived IL (zero) in ckdPub');

  const parentPoint = secp256k1.Point.fromHex(bytesToHex(parentPub33));
  const childPoint = secp256k1.Point.BASE.multiply(ilBig).add(parentPoint);

  // v2: toRawBytes -> toBytes
  return childPoint.toBytes(true); // compressed 33-byte
}

/**
 * Minimal BIP32 CKDpriv: non-hardened child with chainCode = secret (32 bytes).
 */
export function ckdPrivFromSecret(parentPriv, chainCode, index = 0) {
  if (!(parentPriv instanceof Uint8Array) || parentPriv.length !== 32) {
    throw new Error('parentPriv must be 32-byte Uint8Array');
  }
  if (!(chainCode instanceof Uint8Array) || chainCode.length !== 32) {
    throw new Error('chainCode must be 32-byte Uint8Array');
  }

  const parentPub33 = secp256k1.getPublicKey(parentPriv, true);
  const data = concat(parentPub33, uint32be(index));
  const I = hmacSHA512(chainCode, data);
  const IL = I.slice(0, 32);
  // const IR = I.slice(32);

  const ilBig = bytesToBigInt(IL) % curveOrder();
  const kparBig = bytesToBigInt(parentPriv) % curveOrder();
  const childPrivBig = (ilBig + kparBig) % curveOrder();

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
  senderPrivBytes,
  scanPub33,
  spendPub33,
  prevoutHashHex,
  prevoutN,
  index = 0
) {
  const outpointStr = `${prevoutHashHex}${String(prevoutN)}`;
  const sharedSecret = calculatePaycodeSharedSecret(senderPrivBytes, scanPub33, outpointStr);

  const childPubkey = ckdPubFromSecret(spendPub33, sharedSecret, index);
  const childHash160 = _hash160(childPubkey);

  // Address encoding is intentionally left to callers (UI or wallet layer).
  const address = null;

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
  scanPrivBytes,
  spendPrivBytes,
  senderPub33,
  prevoutHashHex,
  prevoutN,
  index = 0
) {
  const outpointStr = `${prevoutHashHex}${String(prevoutN)}`;
  const sharedSecret = calculatePaycodeSharedSecret(scanPrivBytes, senderPub33, outpointStr);
  const oneTimePriv = ckdPrivFromSecret(spendPrivBytes, sharedSecret, index);
  return { oneTimePriv, sharedSecret };
}

/**
 * Derive a per-payment session key schedule from sharedSecret.
 */
export function deriveRpaSessionKeys(sharedSecret, txidHex = '', vout = 0) {
  if (!(sharedSecret instanceof Uint8Array) || sharedSecret.length !== 32) {
    throw new Error('sharedSecret must be 32-byte Uint8Array');
  }

  const ctx = new TextEncoder().encode(`${txidHex}:${vout}`);
  const base = sha256(concat(sharedSecret, ctx)); // session_key

  const amountKey = sha256(concat(base, new TextEncoder().encode('amount'))).slice(0, 16);
  const memoKey   = sha256(concat(base, new TextEncoder().encode('memo'))).slice(0, 16);
  const zkSeed    = sha256(concat(base, new TextEncoder().encode('zk-seed')));

  return { sessionKey: base, amountKey, memoKey, zkSeed };
}

// ------------ Legacy ephem-based helpers (Phase 1 demo) ------------

export function encryptAmount(ephemPrivBytes, receiverPubBytes, amount) {
  if (typeof amount !== 'number' || amount <= 0) {
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
  const iv = randomBytes(16);
  const amountData = `{"v":${amount}}`;
  const aesCtr = new aesjs.ModeOfOperation.ctr(aesKey, new aesjs.Counter(iv));
  const ciphertext = aesCtr.encrypt(new TextEncoder().encode(amountData));
  return concat(iv, ciphertext);
}

export function decryptAmount(privBytes, senderEphemPubBytes, encryptedAmount) {
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
    throw new Error('encryptedAmount must be Uint8Array >16 bytes');
  }

  const sharedSecret = secp256k1.getSharedSecret(privBytes, senderEphemPubBytes);
  const aesKey = sha256(sharedSecret).slice(0, 16);
  const iv = encryptedAmount.slice(0, 16);
  const ciphertext = encryptedAmount.slice(16);
  const aesCtr = new aesjs.ModeOfOperation.ctr(aesKey, new aesjs.Counter(iv));
  const decryptedBytes = aesCtr.decrypt(ciphertext);

  try {
    const decryptedStr = new TextDecoder().decode(decryptedBytes);
    return decryptedStr;
  } catch (err) {
    throw new Error('Decryption failed: Invalid padding or key');
  }
}