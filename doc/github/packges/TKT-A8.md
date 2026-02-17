## Issue 8 — Demo State package: formalize storage contract used by demo + shards
**User story:** As a developer, I want `demo-state` to provide a simple state persistence interface so `demo-cli` can reliably store/load pool state.

**Work plan:**
- Define state schema + serialization rules.
- Provide a thin file-backed implementation for CLI use.

**Acceptance criteria:**
- `demo-state` builds and exports a small stable API.
- pool-shards can optionally accept this interface (see Issue 7).

**Depends on:** Issue 1 (and ideally before finishing Issue 7).