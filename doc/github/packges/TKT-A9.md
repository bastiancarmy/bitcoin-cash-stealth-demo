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