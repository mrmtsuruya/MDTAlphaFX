# Stage 1 transition evidence audit

## Overall assessment: Share with caveats

The saved replay passes the independent mechanical audit across **27,090 H1 rows**, **1,972 observed transitions**, and **1,976 effective-regime segments**.

All **84 one-bar segments** were inspected. **76** are deterministic A→B→A whipsaw candidates; none is mechanically impossible. This is observable label churn, not proof that the underlying feature classification was false.

### Question answered

Do the one-bar and sustained Stage 1 regime transitions agree with the approved ordered feature rules, asymmetric hysteresis, confirmation invariants, and contemporaneous price behavior?

### Source and scope

- Replay: `docs/stage1-gate-recovery-20260728/regime_replay.json`
- SHA-256: `d173b439491f735d419972a3cd7aa5e07e03c115fbe59de8b5e44cefbe1a2621`
- Replay generated: `2026-07-28T12:42:41.610813+00:00`
- Account label: `DEMO 1100509764 @ JustMarkets-Demo2`
- Timeframe: `H1`
- Symbols: 4
- Replay config `2649cd2dcd12`; audit config `2649cd2dcd12`; whole-config match: `True`

## Methodology review

The audit independently transcribes §3.2 and §3.3 rather than calling the production classifier. Every stored raw label is recomputed from ADX, ATR percentile, EMA alignment/direction, R², and blackout flag. Every effective label, confidence, and regime age after each symbol's first saved row is replayed from the raw sequence. Non-TRANSITIONAL entries require three consecutive raw confirmations; TRANSITIONAL entries must be immediate and outside an applicable ADX-only dead band.

Price is assessed from the segment start open through end close, scaled by the median high–low range of the prior 20 saved bars. Trend labels are triaged on signed movement, RANGING on path efficiency/displacement, and VOLATILE_NEWS on bar-range expansion. TRANSITIONAL is not price-scored because it makes no directional or volatility claim. These fixed triage bounds do not alter model configuration.

## Dataset and grain checks

The grain is one ready, closed H1 bar per symbol and UTC open time. Timestamps are strictly increasing and unique within each symbol. Non-hourly gaps are retained rather than filled; the FX/metal gaps are consistent with session/weekend closures, while BTCUSD is nearly continuous. No gap is interpreted as a regime transition.

| Symbol | Rows | Segments | Switches | One-bar | Non-hourly gaps | Maximum gap |
|---|---:|---:|---:|---:|---:|---:|
| BTCUSD | 8,760 | 629 | 628 | 28 | 1 | 2 h |
| EURUSD | 6,204 | 501 | 500 | 25 | 55 | 50 h |
| GBPUSD | 6,214 | 455 | 454 | 20 | 55 | 50 h |
| XAUUSD | 5,912 | 391 | 390 | 11 | 258 | 74 h |

## Mechanical invariants

| Check | Result | Violations |
|---|---:|---:|
| Row schema, UTC ordering, OHLC and feature domains | PASS | 0 |
| Independent ordered raw branch | PASS | 0 |
| Independent hysteresis/confidence/age replay | PASS | 0 |
| Transition entry support | PASS | 0 |
| Impossible transitions | PASS | 0 |

## One-bar transition review

| Diagnostic | Count | Share |
|---|---:|---:|
| All one-bar segments | 84 | 100.0% |
| A→B→A round-trip candidates | 76 | 90.5% |
| Non-round-trip one-bar segments | 8 | 9.5% |
| Price triage: supportive | 17 | 20.2% |
| Price triage: mixed | 49 | 58.3% |
| Price triage: contradictory | 17 | 20.2% |
| Price triage: unavailable | 0 | 0.0% |

Feature finding: every one-bar entry has the required three raw confirmations. Each one then loses its effective label after one bar under a mechanically valid next-bar rule. The dominant shape is a three-bar build-up while TRANSITIONAL, one effective stable bar, then immediate return to TRANSITIONAL; that explains the round trips without making them operationally irrelevant.

### All one-bar segments

