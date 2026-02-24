# ProofBlob32 ABI (PB32) — Revised Spec (Phase 2)

> **Status:** Draft / Demo ABI for this repo (Chipnet).
>
> This document specifies a compact, deterministic **32-byte-aligned proof blob** format intended to be:
> - produced **off-chain** (provers / wallets),
> - validated **on-chain** by CashVM/CASMs where needed,
> - and carried through the **pool shard** state-machine as opaque commitments.
>
> The guiding constraints are:
> - easy to hash / fold into 32-byte state transitions,
> - strict parsing with no ambiguous encodings,
> - versioned for forward compatibility.

---

## 1. Terms

- **PB32**: ProofBlob32, a binary blob whose *primary digest* is 32 bytes.
- **commitment32**: A 32-byte value committed into a shard (e.g., CashTokens NFT commitment field).
- **stateIn32 / stateOut32**: 32-byte covenant state values used by pool hash-fold transitions.
- **VarInt**: Bitcoin-style compactSize (only where explicitly permitted).
- **LE/BE**: Little-endian / big-endian (explicit per-field below).

---

## 2. Versioning

PB32 begins with a 4-byte **header**:

| Offset | Size | Field | Encoding | Notes |
|---:|---:|---|---|---|
| 0 | 1 | `abi_version` | u8 | **0x01** for this spec |
| 1 | 1 | `flags` | u8 | bitfield (see below) |
| 2 | 2 | `type` | u16-be | proof type discriminator |

### 2.1 Flags

`flags` is a bitfield:

- bit 0: `has_aux` — auxiliary section is present
- bit 1: `has_domain` — domain separator present
- bit 2: `has_pubdata` — public data section present
- bit 3: `reserved` (must be 0)
- bits 4-7: `reserved` (must be 0)

**Parsing rule:** any non-zero reserved bits MUST fail strict parsing.

---

## 3. Canonical Layout

PB32 is the concatenation of the following sections in order:

1. **Header** (4 bytes)
2. **Domain (optional)**
3. **Public Data (optional)**
4. **Auxiliary Data (optional)**
5. **Body**
6. **Trailer**

All variable-sized sections use canonical lengths and MUST be fully consumed (no trailing junk).

### 3.1 Domain Section (optional)

Present if `flags.has_domain` is set.

| Field | Encoding | Notes |
|---|---|---|
| `domain_len` | u8 | max 64 |
| `domain_bytes` | bytes[domain_len] | ASCII recommended; any bytes allowed |

**Rule:** `domain_len` MUST be 1..64 when present.

### 3.2 Public Data Section (optional)

Present if `flags.has_pubdata` is set.

| Field | Encoding | Notes |
|---|---|---|
| `pubdata_len` | u16-be | max 1024 |
| `pubdata_bytes` | bytes[pubdata_len] | deterministic, no JSON requirement |

**Rule:** `pubdata_len` MAY be 0 (empty pubdata) if present.

### 3.3 Auxiliary Section (optional)

Present if `flags.has_aux` is set.

| Field | Encoding | Notes |
|---|---|---|
| `aux_len` | u16-be | max 2048 |
| `aux_bytes` | bytes[aux_len] | may contain receipts, transcripts, etc. |

### 3.4 Body

The body is proof-type specific. It begins with a fixed 32-byte digest of the proof core:

| Field | Size | Notes |
|---|---:|---|
| `core_digest32` | 32 | SHA-256 (or agreed hash) of the “core proof statement” |

Then a proof-type-specific payload follows:

| Field | Encoding | Notes |
|---|---|---|
| `payload_len` | u16-be | max 4096 |
| `payload_bytes` | bytes[payload_len] | opaque to on-chain unless a verifier is implemented |

### 3.5 Trailer

| Field | Size | Notes |
|---|---:|---|
| `pb32_hash32` | 32 | final hash binding all previous bytes (see hashing) |

---

## 4. Hashing

PB32 has **two** important 32-byte values:

1) `core_digest32` — included in the body; produced by the prover from the “core statement”.  
2) `pb32_hash32` — the final binding hash of the entire PB32 minus the trailer itself.

### 4.1 pb32_hash32 computation

Let `pb32_without_trailer = PB32[0 .. (len-32))]`.

Compute:

```
pb32_hash32 = SHA256(pb32_without_trailer)
```

**Rule:** The last 32 bytes MUST equal `pb32_hash32`, otherwise parsing/validation fails.

### 4.2 Commitment usage

When PB32 is used as a shard commitment input, the covenant SHOULD commit:

- either `pb32_hash32` (recommended),
- or `core_digest32` if a higher-level protocol commits the rest elsewhere.

This repo’s default assumption is to commit the **full binding hash** (`pb32_hash32`).

---

## 5. Pool Integration

### 5.1 Shard commitments

In the Phase 2 pool design, each shard is represented by a covenant-locked UTXO with a CashTokens NFT commitment:

- `commitment32` is the **shard state commitment**
- transitions compute `stateOut32 = H(stateIn32 || noteHash32 || …)` (implementation-defined)

PB32 fits by treating `pb32_hash32` as a “note hash” / “event hash” input for the fold.

### 5.2 Deterministic fold inputs

When folding PB32 into a state transition, the folding function MUST specify:

- `category32` (32)
- `stateIn32` (32)
- `pb32_hash32` or `core_digest32` (32)
- a version/cap byte set (implementation-defined)

and MUST produce a unique `stateOut32`.

---

## 6. On-Chain Verifier Interface (optional)

If a covenant chooses to verify proof semantics on-chain (rather than only committing), it SHOULD:

- strictly parse PB32,
- check `pb32_hash32` binding,
- validate `abi_version`, `flags`, and `type`,
- then invoke a proof-type-specific verifier using:
  - `core_digest32`
  - `payload_bytes`
  - `pubdata_bytes` (if present)
  - `domain_bytes` (if present)

**Note:** In Phase 2 demo flows, most proofs are expected to be validated off-chain; on-chain verification is a future step.

---

## 7. Proof Type Registry

`type` is a u16-be discriminator. Recommended conventions:

- `0x0001` — “null proof / placeholder” (demo)
- `0x0100` — “range / amount proof” (future)
- `0x0200` — “membership / inclusion proof” (future)
- `0x0300` — “linkable / anti-double-spend proof” (future)

This repo does not yet standardize proof semantics beyond the structure.

---

## 8. Strict Parsing Checklist

An implementation MUST fail if:

- `abi_version != 0x01`
- reserved bits in `flags` are set
- any section length exceeds max limits
- any section runs past buffer end
- any trailing bytes remain after fully parsing all sections
- `pb32_hash32` does not match `SHA256(pb32_without_trailer)`

---

## 9. Test Vectors

### 9.1 Minimal PB32 (no optional sections)

Layout:

- header (4)
- core_digest32 (32)
- payload_len (2) = 0
- pb32_hash32 (32)

Total = 70 bytes.

When you add test vectors, include:

- hex encoding of full PB32
- computed `pb32_hash32`
- extracted `core_digest32`
- type + flags

---

## 10. Notes for Developers

- Keep PB32 generation deterministic: no JSON stringification unless canonicalized.
- Prefer small pubdata; store large transcripts off-chain and commit their hash.
- Treat PB32 as a “portable commitment capsule” that can survive refactors of the verifier.

---

## Changelog

- **2026-02-23**: Revised spec for Phase 2 usability: explicit header, strict parsing, binding hash trailer, and pool fold integration.
