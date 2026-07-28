# Stage 2 analysis-history receipt

Status: **CAPTURE COMPLETE · CONTENT VERIFIED · ANALYSIS ONLY · COST INVALID**

Captured: 2026-07-28  
Whole-config version at capture: `f58ba49db649`

## Guard and identity

| Field | Recorded value |
|---|---|
| Account | `1100509764` |
| Server | `JustMarkets-Demo2` |
| Account mode | `DEMO` |
| Requested range | `[2025-07-28T00:00:00Z, 2026-07-28T00:00:00Z)` |
| Raw timeframes | `H1`, `M15` |
| Store type | `MDTALPHAFX_STAGE2_ANALYSIS_ONLY_PARQUET` |
| Store format | `1` |
| `analysis_only` | `true` |
| `cost_valid` | `false` |
| Capture status | `COMPLETE` |
| Capture complete | `true` |
| Root | `data/stage2-history-20260728/analysis-only-cofire/` |

The recorder hard-refused non-DEMO use. The store is not a `BarSource`, exposes
no M1/replay/cost interface, and cannot substitute for `ParquetBarStore`.
`ReplayEngine` also refuses any source declaring `analysis_only=true` or
`cost_valid=false` before attempting replay. The earlier strict partial capture
remains untouched beside this isolated subdirectory.

## Captured series

| Symbol | Timeframe | Bars | First UTC open | Last UTC open | Availability gaps |
|---|---:|---:|---|---|---:|
| `XAUUSD.m` | H1 | 5,911 | 2025-07-28 00:00 | 2026-07-27 23:00 | 258 |
| `XAUUSD.m` | M15 | 23,628 | 2025-07-28 00:00 | 2026-07-27 23:45 | 261 |
| `EURUSD.m` | H1 | 6,213 | 2025-07-28 00:00 | 2026-07-27 23:00 | 55 |
| `EURUSD.m` | M15 | 24,849 | 2025-07-28 00:00 | 2026-07-27 23:45 | 57 |
| `GBPUSD.m` | H1 | 6,213 | 2025-07-28 00:00 | 2026-07-27 23:00 | 55 |
| `GBPUSD.m` | M15 | 24,849 | 2025-07-28 00:00 | 2026-07-27 23:45 | 57 |
| `BTCUSD.m` | H1 | 8,759 | 2025-07-28 00:00 | 2026-07-27 23:00 | 1 |
| `BTCUSD.m` | M15 | 35,025 | 2025-07-28 00:00 | 2026-07-27 23:45 | 6 |
| **Total** | **H1** | **27,096** |  |  | **369** |
| **Total** | **M15** | **108,351** |  |  | **381** |

Each gap is stored as a canonical half-open UTC interval plus an exact missing
slot count. The manifest deliberately labels these intervals
`NO_BAR_OBSERVED; NOT CLASSIFIED AS MARKET_CLOSED_OR_MISSING`; it does not
pretend to own a broker trading calendar.

## Preserved nonpositive spread

Eight broker-supplied zero-spread rows were retained exactly:

| Symbol | Timeframe | UTC open | Spread |
|---|---|---|---:|
| `GBPUSD.m` | H1 | 2025-10-30 13:00 | 0 |
| `GBPUSD.m` | H1 | 2026-04-29 03:00 | 0 |
| `GBPUSD.m` | H1 | 2026-06-23 06:00 | 0 |
| `GBPUSD.m` | H1 | 2026-07-01 13:00 | 0 |
| `GBPUSD.m` | M15 | 2025-10-30 13:30 | 0 |
| `GBPUSD.m` | M15 | 2026-04-29 03:00 | 0 |
| `GBPUSD.m` | M15 | 2026-06-23 06:30 | 0 |
| `GBPUSD.m` | M15 | 2026-07-01 13:00 | 0 |

No row was dropped, interpolated, forward-filled, or assigned a substitute
spread. `ParquetBarStore` was not modified and still refuses every nonpositive
spread.

## Artifact integrity

- Inventory: 108 content files (`104` Parquet partitions and `4` symbol
  metadata files), plus the root manifest
- Files on disk: 109 (`104` Parquet, `5` JSON)
- Bytes on disk: 5,679,356
- Verified content/inventory SHA-256:
  `c9388bb323131c9db44975f1637b4d5a5ebab14c4fd79bb3dd06dd2a08f1b38d`
- Capture manifest SHA-256:
  `1da7130674e83e46d60383f25085f8d49423b5c829e80957c537192f5b579858`
- Every series carries its own canonical availability-gap SHA-256 in
  `manifest.json`.

The recorder publishes `IN_PROGRESS` and `capture_complete=false` before
changing content, then finalizes only after rescanning persisted Parquet data,
recomputing the nonpositive-spread receipt, and hashing every content file.
Opening the store verifies the full inventory by default and refuses
incomplete, legacy, missing, added, deleted, or modified content.

Post-capture verification:

- Focused store/recorder/replay/proposal suite: **63 passed**
- Clean combined Stage 0/1/2 regression, excluding the six deliberately stale
  recorded-golden outputs: **963 passed**

This receipt authorizes detector co-firing use only. It is not evidence for
fills, costs, outcomes, trade metrics, or backtest performance.
