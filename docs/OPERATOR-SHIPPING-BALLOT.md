# MDTAlphaFX operator shipping ballot

This is the shortest decision path from the current `Stage 1 — tests only`
state to implementation. It does **not** change configuration. Each item names
the evidence and the exact answer needed from the operator.

For a single concrete recommendation covering this ballot, the Appendix B
initial values, all Stage 1 semantic forks, and the UTC boundary, review
`docs/PROPOSED-SHIPPING-PROFILE.md`. Its exact authorization string is
`APPROVE PROFILE + DELEGATE STAGE 1`.

## A. Close Stage 0

### A1. Starting watchlist

The JustMarkets-Demo2 probe resolved `XAUUSD.m`, `EURUSD.m`, `GBPUSD.m`, and
`BTCUSD.m`. None of the fourteen index bases resolved through the configured
suffix ladder, but a guarded exact-name probe confirmed `US30.std` and
`US500.std` as fully tradeable market-execution index CFDs.

Choose one:

- Keep all four resolved symbols and remove `watchlist_pending`.
- Name the subset of the four to keep and remove `watchlist_pending`.
- Add `.std` to the suffix candidates, probe `US30.std`/`US500.std`, and then
  name any index to retain.
- Supply another broker symbol to probe.

Adding either `.std` index also requires implementing and validating
`INTEREST_CURRENT` swap calculation. The existing four symbols use the already
supported points model.

### A2. Maximum spread by symbol

The recorded 1,440-bar M1 sample in `docs/AMBIGUITY.md` measured:

| Symbol | p95 | p99 | maximum |
|---|---:|---:|---:|
| XAUUSD.m | 26 | 26 | 26 |
| EURUSD.m | 29 | 47 | 55 |
| GBPUSD.m | 37 | 89 | 101 |
| BTCUSD.m | 858 | 858 | 858 |

Provide one integer `max_spread_points` for every symbol retained in A1.
The code must not infer whether the policy should bind near p95, p99, or the
observed maximum.

### A3. Commission and slippage

Official JustMarkets evidence identifies the current `.m` instruments as
Standard-account symbols and states `0 USD` commission per lot per side for
XAUUSD.m, EURUSD.m, GBPUSD.m, and BTCUSD.m. Guarded demo history independently
observed zero commission on 330 XAUUSD trade deals.

Confirm `0.0` for every retained current `.m` symbol, then provide:

- market-order slippage in points;
- stop-order slippage in points.

