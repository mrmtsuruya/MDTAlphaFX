# MDTAlphaFX proposed shipping profile

Status: **APPROVED AND APPLIED 2026-07-27**

This document is the normative decision record for the current implementation.
The operator authorized `APPROVE PROFILE + DELEGATE STAGE 1` on 2026-07-27.
The approved numeric profile is applied and the authorized Stage 1
implementation is complete. The replacement-fixture addendum was separately
approved and applied on 2026-07-28.
It does not authorize a live-account connection, order placement, AUTO
enablement, or bypassing later walk-forward and shipping gates.

## 1. Stage 0 closure profile

### Instruments

- Retain `XAUUSD`, `EURUSD`, `GBPUSD`, and `BTCUSD`; each resolves to its `.m`
  Standard-account symbol on `JustMarkets-Demo2`.
- Remove `watchlist_pending`.
- Defer `US30.std` and `US500.std`. Both are tradeable, but their
  `INTEREST_CURRENT` swap model is not implemented.
- Use the broker-resolved `.m` name as the canonical persisted/journal symbol;
  accept the base name only as an input alias.

### Initial spread, commission, slippage, and replay size

| Setting | Proposed value | Basis |
|---|---:|---|
| XAUUSD max spread | 26 points | observed p99 |
| EURUSD max spread | 47 points | observed p99 |
| GBPUSD max spread | 89 points | observed p99 |
| BTCUSD max spread | 858 points | observed p99 |
| Commission, all four | 0 USD/lot/side | official Standard-account specifications |
| Market-order slippage | 10 points adverse | conservative bootstrap; not broker-measured |
| Stop-order slippage | 20 points adverse | conservative bootstrap; not broker-measured |
| Stage 0 replay volume | 0.10 lot | valid for all four probed symbol specifications; harness only |

The two slippage values are deliberately labelled bootstrap assumptions.
Historical MT5 orders did not retain enough requested prices to estimate them.
They must be included in walk-forward sensitivity analysis and must not be
described as measured broker behavior.

### Fill and swap semantics

- `ohlc_basis: BID`
- `charge_on: ROUND_TRIP`
- `gap_fill: GAPPED_PRICE`
- `swap.rates.unit: POINTS`
- `triple_swap_weekday: WEDNESDAY`
- `weekend_rollovers: SKIPPED`
- `rollover_hour_utc: 19`

The 19 UTC choice follows the current instrument/category pages specific to
Forex, commodities, and crypto. The general Help article's conflicting 21 UTC
claim remains recorded in `docs/AMBIGUITY.md`.

The current fallback swap snapshot is:

| Symbol | Long | Short |
|---|---:|---:|
| XAUUSD | -71.04 | -84.12 |
| EURUSD | -13.32 | -3.72 |
| GBPUSD | -8.76 | -11.64 |
| BTCUSD | -8466.6 | -5554.2 |

Recorded replay must continue to prefer the rates stored with each fixture over
these fallback values.

### Recorded fixture selections

Each bound is half-open and UTC. Record M1 plus every configured analysis
timeframe.

**Gate result, 2026-07-27:** the original 2025 windows returned their analysis
bars but zero M1 bars on `JustMarkets-Demo2`, so they could not close the
recorded-fixture gate.

**Recovery authorization, 2026-07-28:** the operator approved
`docs/PROPOSED-FIXTURE-RECOVERY-ADDENDUM.md`. The replacement selections below
are now normative. Each is a 150-H1-bar window with non-empty M1 history on the
guarded DEMO terminal.

| Period | Symbol(s) | Start | End | Proposal evidence |
|---|---|---|---|---|
| Trending | BTCUSD | 2026-06-29T04:00:00Z | 2026-07-05T10:00:00Z | mean ADX 32.1868; 130/150 bars above 27 |
| Ranging | GBPUSD | 2026-06-09T16:00:00Z | 2026-06-17T22:00:00Z | mean ADX 17.8050; 104/150 bars below 20; 71/150 jointly ADX < 20 and ATR percentile < 60 |
| High volatility | XAUUSD | 2026-06-07T23:00:00Z | 2026-06-16T11:00:00Z | mean ATR percentile 63.2333; 45/150 bars above 90 |

Keep the proposal scanner inputs at `H1`, 500-bar windows, and 10,000 scanned
bars. Acceptance still depends on the recorded-fixture gate proving complete
coverage and the intended regime characteristics; a failed gate sends the
window back for reselection.

## 2. Appendix B initial values

These are initial validation values, not claims of optimality.