| # | Symbol · start | Effective path | Entry evidence | Price triage | Move / range | Median range ratio | A→B→A |
|---:|---|---|---|---|---:|---:|:---:|
| 1 | BTCUSD · 2025-08-21T03:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.13 | 0.89× | yes |
| 2 | BTCUSD · 2025-09-01T20:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | -0.67 | 1.83× | yes |
| 3 | BTCUSD · 2025-09-16T19:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.88 | 1.02× | yes |
| 4 | BTCUSD · 2025-09-24T06:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | -0.08 | 0.49× | yes |
| 5 | BTCUSD · 2025-09-25T01:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | CONTRADICTORY | -1.12 | 2.71× | yes |
| 6 | BTCUSD · 2025-09-26T21:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | 0.41 | 0.57× | yes |
| 7 | BTCUSD · 2025-10-05T11:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | 1.06 | 1.73× | yes |
| 8 | BTCUSD · 2025-10-30T22:00:00+00:00 | VOLATILE_NEWS → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | 0.49 | 0.96× | no |
| 9 | BTCUSD · 2025-11-12T23:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | 0.37 | 1.05× | yes |
| 10 | BTCUSD · 2025-12-09T17:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.03 | 1.01× | yes |
| 11 | BTCUSD · 2025-12-09T21:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.33 | 0.94× | yes |
| 12 | BTCUSD · 2025-12-10T21:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | 0.13 | 1.41× | yes |
| 13 | BTCUSD · 2025-12-14T23:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | CONTRADICTORY | 0.74 | 1.57× | yes |
| 14 | BTCUSD · 2026-01-13T19:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.45 | 0.80× | yes |
| 15 | BTCUSD · 2026-03-04T09:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.27 | 0.92× | yes |
| 16 | BTCUSD · 2026-03-17T04:00:00+00:00 | TRENDING_BULLISH → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.29 | 1.08× | no |
| 17 | BTCUSD · 2026-03-19T23:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | CONTRADICTORY | 0.52 | 0.89× | yes |
| 18 | BTCUSD · 2026-05-06T13:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | CONTRADICTORY | -1.38 | 1.57× | yes |
| 19 | BTCUSD · 2026-05-13T17:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | 1.23 | 1.39× | yes |
| 20 | BTCUSD · 2026-05-21T00:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | 1.40 | 1.94× | yes |
| 21 | BTCUSD · 2026-05-28T20:00:00+00:00 | VOLATILE_NEWS → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | 0.44 | 1.36× | no |
| 22 | BTCUSD · 2026-06-16T01:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | MIXED | 0.26 | 0.55× | yes |
| 23 | BTCUSD · 2026-06-16T16:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | -0.28 | 0.71× | yes |
| 24 | BTCUSD · 2026-06-24T04:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | 0.02 | 0.79× | yes |
| 25 | BTCUSD · 2026-07-01T12:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | -0.28 | 1.15× | yes |
| 26 | BTCUSD · 2026-07-06T11:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | -1.07 | 1.73× | yes |
| 27 | BTCUSD · 2026-07-08T03:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.47 | 0.89× | yes |
| 28 | BTCUSD · 2026-07-17T19:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.33 | 0.98× | yes |
| 29 | EURUSD · 2025-07-28T05:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | SUPPORTIVE | -0.56 | 0.66× | yes |
| 30 | EURUSD · 2025-08-07T21:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | MIXED | 0.01 | 0.68× | yes |
| 31 | EURUSD · 2025-08-14T16:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.63 | 1.03× | yes |
| 32 | EURUSD · 2025-08-26T15:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.06 | 0.96× | yes |
| 33 | EURUSD · 2025-09-10T15:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -1.09 | 1.41× | yes |
| 34 | EURUSD · 2025-10-06T15:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -0.74 | 1.31× | yes |
| 35 | EURUSD · 2025-11-10T09:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.46 | 0.85× | yes |
| 36 | EURUSD · 2025-12-08T17:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | -0.18 | 0.78× | yes |
| 37 | EURUSD · 2025-12-18T16:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -1.10 | 1.53× | yes |
| 38 | EURUSD · 2026-01-12T01:00:00+00:00 | TRENDING_BEARISH → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.14 | 1.11× | no |
| 39 | EURUSD · 2026-01-12T08:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -0.54 | 1.28× | yes |
| 40 | EURUSD · 2026-01-21T16:00:00+00:00 | TRENDING_BULLISH → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -0.03 | 1.26× | no |
| 41 | EURUSD · 2026-01-23T15:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | CONTRADICTORY | 1.35 | 3.06× | yes |
| 42 | EURUSD · 2026-02-10T14:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | MIXED | -0.06 | 2.31× | yes |
| 43 | EURUSD · 2026-02-27T16:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.49 | 1.04× | yes |
| 44 | EURUSD · 2026-03-23T07:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | 0.14 | 1.14× | yes |
| 45 | EURUSD · 2026-04-15T05:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | MIXED | 0.38 | 1.12× | yes |
| 46 | EURUSD · 2026-05-29T06:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | 1.33 | 1.42× | yes |
| 47 | EURUSD · 2026-06-12T10:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -0.83 | 1.39× | yes |
| 48 | EURUSD · 2026-06-17T21:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | 0.42 | 0.49× | yes |
| 49 | EURUSD · 2026-06-24T19:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | -0.16 | 0.73× | yes |
| 50 | EURUSD · 2026-06-25T00:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | -0.05 | 0.71× | yes |
| 51 | EURUSD · 2026-06-29T05:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | 1.38 | 1.48× | yes |
| 52 | EURUSD · 2026-07-01T16:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -0.16 | 1.62× | yes |
| 53 | EURUSD · 2026-07-08T18:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.55 | 1.09× | yes |
| 54 | GBPUSD · 2025-09-26T11:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | 0.35 | 0.97× | yes |
| 55 | GBPUSD · 2025-09-30T17:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.58 | 1.03× | yes |
| 56 | GBPUSD · 2025-10-06T06:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | -0.15 | 1.40× | yes |
| 57 | GBPUSD · 2025-10-10T17:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.01 | 1.00× | yes |
| 58 | GBPUSD · 2025-10-27T06:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | -0.75 | 1.35× | yes |
| 59 | GBPUSD · 2025-11-12T15:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | -0.04 | 0.68× | yes |
| 60 | GBPUSD · 2025-11-17T05:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | MIXED | 0.45 | 1.21× | yes |
| 61 | GBPUSD · 2025-11-20T17:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | CONTRADICTORY | 0.51 | 0.90× | yes |
| 62 | GBPUSD · 2025-12-17T08:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | -0.07 | 0.73× | yes |
| 63 | GBPUSD · 2025-12-26T17:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | 0.05 | 0.52× | yes |
| 64 | GBPUSD · 2026-02-26T18:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | 1.46 | 1.76× | yes |
| 65 | GBPUSD · 2026-03-06T20:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | SUPPORTIVE | 0.87 | 0.91× | yes |
| 66 | GBPUSD · 2026-05-01T16:00:00+00:00 | TRENDING_BULLISH → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -1.78 | 2.19× | no |
| 67 | GBPUSD · 2026-05-06T15:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | CONTRADICTORY | -0.55 | 0.68× | yes |
| 68 | GBPUSD · 2026-05-06T19:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | MIXED | -0.05 | 0.44× | yes |
| 69 | GBPUSD · 2026-05-29T16:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | SUPPORTIVE | -0.80 | 1.32× | yes |
| 70 | GBPUSD · 2026-06-04T07:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | SUPPORTIVE | -0.61 | 1.76× | yes |
| 71 | GBPUSD · 2026-06-08T03:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | 0.11 | 0.50× | yes |
| 72 | GBPUSD · 2026-07-03T12:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | MIXED | -0.21 | 0.64× | yes |
| 73 | GBPUSD · 2026-07-23T17:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.85 | 0.95× | yes |
| 74 | XAUUSD · 2025-07-31T15:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.07 | 0.94× | yes |
| 75 | XAUUSD · 2025-08-20T04:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | 0.23 | 0.76× | yes |
| 76 | XAUUSD · 2025-09-04T15:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.64 | 1.04× | yes |
| 77 | XAUUSD · 2025-11-25T06:00:00+00:00 | TRANSITIONAL → TRENDING_BULLISH → TRANSITIONAL | PASS `TRENDING_BULLISH/TRENDING_BULLISH/TRENDING_BULLISH` | CONTRADICTORY | -0.70 | 1.23× | yes |
| 78 | XAUUSD · 2025-12-01T16:00:00+00:00 | TRENDING_BULLISH → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.40 | 1.09× | no |
| 79 | XAUUSD · 2025-12-30T22:00:00+00:00 | TRANSITIONAL → TRENDING_BEARISH → TRANSITIONAL | PASS `TRENDING_BEARISH/TRENDING_BEARISH/TRENDING_BEARISH` | MIXED | 0.03 | 0.96× | yes |
| 80 | XAUUSD · 2026-01-09T20:00:00+00:00 | TRANSITIONAL → RANGING → TRANSITIONAL | PASS `RANGING/RANGING/RANGING` | SUPPORTIVE | 0.14 | 0.49× | yes |
| 81 | XAUUSD · 2026-05-06T15:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | -0.76 | 0.90× | yes |
| 82 | XAUUSD · 2026-05-07T23:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | MIXED | 0.92 | 1.04× | yes |
| 83 | XAUUSD · 2026-06-04T16:00:00+00:00 | TRANSITIONAL → VOLATILE_NEWS → TRANSITIONAL | PASS `VOLATILE_NEWS/VOLATILE_NEWS/VOLATILE_NEWS` | CONTRADICTORY | 0.28 | 0.51× | yes |
| 84 | XAUUSD · 2026-07-28T11:00:00+00:00 | RANGING → TRANSITIONAL → END | PASS `TRANSITIONAL` | NOT_SCORED | 0.14 | 0.83× | no |

