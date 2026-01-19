# Pool State Schema (Canonical)

## Version
- `schemaVersion: 1`

## Purpose
This file defines the canonical Pool State contract shared by:
- `@bch-stealth/pool-shards` (builders, state transitions)
- `@bch-stealth/pool-state` (persistence, migrations, future repair/reconstruction)

## Canonical key
Pool state is stored under:
- `pool.state`

Legacy keys supported for migration:
- `pool.shardedPool`
- `demo.shardedPool`

## PoolState v1
Required fields:
- `schemaVersion: 1`
- `network: string`
- `poolIdHex: string`
- `poolVersion: string`
- `categoryHex: string` (32-byte hex)
- `redeemScriptHex: string` (hex)
- `shardCount: number`
- `shards: ShardPointer[]`

Optional operational history (append-only):
- `deposits?: DepositRecord[]`
- `withdrawals?: WithdrawalRecord[]`
- `stealthUtxos?: StealthUtxoRecord[]`

Optional metadata:
- `createdAt?: string`
- `repairedAt?: string`

## ShardPointer
- `index: number`
- `txid: string`
- `vout: number`
- `valueSats: string` (stringified bigint sats)
- `commitmentHex: string` (32-byte hex)

## Migration rules (legacy -> v1)
- Ensure `schemaVersion` is set to `1`.
- If `shardCount` is missing, set `shardCount = shards.length`.
- If shard pointer uses `value`, map to `valueSats`.
- Preserve unknown legacy fields (do not delete); if needed, store full legacy payload separately.

## Deterministic reconstruction intent (future)
Reconstruction/repair will aim to:
- locate shard UTXOs by `(token categoryHex + redeemScriptHex)`
- identify stealth outputs via RPA scanning of chain history
- rebuild `shards[]` pointers and optional history arrays from chain data