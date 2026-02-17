import test from "node:test";
import assert from "node:assert/strict";

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";

import { bytesToHex, hexToBytes, reverseBytes } from "@bch-stealth/utils";
import { deriveRpaOneTimePrivReceiver } from "@bch-stealth/rpa-derive";

import { scanRawTxForRpaOutputs } from "../scanRawTxForRpaOutputs.js";

function hash160(b: Uint8Array): Uint8Array {
  return ripemd160(sha256(b));
}

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.from([n]);
  if (n <= 0xffff) return Uint8Array.from([0xfd, n & 0xff, (n >>> 8) & 0xff]);
  // not needed for this test
  throw new Error("varint too large");
}

function u32LE(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function u64LE(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let x = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function push(data: Uint8Array): Uint8Array {
  if (data.length <= 75) return Uint8Array.from([data.length, ...data]);
  throw new Error("push too long for test");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test("scanRawTxForRpaOutputs finds a matching stealth P2PKH output", () => {
  // Receiver keys (what the scanner has)
  const scanPrivBytes = hexToBytes("11".repeat(32));
  const spendPrivBytes = hexToBytes("22".repeat(32));

  // Sender pubkey (extracted from scriptSig)
  const senderPriv = hexToBytes("33".repeat(32));
  const senderPub33 = secp256k1.getPublicKey(senderPriv, true);

  // Pretend prevout (the input outpoint we spend)
  const prevoutTxidHex = "aa".repeat(32);
  const prevoutN = 1;

  // Derive expected one-time pubkey hash160 for roleIndex 0
  const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
    scanPrivBytes,
    spendPrivBytes,
    senderPub33,
    prevoutTxidHex,
    prevoutN,
    0
  );

  const oneTimePub33 = secp256k1.getPublicKey(oneTimePriv, true);
  const pkh = hash160(oneTimePub33);

  // Build a minimal tx:
  // version(2) + vin(1) + input(prevout + scriptsig + seq) + vout(1) + output(value + p2pkh) + locktime
  const version = u32LE(2);

  const vinCnt = varint(1);

  const prevHashLE = reverseBytes(hexToBytes(prevoutTxidHex));
  const prevIndex = u32LE(prevoutN);

  const dummySig = new Uint8Array(71).fill(0x30); // bogus DER-ish bytes; scanner doesn't validate
  const scriptSig = concatBytes(push(dummySig), push(senderPub33));
  const scriptSigLen = varint(scriptSig.length);

  const sequence = hexToBytes("ffffffff");

  const voutCnt = varint(1);
  const value = u64LE(1000);

  const spk = concatBytes(
    hexToBytes("76a914"),
    pkh,
    hexToBytes("88ac")
  );
  const spkLen = varint(spk.length);

  const locktime = u32LE(0);

  const rawTx = concatBytes(
    version,
    vinCnt,
    prevHashLE,
    prevIndex,
    scriptSigLen,
    scriptSig,
    sequence,
    voutCnt,
    value,
    spkLen,
    spk,
    locktime
  );

  const rawTxHex = bytesToHex(rawTx);

  const matches = scanRawTxForRpaOutputs({
    rawTxHex,
    scanPrivBytes,
    spendPrivBytes,
    maxRoleIndex: 1,
    maxMatches: 10,
  } as any);

  assert.equal(matches.length, 1);
  assert.equal((matches[0] as any).vout, 0);
  assert.equal((matches[0] as any).hash160Hex, bytesToHex(pkh));
});