## Sustained transition review

The replay contains **1,892 sustained segments**, of which **1,888** have their entry boundary inside the saved window. All observed entries satisfy the independent hysteresis rule.

| Price triage | Segments | Share of sustained segments |
|---|---:|---:|
| SUPPORTIVE | 464 | 24.5% |
| MIXED | 410 | 21.7% |
| CONTRADICTORY | 110 | 5.8% |
| NOT_SCORED | 904 | 47.8% |
| UNAVAILABLE | 4 | 0.2% |

A contradictory price diagnostic is not a mechanical failure: the classifier describes the feature state at each close and does not promise subsequent direction. It is a deterministic queue for later outcome/backtest analysis.

### Largest sustained price contradictions

| Symbol · start | Regime | Bars | Move / range | Efficiency | Price finding |
|---|---|---:|---:|---:|---|
| EURUSD · 2025-08-01T09:00:00+00:00 | RANGING | 5 | 11.19 | 0.86 | efficient displacement (0.86) escaped the range bound |
| EURUSD · 2026-07-14T07:00:00+00:00 | RANGING | 7 | 9.28 | 0.78 | efficient displacement (0.78) escaped the range bound |
| GBPUSD · 2026-04-28T04:00:00+00:00 | RANGING | 8 | -6.63 | 0.87 | efficient displacement (0.87) escaped the range bound |
| BTCUSD · 2026-03-18T02:00:00+00:00 | RANGING | 12 | -6.13 | 0.79 | efficient displacement (0.79) escaped the range bound |
| BTCUSD · 2025-08-22T10:00:00+00:00 | RANGING | 6 | 6.10 | 0.70 | efficient displacement (0.70) escaped the range bound |
| EURUSD · 2025-12-02T21:00:00+00:00 | RANGING | 14 | 5.96 | 0.92 | efficient displacement (0.92) escaped the range bound |
| GBPUSD · 2025-08-28T18:00:00+00:00 | RANGING | 18 | -5.70 | 0.71 | efficient displacement (0.71) escaped the range bound |
| XAUUSD · 2026-01-29T13:00:00+00:00 | TRENDING_BULLISH | 3 | -5.54 | 0.60 | opposing move -5.54 signed pre-range units |
| GBPUSD · 2025-10-07T04:00:00+00:00 | RANGING | 7 | -5.29 | 0.78 | efficient displacement (0.78) escaped the range bound |
| EURUSD · 2026-01-16T16:00:00+00:00 | TRENDING_BEARISH | 8 | 4.77 | 0.46 | opposing move -4.77 signed pre-range units |
| GBPUSD · 2026-05-11T23:00:00+00:00 | RANGING | 8 | -4.62 | 0.85 | efficient displacement (0.85) escaped the range bound |
| BTCUSD · 2026-02-13T00:00:00+00:00 | RANGING | 17 | 4.58 | 0.68 | efficient displacement (0.68) escaped the range bound |
| EURUSD · 2026-01-22T10:00:00+00:00 | RANGING | 6 | 4.35 | 1.00 | efficient displacement (1.00) escaped the range bound |
| GBPUSD · 2025-09-15T01:00:00+00:00 | RANGING | 12 | 4.27 | 0.83 | efficient displacement (0.83) escaped the range bound |
| EURUSD · 2026-03-31T11:00:00+00:00 | RANGING | 2 | 4.17 | 1.00 | efficient displacement (1.00) escaped the range bound |

