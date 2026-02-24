# Sharded Pool State Machine Spec (Phase 2, Chipnet)

> **Scope:** This document specifies the **local sharded pool state machine** used by the Phase 2 demo (`bchctl` + GUI).  
> **Goal:** A wallet-owned, non-custodial “privacy pool” where value can be moved through a covenant-enforced state machine using **tokenized shard UTXOs**.  
> **Status:** Demo-quality spec aligned with the current Phase 2 flows and constraints.

---

## 1. Mental model

A **pool** is a set of **shards**. Each shard is a tokenized covenant UTXO that stores a **state commitment** (NFT commitment) and a satoshi value.

- **Shards** are independent “cells” of state and value.
- A **withdraw** updates exactly **one** shard in Phase 2.
- A **deposit import** updates exactly **one** shard in Phase 2.
- A wallet maintains a **local state file** tracking shard outpoints, commitments, deposits, and discovered stealth UTXOs.

### Why shards?
- Privacy: reduce linkage between deposits/withdrawals by spreading value and updating one shard at a time.
- Scalability: state updates can be localized to one shard.
- Future: shards become stable anchors for confidential proofs / ZK commitments.

---

## 2. Components

### 2.1 On-chain artifacts

**Shard UTXO (tokenized covenant)**
- Locking script: covenant redeem script (pool hash-fold covenant bytecode).
- CashTokens prefix:
  - **Category (32 bytes):** the pool’s token category (genesis in init transaction).
  - **NFT + capability + 32-byte commitment:** used as the shard’s state commitment.
  - **Amount token not used** in Phase 2 (NFT commitment carries state).

**Funding UTXO (for init)**
- **Must be `vout=0`** because CashTokens category genesis is defined by the first input’s outpoint in BCH token rules (for category genesis in this demo flow).
- Recommended to fund via **stealth (paycode-derived) UTXO** to avoid linking a transparent wallet to the pool.

### 2.2 Local artifacts

**Pool State File**
- Stored per-profile, e.g. `.bch-stealth/profiles/<profile>/state.json`
- Canonical store key: `pool.state` (via `FileBackedPoolStateStore`)

**Events log (optional)**
- NDJSON event stream per profile: `.bch-stealth/profiles/<profile>/events.ndjson`

---

## 3. State schema (conceptual)

This is the conceptual schema. The actual JSON may contain additional fields and backward-compatible markers.

### 3.1 Top-level pool fields

- `network`: `"chipnet"` (Phase 2 demo uses chipnet)
- `poolVersion`: `"v1_1"` (default)
- `poolIdHex`: `20-byte hex` identifier (often derived deterministically)
- `categoryHex`: `32-byte hex` token category id
- `redeemScriptHex`: covenant script bytecode hex
- `shardCount`: integer shard count
- `createdAt`: ISO timestamp
- `txid`: init txid (for the latest init)
- `covenantSigner`: identity of covenant owner/signer (single-user: “me”)

### 3.2 Shards

Array `shards[]`, each shard pointer:

- `index`: integer, stable shard index
- `txid`: current outpoint txid backing this shard
- `vout`: current outpoint vout backing this shard
- `valueSats`: string integer (BigInt-safe)
- `commitmentHex`: 32-byte hex (must match on-chain token commitment)

### 3.3 Stealth UTXOs (discovery set)

Array `stealthUtxos[]` (discovered inbound paycode-derived P2PKH outputs). Each record includes:

- `txid`, `vout`, `valueSats`
- `hash160Hex`: receiver hash160 (derived)
- `owner`: profile/owner tag
- `kind`: e.g. `wallet_receive`, `wallet_change`, `pool_init_change`, etc.
- `rpaContext`: metadata required to re-derive one-time key:
  - `senderPub33Hex`
  - `prevoutHashHex` (anchor txid)
  - `prevoutN` (anchor vout)
  - `index` (role index)
- spent markers (compat):
  - `spent` boolean and/or `spentByTxid`, `spentAt`

### 3.4 Deposits (staged imports)

Array `deposits[]` (outpoints prepared to be imported into the pool):

- `txid`, `vout`, `valueSats`
- `depositKind`: `"rpa"` or `"base"`
- `receiverRpaHash160Hex` (required for RPA deposits)
- `rpaContext` (if derived from paycode)
- `createdAt`
- `importTxid` (set once imported)

### 3.5 Withdrawals (history)

Array `withdrawals[]`:

- `txid`
- `shardIndex`
- `amountSats`
- `createdAt`
- destination metadata:
  - `receiverPaycodePub33Hex` (if paycode)
  - `receiverRpaHash160Hex` (if paycode/cashaddr derived)
  - `rpaContext` (if paycode)
- `feeMode`: `"from-shard"` or `"external"`

---

## 4. State machine operations

Each operation below defines:
- **Preconditions**: must be true before execution
- **Transitions**: what changes on-chain and in local state
- **Postconditions**: invariants after execution

