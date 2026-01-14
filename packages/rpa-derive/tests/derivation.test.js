import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { deriveRpaOneTimeAddressSender, deriveRpaOneTimePrivReceiver, RPA_MODE_STEALTH_P2PKH, deriveRpaLockIntent, } from '../src/derivation.js';
test('RPA derivation: sender/receiver derive same one-time pubkey and shared secret', () => {
    // Fixed deterministic inputs (32-byte scalars)
    const senderPriv = Uint8Array.from([...Array(32)].map((_, i) => (i + 1) & 0xff));
    const scanPriv = Uint8Array.from([...Array(32)].map((_, i) => (0x11 + i) & 0xff));
    const spendPriv = Uint8Array.from([...Array(32)].map((_, i) => (0x55 + i) & 0xff));
    const senderPub33 = secp256k1.getPublicKey(senderPriv, true);
    const scanPub33 = secp256k1.getPublicKey(scanPriv, true);
    const spendPub33 = secp256k1.getPublicKey(spendPriv, true);
    const prevoutTxidHex = '00'.repeat(31) + '01';
    const prevoutN = 7;
    const index = 0;
    const s = deriveRpaOneTimeAddressSender(senderPriv, scanPub33, spendPub33, prevoutTxidHex, prevoutN, index);
    const r = deriveRpaOneTimePrivReceiver(scanPriv, spendPriv, senderPub33, prevoutTxidHex, prevoutN, index);
    const receiverOneTimePub33 = secp256k1.getPublicKey(r.oneTimePriv, true);
    assert.equal(Buffer.from(s.sharedSecret).toString('hex'), Buffer.from(r.sharedSecret).toString('hex'));
    assert.equal(Buffer.from(s.childPubkey).toString('hex'), Buffer.from(receiverOneTimePub33).toString('hex'));
});
test('deriveRpaLockIntent returns stable typed shape', () => {
    const senderPriv = Uint8Array.from([...Array(32)].map((_, i) => (i + 1) & 0xff));
    const receiverPub33 = secp256k1.getPublicKey(senderPriv, true);
    const out = deriveRpaLockIntent({
        mode: RPA_MODE_STEALTH_P2PKH,
        senderPrivBytes: senderPriv,
        receiverPub33,
        prevoutTxidHex: '11'.repeat(32),
        prevoutN: 0,
    });
    assert.equal(out.mode, RPA_MODE_STEALTH_P2PKH);
    assert.equal(out.childPubkey.length, 33);
    assert.equal(out.childHash160.length, 20);
    assert.equal(out.sharedSecret.length, 32);
});
//# sourceMappingURL=derivation.test.js.map