// packages/pool-shards/src/debug/covenant_spend_dossier.ts
import {
  bytesToHex,
  hash160,
  minimalScriptNumber,
  sha256,
  hexToBytes,
} from '@bch-stealth/utils';

import { getPreimage, splitTokenPrefix } from '@bch-stealth/tx-builder';

type Outpoint = { txid: string; vout: number };

type PrevoutLike = {
  valueSats: bigint;
  scriptPubKey: Uint8Array;
  outpoint?: Outpoint;
};

type ScriptItem =
  | { kind: 'op'; opcode: number }
  | { kind: 'push'; data: Uint8Array };

function envFlag(name: string): string | undefined {
  // Node only; keep safe in tests/bundlers.
  // eslint-disable-next-line no-undef
  const p = typeof process !== 'undefined' ? process : undefined;
  return p?.env?.[name];
}

function debugMode(): { enabled: boolean; modes: string[] } {
  const modes: string[] = [];
  if (envFlag('BCH_STEALTH_DEBUG_IMPORT')) modes.push('IMPORT');
  if (envFlag('BCH_STEALTH_DEBUG_WITHDRAW')) modes.push('WITHDRAW');
  return { enabled: modes.length > 0, modes };
}

function u8FromMaybeHex(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') return hexToBytes(x.startsWith('0x') ? x.slice(2) : x);
  return new Uint8Array();
}

function firstNHex(b: Uint8Array | null | undefined, n: number): string {
  if (!b || b.length === 0) return '';
  return bytesToHex(b.slice(0, Math.min(n, b.length)));
}

function parseScriptItems(script: Uint8Array): ScriptItem[] {
  const items: ScriptItem[] = [];
  let i = 0;

  const readLE = (len: number): number => {
    let v = 0;
    for (let k = 0; k < len; k++) v |= script[i + k] << (8 * k);
    return v >>> 0;
  };

  while (i < script.length) {
    const op = script[i];

    // Direct push: 0x01..0x4b
    if (op >= 0x01 && op <= 0x4b) {
      const n = op;
      i += 1;
      items.push({ kind: 'push', data: script.slice(i, i + n) });
      i += n;
      continue;
    }

    // PUSHDATA1
    if (op === 0x4c) {
      if (i + 1 >= script.length) break;
      const n = script[i + 1];
      i += 2;
      items.push({ kind: 'push', data: script.slice(i, i + n) });
      i += n;
      continue;
    }

    // PUSHDATA2
    if (op === 0x4d) {
      if (i + 2 >= script.length) break;
      const n = readLE(2);
      i += 3;
      items.push({ kind: 'push', data: script.slice(i, i + n) });
      i += n;
      continue;
    }

    // PUSHDATA4
    if (op === 0x4e) {
      if (i + 4 >= script.length) break;
      const n = readLE(4);
      i += 5;
      items.push({ kind: 'push', data: script.slice(i, i + n) });
      i += n;
      continue;
    }

    // Opcode
    items.push({ kind: 'op', opcode: op });
    i += 1;
  }

  return items;
}

function findPushByLen(items: ScriptItem[], len: number): Uint8Array | null {
  for (const it of items) {
    if (it.kind === 'push' && it.data.length === len) return it.data;
  }
  return null;
}

function lastPush(items: ScriptItem[]): Uint8Array | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'push') return it.data;
  }
  return null;
}