## Representative examples

The JSON companion contains compact pre-/post-boundary OHLC and feature context for each example below.

| Example | Symbol · start | Regime | Bars | Entry | Price triage |
|---|---|---|---:|---|---|
| FIRST_ONE_BAR_RANGING | EURUSD · 2025-07-28T05:00:00+00:00 | RANGING | 1 | PASS | SUPPORTIVE |
| FIRST_ONE_BAR_TRANSITIONAL | XAUUSD · 2026-07-28T11:00:00+00:00 | TRANSITIONAL | 1 | PASS | NOT_SCORED |
| FIRST_ONE_BAR_TRENDING_BEARISH | XAUUSD · 2025-08-20T04:00:00+00:00 | TRENDING_BEARISH | 1 | PASS | MIXED |
| FIRST_ONE_BAR_TRENDING_BULLISH | EURUSD · 2025-08-07T21:00:00+00:00 | TRENDING_BULLISH | 1 | PASS | MIXED |
| FIRST_ONE_BAR_VOLATILE_NEWS | XAUUSD · 2025-07-31T15:00:00+00:00 | VOLATILE_NEWS | 1 | PASS | MIXED |
| LONGEST_SUSTAINED_RANGING | EURUSD · 2026-02-04T00:00:00+00:00 | RANGING | 80 | PASS | MIXED |
| LONGEST_SUSTAINED_TRANSITIONAL | GBPUSD · 2026-07-06T18:00:00+00:00 | TRANSITIONAL | 140 | PASS | NOT_SCORED |
| LONGEST_SUSTAINED_TRENDING_BEARISH | GBPUSD · 2026-03-12T19:00:00+00:00 | TRENDING_BEARISH | 38 | PASS | SUPPORTIVE |
| LONGEST_SUSTAINED_TRENDING_BULLISH | BTCUSD · 2026-07-03T00:00:00+00:00 | TRENDING_BULLISH | 49 | PASS | SUPPORTIVE |
| LONGEST_SUSTAINED_VOLATILE_NEWS | XAUUSD · 2026-01-29T16:00:00+00:00 | VOLATILE_NEWS | 41 | PASS | SUPPORTIVE |
| LARGEST_PRICE_CONTRADICTION | EURUSD · 2025-08-01T09:00:00+00:00 | RANGING | 5 | PASS | CONTRADICTORY |
| LARGEST_PRICE_CONTRADICTION | EURUSD · 2026-07-14T07:00:00+00:00 | RANGING | 7 | PASS | CONTRADICTORY |
| LARGEST_PRICE_CONTRADICTION | GBPUSD · 2026-04-28T04:00:00+00:00 | RANGING | 8 | PASS | CONTRADICTORY |
| LARGEST_PRICE_CONTRADICTION | BTCUSD · 2026-03-18T02:00:00+00:00 | RANGING | 12 | PASS | CONTRADICTORY |

