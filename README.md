# Bitcoin Cash Stealth Demo (Phase 2)

> **Status:** Phase 2 demo codebase (Chipnet).  
> **Focus:** Paycode/RPA-style stealth sends + local sharded state pool (deposit/import/withdraw) + covenant tooling.  
> **Audience:** Wallet devs and protocol tinkerers who want a working end-to-end demo they can run locally.

## What this repo is

This repository is a **monorepo** (Yarn workspaces) containing:

- **CLI (`bchctl`)**: initialize wallets, send via paycode, scan for inbound stealth outputs, stage deposits, import into the sharded pool, and withdraw.
- **Electron GUI**: a UX wrapper over the CLI to demonstrate the Phase 2 flows.
- **Libraries**: reusable packages for RPA derivation, scanning, Electrum/Fulcrum IO, pool-shard covenant logic, and on-chain script building.

## Why a “local pool” exists in Phase 2

Phase 2 introduces a **wallet-owned sharded pool** (a local state machine enforced by on-chain covenants):

- **Ingress policy**: the wallet can insist that inbound value is first received to a **paycode-derived** P2PKH output (stealth), then *optionally* promoted into the pool.
- **Internal routing**: once value is in the pool, the wallet can move it through a predictable state machine (shards + commitments) without a third-party mixer or custodian.
- **Stable anchors**: each shard’s **32-byte commitment** becomes a stable anchor for later features (proofs, policies, notes, etc.).

### How it expands in Phase 3

Phase 3 builds on the same shard commitments:

- **Multi-shard withdrawals / consolidation** (spend multiple shards in one tx, or consolidate shards to support larger withdrawals).
- **Richer state transitions** (more than “deposit/import/withdraw”).
- **Confidential proofs** (commitments act as anchors for amount/privacy proofs and policy enforcement).

## Why this matters for preserving Bitcoin as cash

“Cash” isn’t just fast settlement — it’s **permissionless and fungible**.

- **Fungibility requires privacy.** If observers can reliably link who paid whom (or build “taint” histories), coins become less interchangeable, businesses start risk-scoring UTXOs, and everyday payments get harder.
- **Surveillance becomes soft censorship.** Once identities and transaction graphs are easy to follow, it’s trivial to blacklist counterparties, discriminate by geography/industry, or pressure intermediaries to block payments.
- **Self-custody must stay usable.** The more privacy requires “special services” (mixing servers, custodians, trusted coordinators), the easier it is to regulate, degrade, or capture.

This Phase 2 demo targets wallet-native primitives:

- **Paycodes/RPA-style sends** keep receives **unlinkable** while remaining standard P2PKH outputs.
- A **local, wallet-owned sharded pool** lets wallets apply policy (what to accept, how to route/change) without asking users to “hand funds to a mixer”.
- The covenant + commitment model is designed to scale into Phase 3 privacy proofs while keeping the base layer auditable and compatible with everyday payments.

The goal is simple: keep Bitcoin Cash usable as **peer-to-peer electronic cash** — private enough to be fungible, and practical enough to be routine.

## Repo layout

- `packages/*` contains all workspaces (see per-package READMEs).
- `.bch-stealth/` is created locally and stores config + per-profile state files.

## Prerequisites

- Node.js (LTS recommended)
- Corepack (ships with modern Node)
- Yarn via Corepack (repo-tested on Yarn 4)
- A running **Chipnet Fulcrum/Electrum** endpoint (or whatever the repo defaults to)
- Chipnet test coins (faucet)

> If you see errors about “No funding UTXO available”, fund the printed **base P2PKH cashaddr** for that profile.

## Install

```bash
corepack enable
yarn install
yarn build
```

## Funding wallets (Chipnet faucet)

Use the Googol TBCH faucet:

- https://tbch.googol.cash/

Steps:

1. Set **Network** to **chipnet**.
2. Paste a **Chipnet P2PKH cashaddr** (the address printed by `bchctl addr`).
3. Solve the captcha and submit.

Get the address to paste:

```bash
yarn bchctl --profile alice addr
yarn bchctl --profile bob addr
```

Confirm funds arrived:

```bash
yarn bchctl --profile alice wallet utxos --json --include-unconfirmed
yarn bchctl --profile bob wallet utxos --json --include-unconfirmed
```

---

## CLI: create/init profiles and wallets

List profiles:

```bash
yarn bchctl profiles
```

Initialize wallets:

```bash
yarn bchctl --profile alice wallet init
yarn bchctl --profile bob wallet init
```

Show wallet addresses:

```bash
yarn bchctl --profile alice wallet show --json
yarn bchctl --profile bob wallet show --json
```

> **GUI note:** today, **wallet creation is CLI-only**. The GUI assumes the profile already has a wallet.

---

## CLI usability (end-to-end, validated on chipnet)

This section demonstrates the **Phase 2 “pool as a policy layer”** flow:

1) Alice funds and sends Bob a **stealth (paycode)** payment  
2) Bob scans inbound and records it  
3) Bob **imports to pool** and **withdraws to Alice paycode**  
4) Alice scans inbound and **imports to her pool**  

### 0) One-time: initialize pools for both profiles

`pool init` creates a *new pool instance* with **8 shards × 100,000 sats** (800k total).  
It is designed to be funded from a **vout=0** P2PKH outpoint (CashTokens category genesis requirement).

Initialize Bob’s pool:

```bash
yarn bchctl --profile bob pool init --fresh
yarn bchctl --profile bob pool shards
```

