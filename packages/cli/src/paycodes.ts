// packages/cli/src/paycodes.ts
import { base58checkDecode, base58checkEncode } from "./base58.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "node:crypto";
import type { LoadedWallet } from "./wallets.js";
import { ensureEvenYPriv, getXOnlyPub } from "./utils.js";
import { bytesToHex, sha256 } from "@bch-stealth/utils";

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

export function decodePaycode(paycode: string): {
  versionByte: number;      // base58check version (should be 0x47)
  paycodeVersion: number;   // payload[0] (should be 0x01)
  flags: number;            // payload[1]
  pubkey33: Uint8Array;
  chainCode32: Uint8Array;
} {
  const { version, payload } = base58checkDecode(paycode);

  if (version !== 0x47) throw new Error(`invalid paycode version byte: ${version} (expected 0x47)`);
  if (!(payload instanceof Uint8Array) || payload.length < 80) {
    throw new Error(`invalid paycode payload length: ${payload?.length ?? "??"} (expected >= 80)`);
  }

  const paycodeVersion = payload[0];
  const flags = payload[1];
  const pubkey33 = payload.slice(2, 35);
  const chainCode32 = payload.slice(35, 67);

  if (paycodeVersion !== 0x01) {
    throw new Error(`unsupported paycode payload version: ${paycodeVersion} (expected 0x01)`);
  }
  if (pubkey33.length !== 33) throw new Error(`invalid paycode pubkey length: ${pubkey33.length}`);
  if (chainCode32.length !== 32) throw new Error(`invalid paycode chaincode length: ${chainCode32.length}`);

  return { versionByte: version, paycodeVersion, flags, pubkey33, chainCode32 };
}

export function extractPubKeyFromPaycode(paycode: string): Uint8Array {
  return decodePaycode(paycode).pubkey33;
}

export function generatePaycode(privBytes: Uint8Array): string {
  privBytes = ensureEvenYPriv(privBytes);
  const pubKey = secp256k1.getPublicKey(privBytes, true);

  // deterministic chaincode (demo): sha256("bch-stealth-paycode-v0" || pubkey33)
  const tag = new TextEncoder().encode("bch-stealth-paycode-v0");
  const chainCode = sha256(new Uint8Array([...tag, ...pubKey]));

  const flags = 0x00;
  const version = 0x01;
  const pad = new Uint8Array(13);
  const payload = concat(new Uint8Array([version, flags]), pubKey, chainCode, pad);
  return base58checkEncode(0x47, payload);
}

export function setupPaycodesAndDerivation(alice: LoadedWallet, bob: LoadedWallet): PaycodeSetup {
  console.log("Generating paycodes from static wallet keys...");

  const alicePaycodeKey = (alice as any).scanPrivBytes ?? alice.privBytes;
  const bobPaycodeKey = (bob as any).scanPrivBytes ?? bob.privBytes;

  console.log("  Alice base pubkey:", bytesToHex(alice.pubBytes));
  console.log("  Bob   base pubkey:", bytesToHex(bob.pubBytes));

  console.log("\n[1A] Bob’s static paycode (for Alice → Bob)");
  const bobPaycode = generatePaycode(bobPaycodeKey);
  console.log("  Bob paycode:", bobPaycode);

  console.log("\n[1B] Alice’s static paycode (for Bob → Alice)");
  const alicePaycode = generatePaycode(alicePaycodeKey);
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

type FundingActor = {
  id: string;
  label: string;
  baseAddress: string;
};

export function printFundingHelp(args: { network: string; actorA: FundingActor; actorB: FundingActor }) {
  const { network, actorA, actorB } = args;

  console.log(`\n[funding] Network: ${network}`);
  console.log(`[funding] Fund ONE of these base P2PKH addresses if you see "No funding UTXO available":`);
  console.log(`  - ${actorA.label} (${actorA.id}) base P2PKH: ${actorA.baseAddress}`);
  console.log(`  - ${actorB.label} (${actorB.id}) base P2PKH: ${actorB.baseAddress}`);

  console.log(`\n[funding] Notes:`);
  console.log(`  - Change will often go to stealth (paycode-derived) P2PKH outputs.`);
  console.log(`  - External wallets won’t track those outputs.`);
  console.log(`  - The CLI can spend them IF they are recorded in the state file (stealthUtxos).`);
  console.log(`  - Keep reusing the same --state-file between runs.`);
}