## Issues found

1. **Medium — one-bar effective churn:** 76 of 84 one-bar segments are A→B→A round trips. They are spec-conformant but briefly swap the active cluster map after confirmation, so they should remain an explicit Stage 1 operating diagnostic.
2. **Medium — economic-calendar branch unavailable:** the saved replay has no calendar proximity data. ATR-driven volatility is audited; news-driven VOLATILE_NEWS coverage is not.
3. **Resolved — config provenance:** replay and audit hashes match.

## Calculation spot-checks

- Raw classification: **27,090/27,090 verified**.
- Hysteresis transitions: **1,972/1,972 verified**.
- One-bar entries: **84/84 mechanically supported**.
- Sustained observed entries: **1,888/1,888 mechanically supported**.
- Impossible transitions: **0**.

## Required caveats for operators

- Economic-calendar proximity is absent; VOLATILE_NEWS therefore covers only the ATR-percentile branch.
- Replay and audit whole-config hashes match.
- Price coherence is post-label behavior and cannot establish causality, profitability, or a false classification.
- The first segment of each symbol begins inside the saved 365-day window, so its entry confirmation may predate the file.

## Handoff

The operator-reviewable transition queue is now closed as a deterministic evidence pass: every one-bar segment and every sustained segment is represented in the JSON, all transition mechanics are exhaustively checked, and price contradictions are retained rather than tuned away. This does not close the separate economic-calendar or realised-score dependencies.
