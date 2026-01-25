import { createHash } from "node:crypto";

const ALICE = "5dc2a7d909c39b5ee61b237014424996a8bbe2d0c10031b57780e699ce59630c";
const BOB   = "552ce2c1921ebad7587115c00cd3918bdc34210f47c7a7f9439accb3cafb269d";

function sha256(b) {
  return createHash("sha256").update(b).digest();
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58encode(buf) {
  let x = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (x > 0n) {
    const mod = x % 58n;
    out = ALPHABET[Number(mod)] + out;
    x = x / 58n;
  }
  // leading zeros
  for (let i = 0; i < buf.length && buf[i] === 0; i++) out = "1" + out;
  return out;
}

function base58check(versionByte, payload) {
  const body = Buffer.concat([Buffer.from([versionByte]), payload]);
  const checksum = sha256(sha256(body)).subarray(0, 4);
  return base58encode(Buffer.concat([body, checksum]));
}

function wifFromHexTestnetCompressed(hex) {
  const priv = Buffer.from(hex, "hex");
  if (priv.length !== 32) throw new Error("priv must be 32 bytes");
  const suffixCompressed = Buffer.from([0x01]);
  // testnet/chipnet WIF prefix
  return base58check(0xef, Buffer.concat([priv, suffixCompressed]));
}

console.log("Alice testnet WIF (compressed):", wifFromHexTestnetCompressed(ALICE));
console.log("Bob   testnet WIF (compressed):", wifFromHexTestnetCompressed(BOB));