Sources:
[suffix mapping](https://get.justmarkets.help/hc/en-us/articles/16276884869276-Trading-account-suffixes),
[XAUUSD](https://justmarkets.com/markets/commodities/xauusd),
[EURUSD](https://justmarkets.com/markets/forex/eurusd),
[GBPUSD](https://justmarkets.com/markets/forex/gbpusd), and
[BTCUSD](https://justmarkets.com/markets/crypto/btcusd).
The specification deliberately supplies no slippage default.

### A4. Recorded-price and spread semantics

Confirm the two evidence-backed values and choose the remaining policy:

| Decision | Evidence / candidate values |
|---|---|
| MT5 OHLC basis | Confirm `BID`: the guarded broker probe reports `SYMBOL_CHART_MODE_BID`, matching MetaTrader's OTC chart documentation. |
| Charge spread on exit | Confirm `ROUND_TRIP`: MetaTrader documents Ask for opening longs/closing shorts and Bid for opening shorts/closing longs. |
| Gap fill | Choose `GAPPED_PRICE` or `LEVEL_PRICE`. |

`GAPPED_PRICE` is currently configured as Stage 0 scaffolding, not as an
operator-approved policy.

### A5. Swap policy and unit

The guarded demo probe found:

| Scope | Swap mode | Three-day rollover |
|---|---|---|
| XAUUSD.m / EURUSD.m / GBPUSD.m / BTCUSD.m | `POINTS` | Wednesday |
| US30.std / US500.std | `INTEREST_CURRENT` | Friday |

For the existing four-symbol watchlist, official evidence supports `POINTS`,
Wednesday, and weekend `SKIPPED`. Confirm those values and choose the remaining
rollover clock:

- `19` UTC: current Forex, commodities, and crypto category pages say
  22:00 GMT+3; or
- `21` UTC: the 2026-03-30 JustMarkets Help article says 00:00 GMT+3.

The official sources conflict, so this value cannot be inferred safely.

If an index is retained, authorize implementation of annual-interest swap
calculation before it enters any replay.

The connector already records `swap_long` and `swap_short`, the fixture store
persists them, and recorded replay passes them through `RunSpec.swap_rates`.
No frozen-contract change is needed for that path.

### A6. Fixture windows

`data/fixture_candidates.json` was generated on 2026-07-27 from 10,000 H1 bars
per resolved symbol using ADX(14) and ATR(14) percentile over 100 bars. It is a
ranked proposal, not a classification and not a config change.

Choose one start/end pair for each:

- trending;
- ranging;
- high volatility.

Also name which retained symbols each period should record. The recorder will
then capture M1 plus every analysis timeframe with per-bar spread.

## B. Authorize Stage 1 semantics

### B1. Cluster identifiers

Choose `D1` and `D2`, Unicode `D₁` and `D₂`, or a single merged `D`. The §5.1
weights and module partition are self-consistent only with two distinct
clusters; the frozen §2 field remains a plain string.

### B2. Counter-trend denominator

Choose the normative rule:

- `enabled_in` pseudocode: a counter-trend signal includes every `ENABLED`
  cluster plus `COUNTER_ONLY` clusters; or
- the prose/table denominator of 22: only `COUNTER_ONLY` clusters D2 and F.

These produce materially different counter-trend scores.

### B3. Hysteresis precedence

When raw classification becomes `TRANSITIONAL` while the current regime is
inside an ADX dead band, choose:

- immediate `TRANSITIONAL`, because it is exempt from confirmation; or
- retain the prior regime while inside the exit dead band.

Also define the exact confidence-decay formula while another regime is pending.

### B4. Multi-timeframe states

Define:

- whether the first two §5.4 rows refer to bias-vs-entry disagreement or a
  different pair of timeframe roles;
- the complete shape of a `TimeframeState`;
- whether “size down” uses the §3.5 score penalty only or an additional position
  multiplier.

### B5. Level geometry

Define:

- which side of a too-narrow entry zone is widened;
- the numeric/point rule for “just inside” an opposing structure;
- what constitutes structure supporting TP2;
- the schema and ordering for opposing levels and swing inputs.

### B6. Lifecycle events and ownership

Define:

- which component owns the one-active-signal queue;
- the event/API that records an external `TAKEN` or `IGNORED` decision;
- the outgoing resolution path for `IGNORED`;
- whether `Signal.expires_at` is nullable before lock or must be populated when
  a pre-lock `Signal` is constructed.

### B7. Remaining policy seams

Define:

- how a cluster resolves member results (ANY, direction majority, MAX score)
  in a callable API;
- the stable `leading_contributor` value for an empty vote tally, or that empty
  input is outside the tally precondition;
- the exact FLAT-mode formula and denominator;
- the exact confidence-decay curve while a different regime is pending;
- the event or owner that persists the second queued candidate.

The remaining integration ownership is already resolvable from the spec:
upstream EMA alignment includes slope; the TRANSITIONAL +5 applies to display
only; the 0.5 multiplier belongs to sizing; suppressed members are forced false
by pipeline gating; and a failed `GateOutcome` blocks visibility/action during
pipeline composition.

## C. Frozen-contract UTC boundary

The frozen Pydantic contracts currently accept naive and non-UTC datetimes,
while §10.1 requires UTC internally.

Choose:

- validate UTC inside the frozen models, explicitly approving a frozen-contract
  behavior change; or
- preserve the models and validate at every ingestion/service boundary.

## Approval format

Reply with answers keyed `A1` through `A6`, `B1` through `B7`, and `C`. An
answer may explicitly defer a symbol or feature; deferred scope will remain
disabled and cannot be described as shipped.
