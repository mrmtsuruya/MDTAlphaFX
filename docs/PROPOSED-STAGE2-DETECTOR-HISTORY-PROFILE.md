# Proposed Stage 2 detector and history profile

Status: **APPROVED · DETECTORS APPLIED · HISTORY RECOVERED — 2026-07-28**

Prepared: 2026-07-28  
Requested authorization: `APPROVE STAGE 2 DETECTOR + HISTORY PROFILE`

Authorization received: `APPROVE STAGE 2 DETECTOR + HISTORY PROFILE` on
2026-07-28.

Implementation receipt: all 28 detectors are complete. The original recorded
goldens and visual evidence are preserved, but modules 2–6 and 9 are explicitly
stale after the authorized collision-ranking recovery. The exact guarded cohort
was recovered into the separate analysis-only/cost-invalid store documented in
`docs/STAGE2-HISTORY-RECEIPT.md`.

## Why this addendum is required

The operator authorized `APPROVE + DELEGATE STAGE 2`. That opens Stage 2, but
the SPEC §4 table supplies only module names and one-sentence descriptions.
It does not settle the lookbacks, tolerances, indicator conventions, event
semantics, confidence calculations, or several direction rules needed to
produce a deterministic `StrategyResult`.

`config/clusters.yaml` settles membership and starting weights.
`config/levels.yaml` settles downstream level derivation. Neither file defines
module detection. Applying plausible technical-analysis defaults without a
reviewed record would violate repository rule 12.

The co-firing gate also requires raw `Candle` history with tick volume and
spread. The saved one-year Stage 1 replay omits those fields, and the active
recorded fixtures are intentionally short. This addendum therefore settles one
guarded, reproducible analysis-only history capture as well.

Nothing below authorizes a live account, order placement, AUTO, Stage 2b,
Stage 3, global optimisation, or applying the measured cluster/weight proposal.

## 1. Frozen boundaries and semantic readings

1. Do not change §2 contracts or the §4.1 `Strategy` protocol.
2. Each module remains a pure function of its injected immutable parameters,
   the supplied closed-bar window, and `SymbolSpec`. It performs no I/O and
   reads no regime.
3. Context phrases in §4 are handled as follows:
   - Module 8 uses local confirmed price structure for “macro trend”; Tier 1
     still controls whether its cluster may contribute.
   - Module 15 detects a pinbar/hammer at a confirmed key level on the supplied
     timeframe. Stage 3 owns cross-timeframe confirmation.
   - Module 18 proves its active trend from its own EMA alignment.
   - Module 24 detects the envelope event without checking for a ranging
     regime; Tier 1 owns the RANGING gate.
4. Module 28 is instantiated only on M5 and M15. Its 30-minute range cannot be
   reconstructed faithfully from H1 or H4 bars.
5. When bullish and bearish conditions both resolve on the same evaluation bar,
   the module returns `fired=false`, `direction=NONE`, and score zero.
6. Event modules fire only on the first qualifying closed bar. Module 17 is the
   single state detector and remains fired while strict EMA alignment holds.
7. A non-firing result has `direction=NONE`, score zero, and no tradeable
   geometry.

## 2. Stage 2 configuration namespace

After approval, create `config/strategies.yaml`. Production constructors read
it once and inject immutable values into modules. `evaluate()` never reads
config.

Initial scope is global across symbols. Thresholds expressed in ATR or ratios
remain instrument-scaled. Per-symbol or per-timeframe overrides require a later
measured proposal and explicit approval.

### Shared geometry and evidence

Every firing result must contain JSON-serializable evidence with:

- `schema_version`
- top-level `min` and `max` for §5.5 entry-zone derivation
- `event_time` as UTC ISO-8601
- `overlay_type`
- `geometry` containing typed UTC/price coordinates
- `stop_anchor`
- `opposing_structures`
- `indicators`
- `quality_flags`
- `timeframe_seconds`

The chart renderer consumes these coordinates verbatim. It may not recompute
an indicator or pattern.

### Shared values

| Key | Proposed value |
|---|---:|
| `atr_period` | 14 |
| `volume_median_bars` | 20 |
| `pivot_left_bars` | 2 |
| `pivot_right_bars` | 2 |
| `structure_lookback_bars` | 50 |
| `minimum_pattern_separation_bars` | 5 |
| `maximum_pattern_age_bars` | 20 |
| `equal_level_tolerance_atr` | 0.10 |
| `touch_tolerance_atr` | 0.10 |
| `break_buffer_atr` | 0.05 |
| `minimum_displacement_body_atr` | 0.80 |
| `minimum_rejection_wick_atr` | 0.50 |
| `high_volume_ratio` | 1.20 |
| `low_volume_ratio` | 0.80 |
| `confidence_base` | 65 |
| `confidence_confirmation_bonus` | 10 |
| `confidence_cap` | 95 |

