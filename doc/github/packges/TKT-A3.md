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