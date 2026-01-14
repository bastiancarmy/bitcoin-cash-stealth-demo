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