ATR uses Wilder smoothing. EMA uses the Stage 1 SMA-seeded convention. Rolling
standard deviation is population standard deviation. Tick volume is the only
available volume proxy and must be labelled as such.

### Confidence policy

A mandatory detector match starts at 65. Each module defines exactly three
binary quality confirmations below. Each satisfied confirmation adds 10, with
a cap of 95. The result is deterministic, comparable within a cluster, and
keeps 100 reserved rather than presenting every match as textbook quality.

The three confirmations and their raw measurements are written to evidence.
Changing the base, bonus, cap, confirmation definitions, or thresholds is a
config change requiring a later proposal.

## 3. Exact module readings

### Pillar 1 — SMC / ICT

1. **Bullish FVG Fill.** A three-candle wick gap satisfies
   `bar_1.high < bar_3.low`, width at least 0.10 ATR, with middle-candle body at
   least 0.80 ATR. Fire BUY on the first overlap within 20 bars unless price
   previously closed through the far edge. Zone: gap. Confirmations: middle
   candle high volume; gap width at least 0.25 ATR; touch closes above the gap
   midpoint.
2. **Bearish FVG Fill.** Exact mirror of module 1. Zone: gap.
3. **Bullish Order Block.** The last bearish candle before a close breaks a
   confirmed swing high by 0.05 ATR, with break-candle body at least 0.80 ATR.
   Fire BUY on the first body-zone mitigation within 20 bars that closes back
   above the zone midpoint. Zone: order-block body. Confirmations: high-volume
   break; rejection wick at least 0.50 ATR; no earlier zone overlap.
4. **Bearish Order Block.** Exact mirror of module 3.
5. **Sell-Side Liquidity Sweep.** Two confirmed swing lows, separated by 5–50
   bars, lie within 0.10 ATR. Fire BUY when the current low pierces their mean
   by 0.05 ATR and the same candle closes back above it. Zone: rejection wick.
   Confirmations: wick at least 0.50 ATR; high volume; close in the upper half
   of the candle.
6. **Buy-Side Liquidity Sweep.** Exact mirror of module 5.
7. **CHoCH.** Bullish requires a confirmed lower-high/lower-low sequence and
   the first close above the latest swing high; bearish is the inverse. The
   break buffer is 0.05 ATR. Zone: the broken swing price, emitted as a
   hairline and widened later by §5.5. Confirmations: displacement body at
   least 0.80 ATR; high volume; close at least 0.25 ATR beyond the level.
8. **BOS.** Bullish requires a confirmed higher-high/higher-low sequence and a
   close above the latest swing high; bearish requires lower-high/lower-low and
   a close below the latest swing low. Zone and confirmations match module 7.
9. **Breaker Block Mitigation.** Start from the module 3/4 order-block
   definition. A close through the far edge invalidates and flips the block.
   Fire in the flipped direction on the first retest within 20 bars. Zone:
   original order-block body. Confirmations: failure displacement at least
   0.80 ATR; high failure-bar volume; mitigation rejection wick at least
   0.50 ATR.
10. **Liquidity Void Re-alignment.** Use a price-action void, not a
    price-by-volume profile: the same three-candle wick gap as modules 1/2,
    middle body at least 0.80 ATR, and middle tick volume no more than 0.80 of
    its 20-bar median. Fire in the original displacement direction when at
    least 50% of the void is rebalanced within 5 bars and price closes back in
    that direction. Zone: void. Confirmations: gap at least 0.25 ATR; rebalance
    exceeds 75%; resumption close clears the void midpoint.

### Pillar 2 — Price Action and Pivots

11. **Quasimodo Level Reversal.** Implement bullish and bearish mirrors.
    Bearish sequence: prior swing high, over-extended higher high by at least
    0.50 ATR, close below the intervening swing low, then return within
    0.10 ATR of the left shoulder inside 20 bars. Bullish is inverse. Zone:
    shoulder ±0.10 ATR. Confirmations: over-extension at least 1.00 ATR;
    rejection wick at least 0.50 ATR; high-volume return.
12. **Support/Resistance Flip.** Implement both support-to-resistance and
    resistance-to-support. A key level is two confirmed same-side pivots within
    0.10 ATR and 5–50 bars apart. Require a close break by 0.05 ATR, then the
    first retest within 20 bars. Zone: level ±0.10 ATR. Confirmations:
    displacement break; high-volume break; retest rejection wick.
13. **Supply/Demand Zone Retest.** A base contains 1–3 candles with combined
    range no more than 1.00 ATR, followed by a directional impulse body at
    least 1.50 ATR. Fire in the impulse direction on the first retest within
    20 bars. Zone: min/max of base candle bodies. Confirmations: high-volume
    impulse; no prior retest; rejection wick at least 0.50 ATR.
