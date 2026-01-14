import { base58checkDecode, base58checkEncode } from "./base58.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "node:crypto";
import type { Wallet } from "./wallets.js";
import { ensureEvenYPriv, getXOnlyPub } from "./utils.js";
import { bytesToHex, hexToBytes } from '@bch-stealth/utils'

export type PaycodeSetup = {
  alicePaycode: string;
  bobPaycode: string;
};

function concat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function extractPubKeyFromPaycode(paycode: string): Uint8Array {
  const data = base58checkDecode(paycode);
  // payload layout: [version, flags, pubkey33, chaincode32, pad13]
  return data.payload.slice(2, 35);
}

export function generatePaycode(privBytes: Uint8Array): string {
  privBytes = ensureEvenYPriv(privBytes);
  const pubKey = secp256k1.getPublicKey(privBytes, true);

  const chainCode = randomBytes(32);
  const flags = 0x00;
  const version = 0x01;
  const pad = new Uint8Array(13);
  const payload = concat(new Uint8Array([version, flags]), pubKey, chainCode, pad);
  return base58checkEncode(0x47, payload);
}

export function setupPaycodesAndDerivation(alice: Wallet, bob: Wallet): PaycodeSetup {
  console.log("Generating paycodes from static wallet keys...");
  console.log("  Alice base pubkey:", bytesToHex(alice.pubBytes));
  console.log("  Bob   base pubkey:", bytesToHex(bob.pubBytes));

  console.log("\n[1A] Bob’s static paycode (for Alice → Bob)");
  const bobPaycode = generatePaycode(bob.privBytes);
  console.log("  Bob paycode:", bobPaycode);

  console.log("\n[1B] Alice’s static paycode (for Bob → Alice)");
  const alicePaycode = generatePaycode(alice.privBytes);
  console.log("  Alice paycode:", alicePaycode);

  console.log("\n[1C] Parsing Bob’s paycode to get his static paycode pubkey Q/R");
  const bobPubBytes = extractPubKeyFromPaycode(bobPaycode);
  console.log("  Bob paycode pubkey (33 bytes):", bytesToHex(bobPubBytes));

  const bobXOnly = getXOnlyPub(bobPubBytes);
  console.log("  Bob paycode x-only (demo only):", bytesToHex(bobXOnly));

  console.log(`[1D] This demo uses RPA stealth P2PKH for payments + change (paycode-derived).`);
  console.log(`     Base P2PKH addresses are used only as a fallback funding source.`);
  console.log(`     Bob base P2PKH fallback (funding only): ${bob.address}`);

  return { alicePaycode, bobPaycode };
}