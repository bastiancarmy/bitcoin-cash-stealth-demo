// packages/cli/src/tests/selectFundintUtxo.stealth-fallback.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, hash160 } from '@bch-stealth/utils';
import { deriveRpaOneTimePrivReceiver } from '@bch-stealth/rpa';

import { normalizeWalletKeys } from '../wallet/normalizeKeys.js';
import { selectFundingUtxo } from '../pool/state.js';

function p2pkhScriptPubKeyFromH160(h160Hex: string): Uint8Array {
  return hexToBytes(`76a914${h160Hex}88ac`);
}

test('selectFundingUtxo: base empty -> selects stealth record when valid', async () => {
  // Receiver wallet (the one selecting funding)
  const receiverPriv = hexToBytes('11'.repeat(32));
  const receiverScan = hexToBytes('12'.repeat(32)); // distinct scan key to exercise normalization

  const receiverWallet = {
    address: 'bitcoincash:qq000000000000000000000000000000000000000',
    privBytes: receiverPriv,
    scanPrivBytes: receiverScan,
    // IMPORTANT: omit spendPrivBytes so normalizeWalletKeys derives it
    spendPrivBytes: null,
  } as any;

  const nk = normalizeWalletKeys(receiverWallet);

  // Sender pubkey used in RPA context (must be a real compressed pubkey)
  const senderPriv = hexToBytes('22'.repeat(32));
  const senderPub33 = secp256k1.getPublicKey(senderPriv, true);
  const senderPub33Hex = bytesToHex(senderPub33);

  // Deterministic RPA context
  const prevoutHashHex = '33'.repeat(32);
  const prevoutN = 0;
  const index = 0;

  // Compute the expected one-time priv and its hash160 (must match record.hash160Hex)
  const { oneTimePriv } = deriveRpaOneTimePrivReceiver(
    nk.scanPriv32,
    nk.spendPriv32,
    senderPub33,
    prevoutHashHex,
    prevoutN,
    index
  );

  const oneTimePub = secp256k1.getPublicKey(oneTimePriv, true);
  const h160Hex = bytesToHex(hash160(oneTimePub));

  const stealthRecord = {
    owner: 'me',
    txid: 'aa'.repeat(32),
    vout: 1,
    valueSats: 25_000,
    hash160Hex: h160Hex,
    rpaContext: {
      senderPub33Hex,
      prevoutHashHex,
      prevoutN,
      index,
    },
    spentInTxid: null,
  } as any;

  const st = {
    stealthUtxos: [stealthRecord],
    shards: [],
  } as any;

  // Base is empty
  const getUtxos = async () => [] as any[];

  const chainIO = {
    isP2pkhOutpointUnspent: async (o: { txid: string; vout: number; hash160Hex: string }) => {
      assert.equal(o.txid, stealthRecord.txid);
      assert.equal(o.vout, stealthRecord.vout);
      assert.equal(o.hash160Hex, stealthRecord.hash160Hex);
      return true;
    },
    getPrevOutput: async (txid: string, vout: number) => {
      assert.equal(txid, stealthRecord.txid);
      assert.equal(vout, stealthRecord.vout);
      return {
        value: stealthRecord.valueSats,
        scriptPubKey: p2pkhScriptPubKeyFromH160(h160Hex),
        height: 100,
        tokenData: null,
      };
    },
  };

  const res = await selectFundingUtxo({
    mode: 'wallet-send',
    state: st,
    wallet: receiverWallet,
    ownerTag: 'me',
    minSats: 1_000n,
    chainIO,
    getUtxos,
    network: 'chipnet',
    dustSats: 546n,
  });

  assert.equal(res.source, 'stealth');
  assert.equal(res.txid, stealthRecord.txid);
  assert.equal(res.vout, stealthRecord.vout);
  assert.ok(res.record);
});