14. **Double Bottom/Top Validation.** Two confirmed equal pivots are within
    0.10 ATR and 5–50 bars apart. The second test must have tick volume no more
    than 0.80 of the first and close away from the level by 0.10 ATR. Zone:
    second-test rejection wick. Confirmations: second volume also below its
    20-bar median; rejection wick at least 0.50 ATR; separation at least
    10 bars.
15. **Pinbar/Hammer Exhaustion.** A confirmed current-timeframe key level from
    the 50-bar structure window is touched within 0.10 ATR. The rejection wick
    is at least 2.0 times the body and 0.50 ATR; body is at most 35% of candle
    range; close lies inside the rejection-side 35% of the range. Zone:
    rejection wick. Confirmations: range at least 1.00 ATR; low volume; a
    second confirmed pivot supports the level. Stage 3 later owns MTF
    confirmation.
16. **Engulfing Cluster.** One high-volume directional candle fully engulfs
    the previous candle’s high and low, has body at least 0.80 ATR, and closes
    in its direction. Zone: engulfing body. Confirmations: close inside the
    final 20% of its range; volume at least 1.50 of median; body at least
    1.20 ATR.

### Pillar 3 — Trend and Momentum

17. **Triple EMA Alignment.** SMA-seeded EMA 20/50/200. Fire continuously BUY
    for strict 20 > 50 > 200 and SELL for the inverse; slopes are confirmations,
    not mandatory. Zone: EMA20–EMA50 band. Confirmations: fast/middle separation
    at least 0.20 ATR; middle/slow at least 0.50 ATR; all three three-bar slopes
    agree.
18. **EMA Dynamic Pullback.** Require the module 17 strict stack locally.
    Fire in stack direction when candle range touches EMA20 or EMA50 and closes
    back trendward. Zone: touched EMA ±0.10 ATR. Confirmations: EMA20 was the
    touched average; rejection wick at least 0.50 ATR; high volume.
19. **MACD Zero-Line Crossover.** SMA-seeded EMA 12/26 MACD line and EMA 9
    signal line. Fire on a MACD-line zero crossing; direction is the crossing
    direction. Zone: crossover candle body. Confirmations: histogram agrees;
    absolute MACD expands; high volume.
20. **Regular RSI Divergence.** Wilder RSI 14. Pair confirmed price pivots
    5–50 bars apart. Bearish requires price extension at least 0.05 ATR and RSI
    lower high by at least 5 points; bullish is inverse. Zone: latest pivot
    rejection wick. Confirmations: prior RSI is at least 70 bearish or at most
    30 bullish; RSI divergence at least 10 points; rejection wick at least
    0.50 ATR.
21. **ADX Trend Acceleration.** Wilder ADX/DI 14. Fire only on
    `previous_adx <= 25 < current_adx` while ADX rises. Direction is BUY when
    `+DI > -DI`, otherwise SELL. Zone: acceleration candle body.
    Confirmations: ADX rise at least 3 points; DI spread at least 10 points;
    candle body at least 0.80 ATR.
22. **Supertrend Directional Flip.** Canonical final-band Supertrend using
    HLC2, Wilder ATR 10, and multiplier 3.0. Fire only on the flip bar. Zone:
    flipped band as a hairline. Confirmations: candle body at least 0.80 ATR;
    close at least 0.25 ATR beyond the band; high volume.

### Pillar 4 — Volatility and Mean Reversion

23. **Bollinger Squeeze Breakout.** SMA 20 and population standard deviation,
    inner bands at 2.0σ. Squeeze means bandwidth at or below its trailing
    100-bar 20th percentile. Fire when close exits a band after a squeeze and
    bandwidth expands. Zone: broken band hairline. Confirmations: bandwidth
    expands at least 25%; close is at least 0.10 ATR beyond band; high volume.
24. **Bollinger Outer Reversion.** SMA 20 with population 2.5σ bands. Fire
    toward the mean when high/low reaches an outer band and the same candle
    closes back inside. Zone: band-to-extreme rejection area. Confirmations:
    overshoot at least 0.10 ATR; wick at least 0.50 ATR; low volume.
25. **VWAP Deviation Touch.** UTC-day anchored VWAP of HLC3 weighted by tick
    volume. Require at least 8 bars after reset. Population deviation uses the
    same anchored observations; outer band is 2.0σ. Fire toward VWAP on a touch
    and same-bar close back inside. Zone: band-to-extreme area.
    Confirmations: overshoot at least 0.10 ATR; wick at least 0.50 ATR; low
    volume. A zero-total-volume anchor is non-evaluable, not guessed.
26. **Keltner Channel Reversal.** EMA 20 of close, Wilder ATR 10, multiplier
    2.0. Fire toward the center when an outer channel is touched and price
    closes back inside while absolute close-to-close momentum has decreased
    for three consecutive bars. Zone: band-to-extreme area. Confirmations:
    overshoot at least 0.10 ATR; wick at least 0.50 ATR; low volume.
