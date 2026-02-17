// packages/pool-shards/src/script_pushes.ts
import { bytesToHex } from '@bch-stealth/utils';

export type ParseScriptPushesResult = {
  pushes: Uint8Array[];
  /** opcode byte for each parsed item (including OP_0 / PUSHDATA opcodes) */
  opcodes: number[];
};

/**
 * Parse a script into pushes (push-only by default).
 *
 * Supports:
 * - OP_0
 * - direct pushes 0x01..0x4b
 * - OP_PUSHDATA1/2/4
 *
 * By default rejects any non-push opcode.
 */
export function parseScriptPushes(
  script: Uint8Array,
  opts?: { allowNonPushOpcodes?: boolean }
): ParseScriptPushesResult {
  if (!(script instanceof Uint8Array)) {
    throw new Error(`parseScriptPushes: expected Uint8Array, got ${typeof script}`);
  }

  const pushes: Uint8Array[] = [];
  const opcodes: number[] = [];

  const allowNonPushOpcodes = opts?.allowNonPushOpcodes === true;

  let i = 0;
  while (i < script.length) {
    const op = script[i++];
    opcodes.push(op);

    // OP_0 (push empty vector)
    if (op === 0x00) {
      pushes.push(new Uint8Array());
      continue;
    }

    // direct push 0x01..0x4b
    if (op >= 0x01 && op <= 0x4b) {
      const len = op;
      const end = i + len;
      if (end > script.length) {
        throw new Error(
          `parseScriptPushes: truncated direct push at offset ${i - 1} (need ${len} bytes, have ${script.length - i})`
        );
      }
      pushes.push(script.slice(i, end));
      i = end;
      continue;
    }

    // OP_PUSHDATA1
    if (op === 0x4c) {
      if (i + 1 > script.length) {
        throw new Error(`parseScriptPushes: truncated PUSHDATA1 length at offset ${i - 1}`);
      }
      const len = script[i++];
      const end = i + len;
      if (end > script.length) {
        throw new Error(
          `parseScriptPushes: truncated PUSHDATA1 at offset ${i - 2} (need ${len} bytes, have ${script.length - i})`
        );
      }
      pushes.push(script.slice(i, end));
      i = end;
      continue;
    }

    // OP_PUSHDATA2
    if (op === 0x4d) {
      if (i + 2 > script.length) {
        throw new Error(`parseScriptPushes: truncated PUSHDATA2 length at offset ${i - 1}`);
      }
      const len = script[i] | (script[i + 1] << 8);
      i += 2;
      const end = i + len;
      if (end > script.length) {
        throw new Error(
          `parseScriptPushes: truncated PUSHDATA2 at offset ${i - 3} (need ${len} bytes, have ${script.length - i})`
        );
      }
      pushes.push(script.slice(i, end));
      i = end;
      continue;
    }

    // OP_PUSHDATA4
    if (op === 0x4e) {
      if (i + 4 > script.length) {
        throw new Error(`parseScriptPushes: truncated PUSHDATA4 length at offset ${i - 1}`);
      }
      const len =
        (script[i]) |
        (script[i + 1] << 8) |
        (script[i + 2] << 16) |
        (script[i + 3] << 24);
      i += 4;
      const ulen = len >>> 0;
      const end = i + ulen;
      if (end > script.length) {
        throw new Error(
          `parseScriptPushes: truncated PUSHDATA4 at offset ${i - 5} (need ${ulen} bytes, have ${script.length - i})`
        );
      }
      pushes.push(script.slice(i, end));
      i = end;
      continue;
    }

    // Non-push opcode
    if (allowNonPushOpcodes) {
      continue;
    }

    throw new Error(
      `parseScriptPushes: unexpected non-push opcode 0x${op.toString(16).padStart(2, '0')} at offset ${i - 1}`
    );
  }

  return { pushes, opcodes };
}

function hexPreview(u8: Uint8Array, max = 16): string {
  const slice = u8.length <= max ? u8 : u8.slice(0, max);
  const h = bytesToHex(slice);
  return u8.length <= max ? h : `${h}…`;
}

export type ValidatePoolHashFoldV11Options = {
  debugPrint?: boolean;
  label?: string;
};

/**
 * Phase 2 strict validator (breaking-change friendly):
 * covenant input scriptSig MUST be push-only and exactly:
 *   [ noteHash32 (32 bytes) ][ proofBlob32 (32 bytes) ]
 */
export function validatePoolHashFoldV11UnlockScriptSig(
  scriptSig: Uint8Array,
  opts: ValidatePoolHashFoldV11Options = {}
): { pushes: Uint8Array[] } {
  const { pushes } = parseScriptPushes(scriptSig);

  const label = opts.label ? ` ${opts.label}` : '';
  const lines = pushes
    .map((p, idx) => `  [${idx}] len=${p.length} hex=${hexPreview(p)}`)
    .join('\n');

  if (opts.debugPrint) {
    console.log(`[covenant-pushparse]${label} pushes=${pushes.length}\n${lines}`);
  }

  const fail = (msg: string): never => {
    throw new Error(
      `[covenant-pushparse]${label} ${msg}\n` +
        `pushes=${pushes.length}\n` +
        (lines.length ? `${lines}\n` : '')
    );
  };

  if (pushes.length !== 2) {
    fail(
  `pool_hash_fold_v1_1: expected ABI = [noteHash32:32][proofBlob32:32] (2 pushes), got ${pushes.length} pushes`
);
  }
  if (pushes[0].length !== 32) {
    fail(`pool_hash_fold_v1_1: expected push[0]=noteHash32 len=32, got ${pushes[0].length}`);
  }
  if (pushes[1].length !== 32) {
    fail(`pool_hash_fold_v1_1: expected push[1]=proofBlob32 len=32, got ${pushes[1].length}`);
  }

  return { pushes };
}