Initialize Alice’s pool:

```bash
yarn bchctl --profile alice pool init --fresh
yarn bchctl --profile alice pool shards
```

If init fails with a message like “requires spending a UTXO at vout=0”, create a new self-send (which produces a vout=0 payment output), scan it, and re-run init:

```bash
ALICE_PAYCODE="$(yarn bchctl --profile alice wallet paycode)"
yarn bchctl --profile alice send "$ALICE_PAYCODE" 900000 --all
yarn bchctl --profile alice scan --include-mempool --update-state
yarn bchctl --profile alice pool init --fresh
```

### 1) Alice → Bob: stealth send (pool bootstrap payment)

Recommended amount: **900,000 sats**.

```bash
BOB_PAYCODE="$(yarn bchctl --profile bob wallet paycode)"
yarn bchctl --profile alice send "$BOB_PAYCODE" 900000 --all
```

### 2) Bob scans inbound (records stealth UTXOs)

```bash
yarn bchctl --profile bob scan --include-mempool --update-state
yarn bchctl --profile bob wallet rpa-utxos --check-chain
```

### 3) Bob imports the received outpoint into his pool

Promote the discovered outpoint into staged deposits, then import it into a shard:

```bash
# pick an unspent outpoint from:
yarn bchctl --profile bob wallet rpa-utxos --check-chain

# stage it (replace <TXID:VOUT>)
yarn bchctl --profile bob pool stage-from <TXID:VOUT>

# import the latest staged deposit into the pool
yarn bchctl --profile bob pool import --latest
yarn bchctl --profile bob pool shards
```

> If you prefer an explicit outpoint, you can also pass `<txid:vout>` directly to `pool import` (see `pool import --help`).

### 4) Bob withdraws from pool → Alice paycode (stealth)

Optional (recommended for demos): use an external fee input so shard value isn’t reduced by fees:

```bash
export BCH_STEALTH_WITHDRAW_FEE_MODE=external
```

Preflight (no broadcast):

```bash
ALICE_PAYCODE="$(yarn bchctl --profile alice wallet paycode)"
yarn bchctl --profile bob pool withdraw-check "$ALICE_PAYCODE" 50000
```

Broadcast:

```bash
yarn bchctl --profile bob pool withdraw "$ALICE_PAYCODE" 50000
```

### 5) Alice scans inbound and imports the withdrawal into her pool

```bash
yarn bchctl --profile alice scan --include-mempool --update-state
yarn bchctl --profile alice wallet rpa-utxos --check-chain
```

Then stage and import the new unspent outpoint:

```bash
# pick the new unspent outpoint from:
yarn bchctl --profile alice wallet rpa-utxos --check-chain

yarn bchctl --profile alice pool stage-from <TXID:VOUT>
yarn bchctl --profile alice pool import --latest
yarn bchctl --profile alice pool shards
```

---

## Withdrawal limitations (important)

### Current limitation: **single-shard withdrawals**

Withdrawals currently spend **one shard**. If your value is spread across multiple shards, a single withdrawal may fail even if your pool total is high.

What this means for users:

- To withdraw `X` sats, you need **one shard** with at least `X + fee` (if fee-from-shard) or at least `X` (if using an external fee input).
- Default shards are **100,000 sats**, so keep withdrawals ≤ ~98,000 sats per shard unless using an external fee mode.

Planned next phase improvements:

- **Multi-shard withdraw** (aggregate multiple shard inputs into one tx)
- **Shard consolidation** (merge shards so larger withdrawals are possible)

---

## GUI: run the Electron app

Dev mode:

```bash
yarn workspace @bch-stealth/gui dev
```

Build:

```bash
yarn workspace @bch-stealth/gui build
```

## GUI walkthrough (mirrors the CLI flow)

> The GUI does **not** currently create wallets. Do `wallet init` for each profile using the CLI first.

### 0) Prepare
- Use the CLI to initialize wallets for `alice` and `bob`
- Fund base addresses using the Chipnet faucet

### 1) RPA Send tab (Alice)
- Paste Bob paycode
- Send **900000 sats**

### 2) RPA Scan tab (Bob)
- Click **Scan inbound** (writes discovered stealth UTXOs into Bob state)

### 3) Pool Init tab (Bob)
- Click **Init pool (fresh)**

### 4) Pool Import tab (Bob)
- Promote the inbound outpoint into deposits (**stage-from**)
- Import the staged deposit into a shard

### 5) Pool Withdraw tab (Bob)
- Withdraw to Alice paycode (default stealth)

### 6) RPA Scan tab (Alice)
- Scan inbound and confirm receipt

### 7) Pool Import tab (Alice)
- Promote the received outpoint into deposits (**stage-from**)
- Import into Alice’s pool

---

## Notes: state files

Each profile has its own state file at:

```
.bch-stealth/profiles/<profile>/state.json
```

- `scan --update-state` populates `stealthUtxos` (discovery)
- `pool stage-from <outpoint>` promotes an already-discovered stealth UTXO into `deposits`
- `pool deposits` reads staged deposits from state
- `pool import` spends a staged deposit into a covenant shard
- `pool shards --json` prints canonical shard pointers + values + commitments

## Developer docs

- **ProofBlob32 ABI (revised):** `proofblob32-abi-revised.md` (in this repo’s release artifacts)
- **Sharded pool state machine spec:** `sharded-pool-state-machine-spec.md` (release artifacts)
- **Public release checklist:** `docs/release/public-release-checklist.md`

## License

See `LICENSE`.
