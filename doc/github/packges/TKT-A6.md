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