### 4.1 Wallet init (out of scope of pool state machine)
Creates wallet keys + paycode and records `birthdayHeight` for scan optimization.

### 4.2 Scan inbound (RPA discovery)

**Command:** `bchctl scan --update-state`

**Preconditions**
- Wallet has scan/spend keys available.
- `birthdayHeight` set to a reasonable value (or use `--window` / `--since-height`).

**Transitions**
- Queries Fulcrum RPA index for candidate txids by prefix.
- Fetches raw txs for candidates.
- Derives expected receiver hash160 for roles (indexes), finds matches in outputs.
- Adds/updates `stealthUtxos[]` in local state.

**Postconditions**
- New stealth outputs become spendable by CLI (via recorded `rpaContext`).
- No on-chain change.

### 4.3 Pool init (shard genesis)

**Command:** `bchctl pool init [--shards N] [--fresh]`

**Preconditions**
- Must have a funding UTXO meeting:
  - Satisfies `minSats >= shardCount * SHARD_VALUE + DUST + safetyMargin`
  - **Must be `vout=0`** (required by this demo’s token category genesis assumption)
- Prefer stealth funding for privacy.
- If `--fresh`, you are creating a new pool instance (new category).

**Transitions (on-chain)**
- Broadcasts init transaction:
  - consumes funding outpoint (vout=0)
  - creates token category + shard outputs (vout 1..N)
  - may create change output (ideally stealth change back to self)

**Transitions (local state)**
- Sets/updates:
  - `categoryHex`, `redeemScriptHex`, `poolIdHex`, `poolVersion`
  - `shards[]` pointers for each shard index
  - `txid` of init tx
- If init produces stealth change and the CLI can derive it, it should record a new `stealthUtxos[]` entry (e.g. `pool_init_change`).

**Postconditions**
- Each `shards[i]` references a currently-unspent covenant shard UTXO.
- Each `shards[i].commitmentHex` matches the on-chain token commitment.
- `totalPoolSats = sum(shards.valueSats)` matches expected initial value.

### 4.4 Stage-from (promote discovered stealth UTXO to deposit)

**Command:** `bchctl pool stage-from <txid:vout>`

**Preconditions**
- Outpoint exists in `stealthUtxos[]` and is unspent.
- Contains sufficient metadata (`hash160Hex` and `rpaContext`) to spend if needed.

**Transitions**
- Adds a new `deposits[]` entry with `depositKind="rpa"`.
- Does not spend anything on-chain.

**Postconditions**
- `deposits[]` contains a new unimported deposit record.

### 4.5 Stage (self-send to create deposit UTXO)

**Command:** `bchctl pool stage <sats> [--deposit-mode rpa|base]`

**Preconditions**
- Wallet has funding UTXO for the staged amount + fee.
- For `deposit-mode=rpa`, sender can derive deposit script from self-paycode.

**Transitions (on-chain)**
- Broadcasts a normal P2PKH (base or stealth) output to self configured as a “deposit” outpoint.

**Transitions (local state)**
- Records a `deposits[]` entry referencing the new outpoint.
- If change is stealth, record in `stealthUtxos[]`.

**Postconditions**
- Deposit outpoint exists and can later be imported.

### 4.6 Import deposit into a shard (single-shard update)

**Command:** `bchctl pool import [<outpoint> | --latest | --txid ...]`

**Preconditions**
- Pool is initialized (`categoryHex`, `redeemScriptHex`, shards exist).
- Selected `deposit` is unspent.
- Chosen shard is unspent and has valid commitment state.

**Transitions (on-chain)**
- Builds and broadcasts a covenant spend updating exactly **one** shard:
  - Inputs include shard UTXO and deposit UTXO (and optionally a fee input depending on mode)
  - Outputs include updated shard UTXO and any needed outputs

**Transitions (local state)**
- Marks deposit as imported (sets `importTxid`).
- Updates `shards[shardIndex]` to new outpoint and new `commitmentHex`.
- Marks stealth inputs as spent if a stealth UTXO was used as funding.

**Postconditions**
- Exactly one shard pointer is updated in the state file.
- The shard’s on-chain token commitment matches stored `commitmentHex`.

### 4.7 Withdraw from a shard (single-shard withdrawal)

**Command:** `bchctl pool withdraw <dest> <sats> [--shard i]`

**Supported destinations**
- **Paycode (PM...)** → withdraw to a new RPA/stealth P2PKH (preferred)
- Cashaddr (P2PKH) → transparent withdraw (optional / less private)

**Preconditions**
- Pool is initialized.
- Chosen shard has sufficient value.
- **Phase 2 constraint:** withdraw uses **one shard only**.
  - If `feeMode=from-shard`, shard must cover `payment + fee`.
  - If `feeMode=external`, shard must cover `payment` and remainder must satisfy shard dust rules.

