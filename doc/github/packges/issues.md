# Monorepo Build Completion — Issue Plan (ordered by dependency)

Repo context:
- Yarn v4 monorepo with workspaces `packages/*` and root `build/typecheck` scripts  [oai_citation:8‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)
- Key packages present: electrum, rpa*, pool-*, demo-*  [oai_citation:9‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)

> NOTE: Several packages currently reference the `@bch/*` scope (e.g. `@bch/electrum`, `@bch/utils`, `@bch/tx-builder`)  [oai_citation:10‡repomix-output.md](sediment://file_0000000093f471f58eda7a090c039b4d). If the repo’s intended scope is `@bch-stealth/*`, standardize that early because `demo-cli` imports these packages  [oai_citation:11‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3).

---

## Issue 1 — Standardize package scopes + workspace deps (global)
**User story:** As a maintainer, I want all workspace package names and inter-package dependencies to use a single consistent scope, so builds resolve correctly across the monorepo.

**Why now:** Multiple packages currently declare `@bch/*` in `package.json` (e.g., `electrum` depends on `@bch/utils`)  [oai_citation:12‡repomix-output.md](sediment://file_0000000093f471f58eda7a090c039b4d) and `demo-cli` imports `@bch/*` packages  [oai_citation:13‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3).

**Work plan:**
- Decide target scope (likely `@bch-stealth/*` based on existing workspace usage).
- Update each `packages/*/package.json`:
  - `"name"` to correct scope.
  - internal `"dependencies"` to correct scope.
- Update all source imports accordingly.
- Run `yarn install` and `yarn build` at root.

**Acceptance criteria:**
- Root `yarn build` succeeds  [oai_citation:14‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)
- No package imports stale scope in source or package.json.

**Depends on:** none.

---

## Issue 2 — Electrum package builds clean + exports stable API
**User story:** As a developer, I want `@…/electrum` to compile cleanly and export a stable client/API so downstream packages can fetch UTXOs/tx details and subscribe to headers.

**Current clues:**
- `electrum/src/index.ts` re-exports `./electrum.js`  [oai_citation:15‡repomix-output.md](sediment://file_0000000093f471f58eda7a090c039b4d)
- `electrum/src/electrum.ts` imports `@electrum-cash/network` and local `./utils.js` / `./cashaddr.js`  [oai_citation:16‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)
- `electrum/package.json` currently named `@bch/electrum` and depends on `@bch/utils`  [oai_citation:17‡repomix-output.md](sediment://file_0000000093f471f58eda7a090c039b4d)

**Work plan:**
- Fix scope + deps as per Issue 1 (if not already done).
- Replace any local `./utils.js` import with workspace utils package (or move required helpers into electrum).
- Ensure `cashaddr` dependency is correctly imported (either from utils or packaged in electrum).
- Confirm TS config output in `dist/` and `exports` map works for NodeNext/ESM  [oai_citation:18‡repomix-output.md](sediment://file_0000000093f471f58eda7a090c039b4d)
- Add a minimal smoke test script (optional) that:
  - connects to chipnet server (wss),
  - calls `blockchain.headers.subscribe`,
  - disconnects.

**Acceptance criteria:**
- `yarn workspace <electrum> run build` succeeds.
- Typecheck succeeds.
- Downstream compilation can import `* as Electrum from '@…/electrum'` (as demo-cli does today)  [oai_citation:19‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)

**Depends on:** Issue 1.

---

## Issue 3 — RPA Derivation package build + types
**User story:** As a developer, I want `rpa-derive` to build cleanly and expose typed derivation helpers for stealth/RPA address derivation.

**Work plan:**
- Fix scope + deps (Issue 1).
- Ensure TS build emits `dist/*.d.ts` correctly.
- Ensure exports from `src/index.ts` point to the right ESM files.

**Acceptance criteria:**
- Workspace build succeeds for rpa-derive.
- Consumers can import derivation helpers without TS path hacks.

**Depends on:** Issue 1.

---

## Issue 4 — RPA Scan package build + stable inputs/outputs
**User story:** As a developer, I want `rpa-scan` to build cleanly and provide scan helpers for raw tx / chain window scanning.

**Work plan:**
- Fix scope + deps (Issue 1).
- Make sure any electrum usage relies on the workspace electrum package.
- Ensure exported types are stable.

**Acceptance criteria:**
- `rpa-scan` builds + typechecks.
- No circular dependency with electrum.

**Depends on:** Issues 1–2.

---

## Issue 5 — RPA umbrella package exports `derive` + `scan`
**User story:** As a developer, I want `@…/rpa` to present a simple import surface that re-exports derivation + scanning.

**Why:** `demo-cli` imports from `@bch/rpa` today  [oai_citation:20‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)

**Work plan:**
- Fix scope + deps (Issue 1).
- Ensure `rpa/src/index.ts` re-exports `derive.ts` and `scan.ts` cleanly.
- Ensure rpa depends on `rpa-derive` and `rpa-scan` via workspace deps.

**Acceptance criteria:**
- `import { deriveRpaLockIntent } from '@…/rpa'` works (demo-cli expectation)  [oai_citation:21‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)
- Workspace build succeeds.

**Depends on:** Issues 1, 3, 4.

---

## Issue 6 — Pool Hash-Fold package scope/deps + build verification
**User story:** As a developer, I want `pool-hash-fold` to build cleanly and correctly depend on tx-builder + utils as a workspace library.

**Current clue:** pool-hash-fold depends on `@bch/tx-builder` and `@bch/utils`  [oai_citation:22‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)

**Work plan:**
- Fix scope + deps (Issue 1).
- Run build and resolve any path/import mismatches.
- Ensure exports in `src/index.ts` remain correct.

**Acceptance criteria:**
- `pool-hash-fold` builds and typechecks.
- Downstream can `import * as PoolHashFold from '@…/pool-hash-fold'` (demo-cli)  [oai_citation:23‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)

**Depends on:** Issue 1 (and tx-builder already clean from prior work).

---

## Issue 7 — Pool Shards: implement scaffolding functions
**User story:** As a developer, I want `pool-shards` to implement `initShards`, `importDepositToShard`, and `withdrawFromShard` so the demo can run end-to-end.

**Current clue:** these functions currently throw “not implemented yet”  [oai_citation:24‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3) and explicitly mention wiring to tx-builder/electrum/pool-hash-fold  [oai_citation:25‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3).

**Work plan:**
- Define the minimal `demo-state` interface required by pool-shards (or accept a simple JSON store first).
- Implement:
  - `initShards`: create N shard UTXOs / state anchors, returning a PoolState
  - `importDepositToShard`: spend deposit + shard UTXO, update state token commitment
  - `withdrawFromShard`: spend shard UTXO, update commitment, emit payment output
- Ensure it uses:
  - electrum for UTXO lookup / broadcast,
  - tx-builder for tx construction/signing,
  - pool-hash-fold for covenant-related ops.

**Acceptance criteria:**
- No “not implemented yet” throws remain for these core paths  [oai_citation:26‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)
- Builds + typechecks.

**Depends on:** Issues 2, 5, 6.

---

## Issue 8 — Demo State package: formalize storage contract used by demo + shards
**User story:** As a developer, I want `demo-state` to provide a simple state persistence interface so `demo-cli` can reliably store/load pool state.

**Work plan:**
- Define state schema + serialization rules.
- Provide a thin file-backed implementation for CLI use.

**Acceptance criteria:**
- `demo-state` builds and exports a small stable API.
- pool-shards can optionally accept this interface (see Issue 7).

**Depends on:** Issue 1 (and ideally before finishing Issue 7).

---

## Issue 9 — Demo CLI: get `demo_sharded_pool` running end-to-end
**User story:** As a user, I want `demo-cli` to run `init/deposit/import/withdraw` flows end-to-end on chipnet.

**Current clue:** demo-cli imports RPA + Electrum + TxBuilder + PoolHashFold  [oai_citation:27‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3) and documents the intended flow in comments  [oai_citation:28‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3).

**Work plan:**
- Fix scope imports (Issue 1).
- Replace any placeholder implementations with pool-shards + demo-state.
- Add clear CLI error messages + logging.
- Add a “happy path” documented command that works.

**Acceptance criteria:**
- `node src/demo_sharded_pool.js run --shards N --deposit X --withdraw Y` works per the documented usage  [oai_citation:29‡repomix-output.md](sediment://file_0000000042a8722fa3fb184be771e9a3)
- Builds + typechecks.

**Depends on:** Issues 2, 5, 6, 7, 8.