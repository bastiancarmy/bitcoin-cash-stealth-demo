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