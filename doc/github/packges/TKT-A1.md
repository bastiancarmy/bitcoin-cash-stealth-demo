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