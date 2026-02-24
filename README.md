# Bitcoin Cash Stealth Demo (Phase 2)

> **Status:** Phase 2 demo codebase (Chipnet).  
> **Focus:** Paycode/RPA-style stealth sends + local sharded state pool (deposit/import/withdraw) + covenant tooling.  
> **Audience:** Wallet devs and protocol tinkerers who want a working end-to-end demo they can run locally.

---

## What this repo is

This repository is a **monorepo** (Yarn workspaces) containing:

- **CLI (`bchctl`)**: initialize wallets, send via paycode, scan for inbound stealth outputs, stage deposits, import into the sharded pool, and withdraw.
- **Electron GUI**: a UX wrapper over the CLI to demonstrate Phase 2 flows.
- **Libraries**: reusable packages for RPA derivation/scanning, Electrum/Fulcrum IO, pool-shard covenant logic, and on-chain script building.

### What “stealth” means here

- A **paycode send** creates a **paycode-derived P2PKH output** (“RPA-style stealth output”).
- The receiver uses **scan** (via Fulcrum’s RPA index) to discover and record those outputs into their local `state.json`.
- The pool is a **local, wallet-owned sharded state machine**: shards are covenant UTXOs (CashTokens + commitment) controlled by the wallet. Funding the pool from stealth helps avoid linking the owner’s transparent wallet to pool genesis.

---

## Repo layout

- `packages/*` contains all workspaces (see per-package READMEs).
- `.bch-stealth/` is created locally and stores config + per-profile state files:
  - `.bch-stealth/config.json`
  - `.bch-stealth/profiles/<profile>/state.json`
  - `.bch-stealth/profiles/<profile>/events.ndjson`

---

## Prerequisites

- Node.js (LTS recommended)
- Yarn
- Chipnet Electrum/Fulcrum endpoint (repo defaults are set for Chipnet)
- Chipnet test coins (faucet)

> If you see errors about **“No funding UTXO available”**, fund the printed **base P2PKH cashaddr** for that profile.

---

## Install

```bash
yarn install
yarn build
```

---

## IMPORTANT limitations (current phase)

### 1) Pool withdraw is currently single-shard only
**Withdraw currently spends from a single shard input only.**  
That means:

- If your pool value is spread across shards, you **cannot withdraw an arbitrary amount** unless **one shard** contains enough to cover:
  - `payment` + (fee if fee-from-shard mode), or
  - `payment` (if external fee mode), plus shard remainder rules.

**User guidance:**
- Keep shard values large enough for your intended demo withdrawals.
- Default demo configuration uses **8 shards × 100,000 sats = 800,000 sats total**.
- Recommended withdrawal size: **≤ 50,000 sats** (comfortably within a single 100k shard).

**Next phase work:** implement either
- multi-shard withdrawals (aggregate multiple shard inputs), or
- a safe “consolidator” transaction that merges shards.

### 2) Pool init requires a vout=0 funding UTXO (CashTokens category genesis rule)
Pool init **must** spend a UTXO where `vout=0`. If your funding UTXO is at `vout=1` (common for change), init will fail with:

> “CashTokens category genesis requires spending a UTXO at vout=0…”

**Fix:** create a fresh funding UTXO that is unspent at `vout=0` (stealth or base), then retry.

### 3) GUI wallet creation (current status)
If your GUI build does not expose “Init wallet”, you must create wallets via the CLI first:
```bash
yarn bchctl --profile alice wallet init
yarn bchctl --profile bob wallet init
```

---

## CLI: create/init profiles and wallet

List profiles:
```bash
yarn bchctl profiles
```

Initialize wallets:
```bash
yarn bchctl --profile alice wallet init
yarn bchctl --profile bob wallet init
```

Show wallet info:
```bash
yarn bchctl --profile alice wallet show --json
yarn bchctl --profile bob wallet show --json
```
Fund wallet:
```bash
This demo runs on Chipnet, so you’ll need some test BCH (tBCH) to pay fees and bootstrap pool operations.
- Open the faucet:
- https://tbch.googol.cash/
- In the GUI (or CLI), copy the profile’s base P2PKH cashaddr:
```
Confirm Funds:
```bash
yarn bchctl --profile alice wallet utxos --json --include-unconfirmed
yarn bchctl --profile bob wallet utxos --json --include-unconfirmed
```

