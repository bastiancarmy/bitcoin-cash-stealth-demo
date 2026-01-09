// src/paycodes.js

import { base58checkDecode, base58checkEncode } from './base58.js';
import { concat, bytesToHex, getXOnlyPub, ensureEvenYPriv } from './utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'crypto';

export function generatePaycode(privBytes) {
  privBytes = ensureEvenYPriv(privBytes);
  let pubKey = secp256k1.getPublicKey(privBytes, true); // 33 bytes (even y)
  try {
    secp256k1.Point.fromHex(bytesToHex(pubKey));
    console.log('✅ Generated valid compressed pubKey (hex):', bytesToHex(pubKey));
  } catch (e) {
    throw new Error(`Invalid private key for paycode generation: ${e.message}`);
  }
  const chainCode = randomBytes(32);
  const flags = 0x00;
  const version = 0x01;
  const pad = new Uint8Array(13);
  const payload = concat(new Uint8Array([version, flags]), pubKey, chainCode, pad);
  return base58checkEncode(0x47, payload);
}

export function setupPaycodesAndDerivation(alice, bob, sendAmount = 100000) {
  console.log('Generating paycodes from static wallet keys...');
  console.log('  Alice base pubkey:', bytesToHex(alice.pubBytes));
  console.log('  Bob   base pubkey:', bytesToHex(bob.pubBytes));

  console.log('\n[1A] Bob’s static paycode (for Alice → Bob)');
  const bobPaycode = generatePaycode(bob.privBytes);
  console.log('  Bob paycode:', bobPaycode);

  console.log('\n[1B] Alice’s static paycode (for Bob → Alice)');
  const alicePaycode = generatePaycode(alice.privBytes);
  console.log('  Alice paycode:', alicePaycode);

  console.log('\n[1C] Parsing Bob’s paycode to get his static paycode pubkey Q/R');
  const bobPaycodeData = base58checkDecode(bobPaycode);
  const bobPubBytes = bobPaycodeData.payload.slice(2, 35);
  console.log('  Bob paycode pubkey (33 bytes):', bytesToHex(bobPubBytes));
  console.log('  (Note: this key is never used directly on-chain; RPA derives fresh children from it.)');

  const bobXOnly = getXOnlyPub(bobPubBytes);
  console.log('  Bob paycode x-only (demo only):', bytesToHex(bobXOnly));

  // For the Phase 1 covenant demo, we just send a tiny dust output to Bob’s
  // base address so it’s easy to see on the explorer.
  const derivedAddr = bob.address;
  // [1D] NOTE ABOUT DUST/CHANGE DESTINATIONS IN THIS DEMO:
  //
  // We intentionally keep base P2PKH addresses "quiet" where possible.
  // - Deposits/withdrawals pay to RPA stealth P2PKH derived from the receiver's paycode.
  // - Change is also returned to an RPA stealth P2PKH derived from the sender's paycode.
  // - The base P2PKH address may still appear in logs as a *fallback* funding address.
  //
  console.log(
    `[1D] This demo uses RPA stealth P2PKH for payments + change (paycode-derived).`
  );
  console.log(
    `     Base P2PKH addresses are used only as a fallback funding source if no recorded stealth UTXOs exist.`
  );
  console.log(
    `     Bob base P2PKH fallback (funding only): ${bobBaseWallet.address}`
  );

  return {
    alice,
    bob,
    alicePaycode,
    bobPaycode,
    derivedAddr,
  };
}