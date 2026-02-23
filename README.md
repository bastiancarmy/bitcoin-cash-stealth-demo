# Bitcoin Cash Stealth Demo (Phase 2)

> **Status:** Phase 2 demo codebase (Chipnet).  
> **Focus:** Paycode/RPA-style stealth sends + local sharded state pool (deposit/import/withdraw) + covenant tooling.  
> **Audience:** Wallet devs and protocol tinkerers who want a working end-to-end demo they can run locally.

## What this repo is

This repository is a **monorepo** (Yarn workspaces) containing:

- **CLI (`bchctl`)**: initialize wallets, send via paycode, scan for inbound stealth outputs, stage deposits, import into the sharded pool, and withdraw.
- **Electron GUI**: a UX wrapper over the CLI to demonstrate the Phase 2 flows.
- **Libraries**: reusable packages for RPA derivation, scanning, Electrum/Fulcrum IO, pool-shard covenant logic, and on-chain script building.

### Quick demo flow (Chipnet)

1. **Initialize two profiles** (e.g. `bob` and `alice`).
2. Fund the **base P2PKH address** for each profile on Chipnet.
3. From Bob → send to Alice paycode (**stealth send**).
4. On Alice → **scan inbound** to record stealth UTXOs in state.
5. On Alice → **stage-from** the discovered outpoint(s) into `state.deposits`.
6. On Alice → **pool import** deposits into a shard (token/covenant spend).
7. Withdraw from pool → paycode (stealth) or cashaddr (transparent, optional).

## Repo layout

- `packages/*` contains all workspaces (see per-package READMEs).
- `.bch-stealth/` is created locally and stores config + per-profile state files.

## Prerequisites

- Node.js (LTS recommended)
- Yarn (classic or Berry per your repo config)
- A running **Chipnet Fulcrum/Electrum** endpoint (or whatever the repo defaults to)
- Chipnet test coins (faucet)

> If you see errors about “No funding UTXO available”, fund the printed **base P2PKH cashaddr** for that profile.

## Install

```bash
yarn install
yarn build
```

## CLI: create/init profiles and wallet

List profiles:

```bash
yarn bchctl profiles
```

Initialize a wallet for a profile:

```bash
yarn bchctl --profile alice wallet init
yarn bchctl --profile bob wallet init
```

Show wallet addresses:

```bash
yarn bchctl --profile alice wallet show --json
yarn bchctl --profile bob wallet show --json
```

Fund each profile’s **base P2PKH address** on Chipnet (faucet), then confirm:

```bash
yarn bchctl --profile alice wallet utxos --json --include-unconfirmed
yarn bchctl --profile bob wallet utxos --json --include-unconfirmed
```

## GUI: run the Electron app

Dev mode:

```bash
yarn workspace @bch-stealth/gui dev
```

Build:

```bash
yarn workspace @bch-stealth/gui build
```

### GUI walkthrough (recommended)

**RPA Send tab (Bob):**

- Paste Alice paycode
- Send some sats

**RPA Scan tab (Alice):**

- Click **Scan inbound** (writes discovered stealth UTXOs into Alice state)

**Pool Import tab (Alice):**

- Click **Scan inbound / promote** (stages new RPA outpoints into deposits)
- Then **Deposit** (imports staged deposit into a shard)

**Pool Withdraw tab (Alice):**

- Withdraw to a paycode (default stealth)  
- Or enable “allow transparent” to withdraw to cashaddr

## Notes: state files

Each profile has its own state file at roughly:

```
.bch-stealth/profiles/<profile>/state.json
```

- `scan --update-state` populates `stealthUtxos` (discovery)
- `pool stage-from <outpoint>` promotes an already-discovered stealth UTXO into `deposits`
- `pool deposits` reads staged deposits from state
- `pool import` spends a staged deposit into the covenant shard

## Developer docs

- **ProofBlob32 ABI + integration guide:** see `docs/abi/proofblob32.md`
- **Public release checklist + branch protection:** see `docs/release/public-release-checklist.md`

## License

TBD (choose a license before publishing).
