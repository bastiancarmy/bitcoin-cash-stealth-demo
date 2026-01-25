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

export function extractPubKeyFromPaycode(paycode: string): Uint8Array {
  const data = base58checkDecode(paycode);
  // payload layout: [version, flags, pubkey33, chaincode32, pad13]
  return data.payload.slice(2, 35);
}

export function generatePaycode(privBytes: Uint8Array): string {
  privBytes = ensureEvenYPriv(privBytes);
  const pubKey = secp256k1.getPublicKey(privBytes, true);

  // deterministic chaincode (demo): sha256("bch-stealth-paycode-v0" || pubkey33)
  const tag = new TextEncoder().encode('bch-stealth-paycode-v0');
  const chainCode = sha256(new Uint8Array([...tag, ...pubKey]));

  const flags = 0x00;
  const version = 0x01;
  const pad = new Uint8Array(13);
  const payload = concat(new Uint8Array([version, flags]), pubKey, chainCode, pad);
  return base58checkEncode(0x47, payload);
}

export function setupPaycodesAndDerivation(alice: LoadedWallet, bob: LoadedWallet): PaycodeSetup {
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

type FundingActor = {
  id: string;          // stable internal id (e.g. "user", "wallet_a", "wallet_b")
  label: string;       // display label (e.g. "Wallet A")
  baseAddress: string; // funding fallback address
};

export function printFundingHelp(args: {
  network: string;
  actorA: FundingActor;
  actorB: FundingActor;
}) {
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