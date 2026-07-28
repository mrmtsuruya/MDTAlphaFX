# Proposed Stage 2 evaluation-window profile

Status: **PROPOSED — NOT AUTHORIZED**

Prepared: 2026-07-28  
Requested authorization: `APPROVE STAGE 2 EVALUATION WINDOW PROFILE`

## Why this decision is required

The frozen strategy protocol declares `min_bars` as the lookback required, but
does not say how many bars a caller supplies after that minimum is reached.
The first Stage 2 golden harness supplied an ever-growing prefix. That made
indicator state depend on every bar since the fixture began and makes a
four-symbol one-year replay quadratic.

Replacing that prefix with a rolling window is not merely a speed
optimization. On the approved recorded fixtures:

- module 19 changes from non-firing to `SELL 95` on one final bar;
- modules 17 and 25 retain their firing decision there but emit different
  indicator/evidence values; and
- therefore goldens, co-firing counts, correlation, and proposed membership can
  change.

No caller policy was approved in the detector/history profile. It must be
settled explicitly rather than inferred from the existing test harness.

## Proposed reading

Add this versioned value under `strategies.co_firing`:

```yaml
evaluation_window_policy: COMMON_MAX_MIN_BARS
```

At registry construction, derive:

```text
common_window_bars = max(strategy.min_bars for strategy in registry)
```

For the currently approved detector profile the derived value is exactly
`203`. The number is a receipt, not a second independently editable threshold.

At each eligible M15 close:

1. Supply every one of the 28 modules with the same most recent
   `common_window_bars` closed M15 candles, including the current candle.
2. Never supply a module-specific shorter window.
3. Never supply an ever-growing prefix.
4. Do not evaluate any module until the common window is complete. Label the
   earlier observations `INSUFFICIENT_COMMON_WINDOW`; do not count them as
   non-fires.
5. Derive the window from the immutable registry once at startup and record the
   derived value plus all 28 `min_bars` values in every golden/co-firing
   manifest.

This creates one common evidence horizon for pairwise comparison, is linear in
cohort length, and makes results independent of how long the process happened
to be running before the current 203-bar window.

## H1 regime attachment boundary

The H1 classifier remains a sequential full-series classifier because its
hysteresis is stateful by design and is computed once in linear time.

For an M15 candle with open time `m15_open`, its evaluation instant is
`m15_open + 15 minutes`. Attach the latest effective H1 verdict whose candle
close satisfies:

```text
h1_open + 1 hour <= m15_open + 15 minutes
```

Equality is allowed: the H1 candle and M15 candle have both closed at that
instant. An H1 verdict whose close is later is lookahead and must be refused.
M15 observations before the first ready H1 verdict are labelled
`INSUFFICIENT_H1_REGIME` and excluded, not counted as non-fires.

No economic-calendar dataset exists in the repository. Regime replay therefore
uses the already disclosed Stage 1 `NewsBlackoutFlags.no_blackouts(...)`
reading and stamps `calendar_supplied=false`; the resulting regime and score
evidence remains partial for news-blackout classification.

## Golden and visual evidence effect

After authorization:

1. regenerate all 28 recorded goldens explicitly using the common 203-bar
   policy;
2. review the changed outputs rather than accepting them automatically;
3. rerender all 28 evidence-only PNGs and their hashes; and
4. assert that every module retains a recorded positive.

A dry prospective replay over the three approved fixtures found a recorded
positive for all 28 modules under the common policy. Total firing counts ranged
from 1 (module 10) to 933 (module 17), so no synthetic-only visual fallback is
introduced.

## Measured cluster-ID continuity

The approved regime map is keyed by the semantic ids
`A, B, C, D1, D2, E, F, G, H`. A measured cluster cannot receive one of those
ids merely from its sorted position; doing so would silently attach unrelated
regime permissions to it.

After average-linkage produces nine unlabeled module sets:

1. Keep any current-cluster id already anchored by an insufficient module as
   fixed, exactly as required by the approved insufficient-data policy.
2. For the remaining measured sets and remaining ids, choose the one-to-one
   assignment that maximizes total module overlap with the current membership.
3. If multiple assignments have the same maximum overlap, order measured sets
   by their ascending module-id tuple and choose the lexicographically smallest
   resulting cluster-id tuple.
4. Emit the full measured-set × current-id overlap matrix and the chosen
   assignment. The existing regime map is retained provisionally through this
   maximum-continuity mapping; it is not presented as evidence that correlation
   rediscovered the old semantic meaning.

No new regime-map permissions are inferred from correlation.

## Score-distribution boundary

The approved history cohort contains H1 and M15, not the configured H4 bias
timeframe. It therefore cannot determine the separate §5.2 higher-timeframe
conflict penalty.

The proposal must:

1. resolve measured clusters and produce the observed breadth/quality inputs;
2. compute and label a `pre_htf_score_distribution` with
   `htf_penalty_applied=1.0`;
3. regenerate the theoretical §5.3.1/§5.3.2 reachability tables under the
   proposed mapped cluster weights; and
4. state that a final realised Stage 1 score distribution remains partial until
   H4 bias evidence is supplied.

It must not call the pre-HTF distribution a final emitted-signal distribution,
infer H4 direction from H1, or invent a conflict rate.

## Alternatives deliberately rejected

- **Ever-growing full prefix:** exact to the first harness but quadratic,
  dependent on arbitrary process/capture start, and unsuitable for the
  approved one-year cohort.
- **Per-module `min_bars`:** computationally bounded but gives correlated
  modules different evidence horizons at the same observation.
- **A typed constant such as 203:** duplicates derived strategy configuration
  and becomes stale when an approved module lookback changes.
- **Silent approximation of full-prefix EMA/Wilder state:** would make evidence
  and scores disagree with the actual detector input.

## Authorization effect

The exact authorization string is:

`APPROVE STAGE 2 EVALUATION WINDOW PROFILE`

It authorizes only:

1. adding `COMMON_MAX_MIN_BARS` to versioned Stage 2 configuration;
2. applying the common derived window to recorded goldens, visual evidence,
   co-firing, and the future production strategy scanner;
3. using the exact no-lookahead H1 attachment boundary above; and
4. mapping measured clusters back to semantic ids with the deterministic
   maximum-overlap assignment above;
5. emitting the explicitly partial pre-HTF score distribution and theoretical
   regenerated reachability tables; and
6. regenerating proposal-only Stage 2 artifacts under those policies.

It does not authorize live-account access, order placement, AUTO execution,
Stage 2b, Stage 3, changing detector thresholds, weakening either history-store
boundary, supplying an invented economic calendar, or applying the measured
cluster/weight/threshold proposal.
