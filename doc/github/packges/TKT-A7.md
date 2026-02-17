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