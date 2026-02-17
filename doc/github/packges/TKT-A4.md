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