---

## CLI: validated end-to-end flow (Alice funds Bob stealth → Bob pool init → Bob withdraw → Alice receives)

This is the “known good” demo path on Chipnet with shard defaults:
- `SHARD_VALUE = 100000 sats`
- `DEFAULT_FEE = 2000 sats`
- `shards = 8` (total ≈ 800,000 sats)

### 1) Alice sends Bob a stealth payment (for pool funding)
```bash
BOB_PAYCODE="$(yarn bchctl --profile bob wallet paycode)"
yarn bchctl --profile alice send "$BOB_PAYCODE" 900000 --all
```

### 2) Bob scans inbound and records stealth UTXOs to state
```bash
yarn bchctl --profile bob scan --include-mempool --update-state
yarn bchctl --profile bob wallet rpa-utxos --check-chain
```

### 3) Bob initializes pool from stealth (fresh pool instance)
```bash
yarn bchctl --profile bob pool init --fresh
yarn bchctl --profile bob pool shards
```

You should see ~800,000 sats across 8 shards (100,000 each).

### 4) Bob withdraws from pool back to Alice paycode
> **Note:** withdraw is single-shard only. Use a value that comfortably fits within one shard (e.g. 50,000 sats).

```bash
ALICE_PAYCODE="$(yarn bchctl --profile alice wallet paycode)"
yarn bchctl --profile bob pool withdraw-check "$ALICE_PAYCODE" 50000
yarn bchctl --profile bob pool withdraw "$ALICE_PAYCODE" 50000
```

### 5) Alice scans inbound to receive the withdrawal stealth output
```bash
yarn bchctl --profile alice scan --include-mempool --update-state
yarn bchctl --profile alice wallet rpa-utxos --check-chain
```

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

---

## GUI walkthrough (recommended)

> If the GUI build you’re using doesn’t have “Init wallet”, do wallet init via CLI first (see above).

### 1) Profiles
- Create/select profiles `alice` and `bob` (top dropdown).

### 2) Fund Alice base address
- Select `alice`
- Copy base P2PKH address from Gauges
- Fund via Chipnet faucet
- Refresh gauges until UTXO appears

### 3) Alice → Bob (RPA send)
- Select `bob`, copy Bob paycode (PM…)
- Select `alice` → **RPA send**
  - Paste Bob paycode
  - Send **900,000 sats**
  - Confirm tx appears in Log

### 4) Bob scan inbound
- Select `bob` → **RPA scan**
  - Enable **include mempool**
  - Enable **update state**
  - Scan inbound
  - Confirm stealth UTXOs increase

### 5) Bob pool init (fresh)
- Select `bob` → **Pool init**
  - Click **Init pool (fresh)** (or equivalent)
  - If you hit the vout=0 error:
    - Create a fresh vout=0 funding UTXO (self-send), scan, then retry init (or do it via CLI)

### 6) Verify shards
- Select `bob` → **Pool init**
  - Refresh shards
  - Confirm 8 shards and total ~800,000 sats

### 7) Withdraw from pool → Alice paycode
- Select `alice`, copy Alice paycode
- Select `bob` → **Pool withdraw**
  - Paste Alice paycode
  - Withdraw-check 50,000 sats
  - Withdraw 50,000 sats

### 8) Alice scans inbound to receive
- Select `alice` → **RPA scan**
  - include mempool + update state
  - scan inbound
  - confirm receipt recorded

---

## Notes: state files

Each profile stores state at:
```
.bch-stealth/profiles/<profile>/state.json
```

Key state sections:
- `stealthUtxos`: discovered/recorded paycode-derived outputs
- `deposits`: staged deposits
- `shards`: the pool shard outpoints + commitments
- `withdrawals`: recorded withdrawals + rpa context

---

## Next phase roadmap (high priority)

### A) Multi-shard withdraw / consolidation
Fix the current usability limitation where withdraw requires a single shard to have enough value.

Approaches:
- **Multi-input withdraw:** select multiple shard inputs, aggregate value, update multiple shard commitments.
- **Consolidator tx:** spend multiple shards → one shard (or fewer shards), then withdraw from the consolidated shard.

### B) Make pool init smoother in GUI
- Automatically create/ensure a vout=0 funding UTXO when init fails (guided flow).

---

## License
TBD (choose a license before publishing).