export function maybeLogCovenantSpendDossier(args: {
  tx: any;
  vin: number;

  redeemScript: Uint8Array;
  prevout: PrevoutLike;

  amountCommitment: bigint;
  hashtype: number;

  extraPrefix?: Uint8Array;
}): void {
  const { enabled, modes } = debugMode();
  if (!enabled) return;

  const { tx, vin, redeemScript, prevout, amountCommitment, hashtype, extraPrefix } = args;

  const prevSpk = prevout.scriptPubKey;
  const { prefix: tokenPrefix, locking: nonTokenScript } = splitTokenPrefix(prevSpk);

  const scriptCode = redeemScript;
  const amountBytes = minimalScriptNumber(amountCommitment);

  const preimage = getPreimage(
    tx,
    vin,
    scriptCode,
    prevout.valueSats,
    hashtype,
    tokenPrefix ?? undefined
  );
  const sighash = sha256(sha256(preimage));

  const scriptSig = u8FromMaybeHex(tx?.inputs?.[vin]?.scriptSig);
  const items = parseScriptItems(scriptSig);

  const pub33 = findPushByLen(items, 33);
  const sig65 = findPushByLen(items, 65);

  const last = lastPush(items);
  const lastEqualsRedeem =
    !!last &&
    last.length === redeemScript.length &&
    last.every((v, i) => v === redeemScript[i]);

  const redeemH160 = hash160(redeemScript);

  const lines: string[] = [];
  lines.push('=== BCH_STEALTH COVENANT SPEND DOSSIER ===');
  lines.push(`modes=${modes.join('|')}`);
  lines.push(`vin=${vin}`);

  const outpointStr =
    prevout.outpoint ? `${prevout.outpoint.txid}:${prevout.outpoint.vout}` : '(unknown)';
  lines.push(`prevout_outpoint=${outpointStr}`);
  lines.push(`prevout_valueSats=${prevout.valueSats.toString()}`);
  lines.push(`prevout_scriptPubKey=${bytesToHex(prevSpk)}`);
  lines.push(`prevout_tokenPrefix_len=${tokenPrefix ? tokenPrefix.length : 0}`);
  lines.push(`prevout_tokenPrefix_first16=${firstNHex(tokenPrefix, 16)}`);
  lines.push(`prevout_nonTokenScript=${bytesToHex(nonTokenScript)}`);

  lines.push(`redeemScript_len=${redeemScript.length}`);
  lines.push(`redeemScript=${bytesToHex(redeemScript)}`);
  lines.push(`redeemScript_hash160=${bytesToHex(redeemH160)}`);

  lines.push(`scriptCode_len=${scriptCode.length}`);
  lines.push(`scriptCode=${bytesToHex(scriptCode)}`);
  lines.push(`scriptCode_equals_redeemScript=${scriptCode.length === redeemScript.length}`);

  lines.push(`hashtype=0x${hashtype.toString(16).padStart(2, '0')}`);
  lines.push(`amountCommitment=${amountCommitment.toString()}`);
  lines.push(`amountCommitment_minint=${bytesToHex(amountBytes)}`);

  if (extraPrefix && extraPrefix.length) {
    lines.push(`extraPrefix_len=${extraPrefix.length}`);
    lines.push(`extraPrefix_first16=${firstNHex(extraPrefix, 16)}`);
  } else {
    lines.push(`extraPrefix_len=0`);
    lines.push(`extraPrefix_first16=`);
  }

  lines.push(`preimage=${bytesToHex(preimage)}`);
  lines.push(`sighash=${bytesToHex(sighash)}`);

  lines.push(`scriptSig_len=${scriptSig.length}`);
  lines.push(`scriptSig=${bytesToHex(scriptSig)}`);
  lines.push(`scriptSig_items=${items.length}`);

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    if (it.kind === 'op') {
      lines.push(`scriptSig_item[${idx}]=op 0x${it.opcode.toString(16).padStart(2, '0')}`);
    } else {
      lines.push(
        `scriptSig_item[${idx}]=push len=${it.data.length} first4=${firstNHex(it.data, 4)}`
      );
    }
  }

  lines.push(`scriptSig_last_push_equals_redeemScript=${lastEqualsRedeem}`);

  lines.push(`pub33=${pub33 ? bytesToHex(pub33) : ''}`);
  lines.push(`sig65=${sig65 ? bytesToHex(sig65) : ''}`);

  lines.push('=== /BCH_STEALTH COVENANT SPEND DOSSIER ===');

  console.log(lines.join('\n'));
}