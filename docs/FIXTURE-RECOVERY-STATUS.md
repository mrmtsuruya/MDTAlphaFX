# Fixture recovery status

Date: 2026-07-28

Authorization: `APPROVE FIXTURE RECOVERY ADDENDUM`

Config version: `2649cd2dcd12`

## Recorded data

The recorder attached to account `1100509764` on `JustMarkets-Demo2` and
confirmed `DEMO` mode before reading data. No live-account override was set.

| Period | Symbol | Analysis result | M1 result | Recorded gate |
|---|---|---|---|---|
| Trending | BTCUSD.m | H4/H1/M15/M5 span the approved window | 8,961/8,965; 4 missing in 3 runs | PASS; 14 trades; 0% ambiguity |
| Ranging | GBPUSD.m | H4/H1/M15/M5 span the approved window | 8,979/9,000; 21 missing in 13 runs | PASS; 19 trades; 0% ambiguity |
| High volatility | XAUUSD.m | H4/H1/M15/M5 span the approved window | 8,987/9,000; 13 missing in 7 runs | PASS; zero trades; no conclusions |

Internal M1 gaps are retained as diagnostics and do not invalidate a store.
Every necessary walk across a gap continues to use the conservative
`FALLBACK_NO_M1` path and must be marked ambiguous.

The original 2025 stores were moved recoverably to
`fixtures/_superseded_2025_20260728/` before recording replacements.

## Recorded gate result

The high-volatility store is not missing data. It produces 66 raw trivial-gate
signals: 65 are rejected as `MAX_SPREAD` and one as `NO_NEXT_BAR`. Its recorded
XAUUSD spread is 28 points, above the separately approved 26-point ceiling.

The extra implementation rule requiring a resolved trade in every individual
period was removed. §9 applies the trade/report gate to recorded history as a
set, and §11.4 requires low-count samples to be reported without conclusions.
The set resolves 33 trades across trending and ranging and renders recorded
metrics, while all three stores pass their coverage and determinism checks.

`scripts/run_gate.py` now reports three `RECORDED` lines and:

`STAGE 0 GATE: PASSED — RECORDED FIXTURES QUALIFIED`

No spread change, fixture reselection, or gate-strategy change was made.
