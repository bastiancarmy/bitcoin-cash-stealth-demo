# @bch-stealth/pool-shards

Shard transaction builders and policy helpers for the sharded pool demo.

This package is intended to be used by an orchestration layer (e.g. a CLI) without requiring callers to read the implementation. Builders return:

- a tx object (`tx`) suitable for inspection/logging
- canonical raw tx bytes (`rawTx`) for broadcasting / hashing / tests
- `sizeBytes` for quick fee/logging (computed from `rawTx.length`)
- `diagnostics` (commitments, noteHash, selected shard index, policy defaults, etc.)
- updated state (`nextPoolState`), suitable for persistence by the caller

> Builders are deterministic and perform no network IO. Broadcasting is the caller’s responsibility.

---

## Exports

Core builders:

- `initShardsTx`
- `importDepositToShard`
- `withdrawFromShard`

Selection + policy primitives:

- `selectShardIndex`
- `outpointHash32`
- policy constants: `DEFAULT_POOL_HASH_FOLD_VERSION`, `DEFAULT_CATEGORY_MODE`, `DEFAULT_CAP_BYTE`, `DUST_SATS`

Types:

- `PoolState`, `ShardPointer`
- `PrevoutLike`, `WalletLike`
- result types: `InitShardsResult`, `ImportDepositResult`, `WithdrawResult`

---

## Result shapes (recommended usage)

All builders return:

- `tx: any`
- `rawTx: Uint8Array`
- `sizeBytes: number`
- `diagnostics: { ... }`
- `nextPoolState: PoolState`

`initShardsTx` additionally returns `poolState` as a backward-compatible alias of `nextPoolState`.

---

## Policy notes

### Category derivation (init)
`initShardsTx` currently derives the CashTokens category from the **funding txid only**:

- `category32 = deriveCategory32FromFundingTxidHex(funding.txid)`

This is intentionally stable for the demo, but differs from a full outpoint hash (txid+vout).

### Outpoint hash primitive
`outpointHash32(txidHex, vout)` computes:

- `sha256(reverseBytes(txid) || uint32le(vout))`

This is used for deposit note hashing and shard selection.

### Shard selection
Shard selection is deterministic:

- `selectShardIndex({ depositTxidHex, depositVout, shardCount })`
- convention: `outpointHash32(...)[0] % shardCount`

### Hash-fold v1.1 defaults
Import/withdraw state transitions use defaults (overridable per call):

- `DEFAULT_POOL_HASH_FOLD_VERSION` (currently v1.1)
- `DEFAULT_CATEGORY_MODE` (currently `'reverse'` in this demo)
- `DEFAULT_CAP_BYTE` (currently `0x01`)

---

## Examples

### 1) Init shards (build tx + state)

```ts
import { initShardsTx } from '@bch-stealth/pool-shards';

const res = initShardsTx({
  cfg: {
    network: 'chipnet',
    poolIdHex: '11'.repeat(20),   // 20-byte hex
    poolVersion: 'v1',
    shardValueSats: '2000',
    defaultFeeSats: '2000',
  },
  shardCount: 4,
  funding: {
    txid: 'aa'.repeat(32),
    vout: 0,
    valueSats: 20_000n,
    scriptPubKey: new Uint8Array(/* funding P2PKH spk */),
  },
  ownerWallet: {
    signPrivBytes: new Uint8Array(32), // example only
    pubkeyHash160Hex: '22'.repeat(20), // owner change address hash160
  },
});

console.log(res.sizeBytes, res.diagnostics.category32Hex);

// broadcast this:
const raw = res.rawTx;

// persist this:
const next = res.nextPoolState;
```

### 2) Import a deposit into a shard

```ts
import { importDepositToShard } from '@bch-stealth/pool-shards';

const res = importDepositToShard({
  pool,                // PoolState (categoryHex, redeemScriptHex, shards[])
  shardIndex: 0,

  shardPrevout: {
    txid: pool.shards[0].txid,
    vout: pool.shards[0].vout,
    valueSats: BigInt(pool.shards[0].valueSats),

    // MUST be the full previous output scriptPubKey (including token prefix if present)
    scriptPubKey: new Uint8Array(/* token+p2sh scriptPubKey */),
  },

  depositPrevout: {
    txid: 'bb'.repeat(32),
    vout: 1,
    valueSats: 50_000n,
    scriptPubKey: new Uint8Array(/* depositor P2PKH spk */),
  },

  ownerWallet: {
    signPrivBytes: new Uint8Array(32), // example only
    pubkeyHash160Hex: '22'.repeat(20),
  },

  feeSats: 2000n,
  categoryMode: 'reverse',
  amountCommitment: 0n,
});

console.log(res.diagnostics.noteHash32Hex, res.diagnostics.stateOut32Hex);
```

### 3) Withdraw from a shard (payment + updated shard)

```ts
import { withdrawFromShard } from '@bch-stealth/pool-shards';

const res = withdrawFromShard({
  pool,
  shardIndex: 0,

  shardPrevout: {
    txid: pool.shards[0].txid,
    vout: pool.shards[0].vout,
    valueSats: BigInt(pool.shards[0].valueSats),

    // MUST be the full previous output scriptPubKey (including token prefix if present)
    scriptPubKey: new Uint8Array(/* token+p2sh scriptPubKey */),
  },

  feePrevout: {
    txid: 'cc'.repeat(32),
    vout: 0,
    valueSats: 10_000n,
    scriptPubKey: new Uint8Array(/* sender fee P2PKH spk */),
  },

  senderWallet: {
    signPrivBytes: new Uint8Array(32), // example only
    pubkeyHash160Hex: '33'.repeat(20),
  },

  receiverP2pkhHash160Hex: '44'.repeat(20),
  amountSats: 1000n,

  feeSats: 2000n,
  categoryMode: 'reverse',
  amountCommitment: 0n,
});

console.log(res.sizeBytes, res.diagnostics.noteHash32Hex);
```

---

## Tests

```bash
yarn workspace @bch-stealth/pool-shards test
```