| Decision | Proposed initial value |
|---|---|
| 1 TRENDING ADX enter/exit | 27 / 22 |
| 2 RANGING ADX enter/exit | 20 / 25 |
| 3 confirmation bars | 3 |
| 4 bias timeframe | H4 |
| 5 counter-bias score penalty | 0.6 |
| 6 breadth exponent ALPHA | 0.5 |
| 7 display threshold | 70 |
| 8 AUTO threshold | 80 |
| 9 minimum clusters/pillars | 3 / 2 |
| 10 risk per trade | 1.0% |
| 11 maximum daily loss | 3.0% |
| 12 maximum AUTO trades/day | 3 |
| 13 EA takeover | 30 seconds |
| 14 reconciliation interval | 5 seconds |
| 15 trailing | disabled initially; enable only after per-symbol walk-forward evidence |
| 16 stop buffer/minimum | 0.25 ATR / 1.0 ATR |
| 17 TP1/TP2/minimum RR | 1.5R / 3.0R / 1.2R |
| 18 minimum zone/snap radius | 0.15 ATR / 0.5 ATR |
| 19 TTL/chase tolerance | 12 bars / 0.25 ATR initially; tune per symbol |
| 20 pattern confidence/target | 65 / 1.5R |
| 21 pattern trend alignment | required |
| 22 scoring mode | CLUSTERED |
| 22b entry-efficiency window | 3 bars |
| 22c Tier B review | monthly or 200 resolved signals, whichever comes first |
| 22d counterfactual report | weekly, aggregate only |
| 23 starting watchlist | the four existing `.m` instruments; AUTO remains per-symbol opt-in |
| 24 broker/account | `JustMarkets-Demo2`, guarded DEMO only |
| 25 regime-flip position policy | the §7.5 table, unchanged |

Decisions 6–9 and 16–19 remain explicit walk-forward calibration targets.

## 3. Stage 1 semantic resolutions

### Regime and scoring

1. Cluster identifiers are ASCII `A`, `B`, `C`, `D1`, `D2`, `E`, `F`, `G`,
   `H`.
2. TRENDING counter-trend scoring makes only `D2` and `F` available; its
   denominator is 22. Amend the overly broad `enabled_in` pseudocode reading.
3. ADX exit dead bands take precedence over an ADX-driven raw TRANSITIONAL
   result. Once the relevant exit threshold is crossed, TRANSITIONAL takes
   effect immediately without a confirmation counter.
4. While another regime is pending, confidence is
   `remaining_confirmations / regime_confirm_bars`; it resets to 1 when the new
   regime confirms. A one-bar confirmation switches immediately.
5. Eligibility uses full-precision scores. Display rounding never changes a
   threshold result. The “4 of 5 at 80” statement is membership-dependent, and
   full breadth at quality 88 reaches an inclusive threshold of 88.
6. Cluster collapse is ANY-member firing, direction majority with ties to
   `NONE`, and the maximum score among members agreeing with the resolved
   direction.
7. An empty tally is valid and writes `leading_contributor: "NONE"`.
8. FLAT mode applies the normal breadth/quality formula at module level. The
   supplied module list is the already regime-available denominator; breadth is
   agreeing firing modules divided by supplied modules, and quality is the
   arithmetic mean confidence of agreeing firing modules.

### Multi-timeframe behavior

- Interpret the §5.4 rows candidate-centrically:
  - candidate agrees with bias but the entry timeframe disagrees: Radar only;
  - candidate agrees with entry but opposes bias: apply the 0.6 score penalty;
  - H4 and H1 directly conflict: suppress;
  - aligned: no penalty.
- Do not add a second position-size multiplier for counter-bias. The 0.6 score
  penalty is the single size-down/conviction mechanism at Stage 1; the distinct
  TRANSITIONAL 0.5 multiplier remains owned by sizing integration.
- Use the frozen `TimeframeState` as the complete public state. Introduce typed
  internal input/output/config models around it rather than changing its fields.

### Level geometry

- Widen a hairline entry zone symmetrically about its midpoint to
  `min_zone_atr × ATR`; the original zone must remain contained.
- Represent opposing structures as typed records with price, kind, source
  timeframe, and stable identifier; order them nearest-first in the trade
  direction.
- “Just inside” means one broker tick before the opposing price in the trade
  direction. Snapping may pull a target inward only.
- TP2 is supported only by a second distinct opposing structure beyond TP1 in
  the trade direction. Without it, TP2 is `None`.

### Lifecycle and ownership

- Preserve the frozen `Signal.expires_at: datetime`. Before lock it equals
  `created_at` as an explicit “not yet scheduled” placeholder; entering LOCKED
  replaces it once with the TTL-derived wall-clock value.
- A `SignalLifecycleService` owns one active signal and a FIFO candidate queue
  per `(resolved_symbol, timeframe)`. Queued candidates remain
  `AWAITING_VALIDATION`; queue state is service/journal metadata, not a new
  frozen enum member.
- Add an explicit decision event containing signal id, `TAKEN` or `IGNORED`,
  timestamp, actor, and optional reason.
- `IGNORED` signals continue counterfactual monitoring and may advance to
  `CLOSED_TP`, `CLOSED_SL`, `TOO_LATE`, or `EXPIRED`, producing an
  `OutcomeRecord`; they never create or manage an order.
- The lifecycle service persists the second candidate immediately when it is
  queued. Pipeline composition, not the small state helper, owns that write.

### UTC boundary

Keep the frozen contracts unchanged. Reject naive or non-UTC datetimes at every
ingestion and service boundary, including fixture loading, API commands,
journal writes, and lifecycle events.

## 4. Governance authorization

The operator supplied the unambiguous authorization string:

`APPROVE PROFILE + DELEGATE STAGE 1`

It authorizes:

1. writing the values above to config;
2. updating the ambiguity/spec decision record to these readings;
3. implementing the 24 Stage 1 production stubs against the completed test
   suite;
4. correcting tests only where this profile resolves an intentionally skipped
   ambiguity; and
5. advancing the stage marker only after all required gates pass.

It does not authorize live-account connection, order placement, AUTO enablement,
or bypassing walk-forward and later-stage shipping gates.