27. **ATR Volatility Expansion.** Wilder ATR 14 must be at least 1.50 times its
    trailing 50-bar median. Fire when close also breaks the prior 20-bar high
    or low by 0.05 ATR; direction follows the break. Zone: broken range
    hairline. Confirmations: ATR ratio at least 2.00; body at least 0.80 ATR;
    high volume.
28. **Session Open Range Breakout.** Use London and New York UTC windows from
    `config/sessions.yaml`, on M5/M15 only. Build the first 30-minute high/low.
    Until session end, fire once on the first close beyond either side by
    0.05 ATR. A bar breaking both sides does not fire. Zone: broken range
    boundary hairline. Confirmations: break at least 0.10 ATR; body at least
    0.80 ATR; high volume. The existing UTC-pinned summer profile is used and
    its no-holiday-calendar limitation remains disclosed.

All additional numbers appearing above become named config keys. No detector
threshold remains as a literal in module logic.

## 4. `min_bars`, goldens, and visual gate

Each constructor derives `min_bars` from its injected periods, pivot
confirmation, search age, and indicator warm-up. It is not separately typed by
hand.

Every module receives:

1. synthetic positive, negative, boundary, and short-window tests;
2. an exact recorded-output golden on all three current fixture stores, using
   M15 as the common cohort;
3. a deterministic PNG overlay generated only from saved evidence;
4. a review manifest identifying whether the recorded fixtures contained a
   positive event.

If no recorded positive exists, the recorded zero-fire golden remains valid,
and the positive synthetic geometry image is explicitly labelled synthetic.
Golden regeneration is an explicit command and never automatic on test
failure.

## 5. Guarded full-history cohort

Authorize one analysis-only capture:

| Field | Value |
|---|---|
| Account guard | DEMO only; refuse any live account |
| Server | currently guarded `JustMarkets-Demo2` terminal |
| Symbols | XAUUSD, EURUSD, GBPUSD, BTCUSD |
| Range | `[2025-07-28T00:00:00Z, 2026-07-28T00:00:00Z)` |
| Raw timeframes | H1 and M15 |
| Co-firing timeframe | M15 |
| Regime segmentation | latest closed H1 effective regime |
| Required fields | UTC OHLC, tick volume, recorded spread, SymbolSpec |
| Destination | `data/stage2-history-20260728/` |

This is not a trade backtest and does not need M1 sub-bar data. The capture
must record exact availability/gaps and stop if the guarded terminal cannot
supply a required symbol/timeframe; it may not silently shorten or substitute
the cohort.

## 6. Co-firing and proposal algorithm

The observation unit is `(symbol, M15 close time)`. Attach the most recent
closed H1 regime. Evaluate all 28 modules on the same closed-bar population.

For every module pair and regime, emit:

- fire counts for each member;
- same-direction joint count and joint-bar rate;
- Jaccard rate;
- both conditional rates;
- binary phi correlation;
- opposite-direction conflict count and rate.

“Co-firing” means same-direction simultaneous firing. Opposite-direction
events are reported as conflicts, never counted as agreement.

For a deterministic membership proposal:

1. Use distance `1 - max(phi, 0)`.
2. Apply average-linkage agglomerative clustering.
3. Retain nine clusters for compatibility with the approved scoring contract.
4. Resolve equal-distance ties by the ascending module-ID tuple.
5. If a module fires fewer than 30 times, retain its current §5.1 membership
   provisionally and label it insufficient rather than fitting noise.

Correlation cannot prove predictive value. Therefore the first proposed
measured profile assigns equal independent-evidence weight to the nine
resulting clusters, normalized to exactly 100, and labels that choice
“correlation-derived membership, outcome-uninformed equal weights.” Predictive
weight changes must wait for resolved outcome evidence.

The re-runnable script also regenerates §5.3.1/§5.3.2 reachability tables and a
realised Stage 1 score distribution under the proposal. It writes a proposal
document and artifact files only. It must not edit `config/clusters.yaml`,
`config/scoring.yaml`, or any approved config.

## 7. Authorization effect

The exact authorization string is:

`APPROVE STAGE 2 DETECTOR + HISTORY PROFILE`

It authorizes:

1. applying this detector profile to a new versioned
   `config/strategies.yaml`;
2. implementing all 28 modules and shared pure indicator/geometry helpers;
3. creating recorded goldens and evidence-driven rendered overlays;
4. capturing the exact guarded DEMO history cohort in §5;
5. running the co-firing and calibration proposal in §6;
6. delegating independent module work to sub-agents.

It does not authorize applying the resulting cluster/weight/threshold proposal.
That remains a separate operator gate after the evidence is available.