**Transitions (on-chain)**
- Builds and broadcasts a covenant spend updating **one** shard.
- Outputs include:
  - recipient output (stealth or base)
  - updated shard output (new commitment + remainder)
  - optional external-fee change outputs (may be stealth change)

**Transitions (local state)**
- Updates shard pointer and commitment.
- Records withdrawal in `withdrawals[]`.
- Records derived stealth change (if external-fee mode produced change).

**Postconditions**
- Recipient can discover the received stealth output via scan.
- Exactly one shard pointer updated.

---

## 5. Core invariants

### 5.1 Shard correctness
For each shard entry:
- Stored `commitmentHex` MUST equal the on-chain NFT commitment in the shard’s token prefix.
- Stored `txid:vout` MUST reference an unspent output (verified during preflight tools).

### 5.2 Value accounting
- `sum(shards.valueSats)` equals the wallet’s expected pool total, minus withdrawals plus imports.
- Local state may become stale if on-chain spends occur outside the CLI; chain checks are used to detect and reconcile.

### 5.3 Dust constraints
There are multiple dust thresholds:
- Standard BCH P2PKH dust (`DUST`, often ~546).
- Pool shard dust (`POOL_DUST_SATS` in `@bch-stealth/pool-shards`).
- Covenant-specific “remainder policy” may enforce `remainder >= shardDust` OR allow special cases.

**Important:** Phase 2 currently enforces shard remainder rules that may cause:
- inability to withdraw amounts that leave remainder below shard dust
- inability to withdraw amounts that leave remainder exactly zero (if the covenant requires keeping a shard output)

### 5.4 Single-shard limitation (Phase 2)
- Withdraw and import update one shard per transaction.
- Arbitrary “withdraw 50% of pool” is not supported unless one shard has enough value.
- This is a known limitation and planned for Phase 3.

---

## 6. Known limitations & next-phase requirements

### 6.1 Multi-shard withdrawals (planned)
To support arbitrary withdrawal sizes:
- Select **multiple** shard inputs.
- Aggregate their value.
- Produce a single withdrawal output to recipient.
- Produce updated shard outputs for **each** spent shard (or consolidate into fewer shards).
- Update multiple shard commitments in one transaction.

This is a larger covenant/state-machine extension, including:
- multi-input covenant verification logic
- consistent token/category rules across multiple shard inputs
- coherent “next-state” commitments per shard

### 6.2 Consolidation / rebalancing (planned)
A “consolidator” could:
- spend multiple shards to produce fewer, larger shards
- rebalance shard values to minimize dust/trapped value
- improve usability for withdrawals

Requires:
- deterministic selection policies
- privacy-aware spending strategies (avoid obvious linkage)

### 6.3 Init funding vout=0 requirement
Currently the demo requires the init funding outpoint to be `vout=0` to satisfy category genesis rule in this design.
A future improvement could:
- explicitly create a controlled `vout=0` “genesis funding” via a preparatory transaction
- provide a `pool bootstrap` helper command that guarantees a `vout=0` funding UTXO and records it

---

## 7. Privacy considerations

Funding via stealth protects:
- linkage between a transparent base wallet and the pool’s initial shard creation.

It does NOT fully hide:
- that these outputs are “pool shards” if the covenant script/pattern is distinctive.

Recommended mitigations:
- minimize unique transaction structure patterns
- avoid unique OP_RETURN usage
- keep outputs resembling normal-looking scripts where possible (within covenant constraints)

---

## 8. Operational guidance (Phase 2)

### 8.1 To create a usable pool
Pick shard parameters such that a single shard can satisfy typical withdrawals:
- Example: 8 shards × 100,000 sats each → pool total 800,000 sats
- A single-shard withdraw of 50,000 sats becomes possible

### 8.2 To withdraw successfully (current constraint)
- Withdraw must fit **within one shard**.
- If using `fee-from-shard`, ensure `payment + fee <= shard.value`.
- If using `external fee`, ensure remainder policy allows the remainder value produced.

---

## 9. Appendix: State transitions summary

| Operation | On-chain TX | Local state updates | Shards updated |
|---|---:|---|---:|
| scan --update-state | no | adds `stealthUtxos` | 0 |
| pool init | yes | sets pool fields, sets all `shards[]` | N (new pointers) |
| pool stage-from | no | adds `deposits[]` | 0 |
| pool stage | yes | adds `deposits[]`, possibly `stealthUtxos[]` change | 0 |
| pool import | yes | marks deposit imported, updates one shard pointer/commitment | 1 |
| pool withdraw | yes | updates one shard, records `withdrawals[]`, optional change records | 1 |

---

## 10. Terms

- **Paycode / RPA**: reusable payment identifier; receiver derives one-time addresses per spend.
- **Shard**: a covenant-locked tokenized UTXO representing one state cell of the pool.
- **Commitment**: 32-byte value stored as NFT commitment; represents shard state.
- **Pool state file**: local JSON tracking shard outpoints, commitments, and discovered stealth UTXOs.
