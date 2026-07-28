# Proposed Stage 2 recovery addendum

Status: **APPROVED AND APPLIED — 2026-07-28**

Prepared: 2026-07-28  
Requested authorization: `APPROVE STAGE 2 RECOVERY ADDENDUM`

Authorization received: `APPROVE STAGE 2 RECOVERY ADDENDUM` on 2026-07-28.

## Why this narrow addendum is required

The approved Stage 2 detector and history profile exposed three decisions that
were not settled by its algorithm tables:

1. modules 1–10 can find more than one same-direction structure on the same
   evaluation bar, but their result contract permits only one geometry; and
2. the guarded Stage 2 history capture stopped at
   `GBPUSD.m` H1 `2025-10-30T13:00:00Z` because the broker supplied the raw bar
   with `spread=0`; and
3. the co-firing profile names binary phi but does not specify how BUY and SELL
   are encoded without treating opposite-direction fires as agreement.

This addendum settles only those three recovery decisions. It does not implement
them, and it does not reopen any approved detector threshold, history bound,
symbol, timeframe, or cluster rule.

## 1. Same-direction structure collision resolution for modules 1–10

The approved opposite-direction rule is unchanged: if bullish and bearish
conditions both resolve on the same evaluation bar, the module returns
`fired=false`, `direction=NONE`, score zero, and no tradeable geometry.

When two or more candidates from modules 1–10 resolve in the **same direction**
on the same evaluation bar, select exactly one candidate by the following
ascending sort key:

```text
(
  -formation_index,
  raw_zone_width,
  canonical_geometry_tuple,
  stable_source_index_tuple
)
```

The first candidate after sorting is the winner.

### Exact field definitions

1. **`formation_index` — most recent first.** This is the greatest zero-based
   index, within the supplied bar window, of a source bar required to establish
   the candidate's formation. The evaluation/touch/retest bar is excluded
   unless it is itself the bar that establishes the structure. A larger index
   wins.
2. **`raw_zone_width` — narrowest first.** Compute
   `raw_zone_max - raw_zone_min` before broker-digit rounding or the §5.5
   minimum-zone widening. A smaller non-negative width wins.
3. **`canonical_geometry_tuple` — lexicographically smallest first.** For each
   source coordinate, form
   `(role, utc_time_iso, raw_price)`, where:
   - `role` is the module's stable geometry role string;
   - `utc_time_iso` is the source candle's timezone-aware UTC ISO-8601 value;
   - `raw_price` is the unrounded finite price.

   Sort those coordinate triples lexicographically, then compare the resulting
   tuple of triples lexicographically. Dictionary insertion order, candidate
   enumeration order, set order, rounded display prices, and object identity
   are never tie-breakers.
4. **`stable_source_index_tuple` — lowest source indices first.** Collect every
   source bar index used by the formation, remove duplicates, sort ascending,
   and compare the resulting integer tuples lexicographically. If one tuple is
   an exact prefix of the other, the shorter tuple wins.

The ranking is local to one module, direction, symbol, timeframe, and
evaluation bar. It does not compare candidates between different modules and
does not change confidence flags: the selected candidate is scored from its
own evidence only.

This rule applies only to modules 1–10. Modules 11–28 keep their approved
detector semantics.

## 2. Analysis-only history store for raw zero spread

The stopped row is retained as evidence:

| Field | Observed value |
|---|---|
| Broker symbol | `GBPUSD.m` |
| Timeframe | `H1` |
| Bar open | `2025-10-30T13:00:00Z` |
| Recorded spread | `0` points |
| Capture mode | Guarded `DEMO`, analysis only |

The existing `ParquetBarStore` invariant remains unchanged. It must continue to
reject zero spread because it is the replay/cost/backtest store and §11.2 does
not permit silently frictionless pricing.

### Proposed recovery boundary

1. Write the approved Stage 2 H1/M15 history cohort to a **separate
   analysis-only store**, never through `ParquetBarStore`.
2. Preserve every broker field exactly as supplied, including the zero spread.
   Do not drop the bar, replace zero with another value, interpolate, forward
   fill, or substitute a neighbouring spread.
3. Its manifest must contain:

   ```json
   {
     "analysis_only": true,
     "cost_valid": false
   }
   ```

   It must also list every zero-spread row by symbol, timeframe, UTC timestamp,
   and raw value so the anomaly remains auditable.
4. The store and its reader must not implement or masquerade as the production
   `ParquetBarStore`. Replay, cost modelling, execution simulation, outcome
   resolution, trade metrics, and backtests must refuse this store based on its
   type and manifest.
5. The Stage 2 co-firing analysis may read it because co-firing evaluates pure
   detectors and does not price entries, exits, spread, slippage, commission,
   swap, or fills. The raw spread remains present as provenance but is not an
   input to a strategy module.
6. The approved symbols, half-open UTC range, H1/M15 raw timeframes, M15
   co-firing timeframe, and H1 regime attachment remain unchanged.

This is a narrow analytical exception. It does not resolve
`AMBIGUITY-008` for any cost-valid store and does not weaken the rule that a
trade replay refuses zero recorded spread.

## 3. Direction-aware binary phi convention

The observation unit remains one `(symbol, M15 close time)` bar. For the binary
phi calculation only, expand each bar deterministically into two
direction-labelled slots:

```text
(bar, BUY)
(bar, SELL)
```

For each module, a slot is `1` exactly when that module fired in that slot's
direction; otherwise it is `0`. A firing module therefore contributes one
positive slot, never two. With `N` selected bars:

```text
n11 = same-direction joint fire count
n10 = fire_count_a - n11
n01 = fire_count_b - n11
n00 = 2N - n11 - n10 - n01

phi = (n11*n00 - n10*n01)
      / sqrt((n11+n10)(n01+n00)(n11+n01)(n10+n00))
```

If the denominator is zero, emit `0.0` and label the row degenerate rather than
emitting NaN or infinity.

This same direction-labelled event universe defines Jaccard and the two
conditional rates. `fire_count_a` and `fire_count_b` remain ordinary bar fire
counts; `same_direction_joint_bar_rate` and
`opposite_direction_conflict_rate` remain divided by `N` bars. Two modules
firing in opposite directions on the same bar occupy different slots, increase
the explicit conflict count, never increase `n11`, and may drive phi negative.

The clustering distance remains the already approved
`1 - max(phi, 0)`. No signed strategy result, ternary correlation, or
direction-agnostic "both fired" table may substitute for this convention.

## Authorization effect

The exact authorization string is:

`APPROVE STAGE 2 RECOVERY ADDENDUM`

It authorizes only:

1. applying the collision ranking above to modules 1–10 with deterministic
   tests;
2. creating and consuming the separate analysis-only, cost-invalid Stage 2
   history store for detector co-firing; and
3. using the direction-aware binary phi convention above in the co-firing
   matrix and correlation-derived membership proposal.

It does **not** authorize live-account access, order placement, AUTO execution,
Stage 2b, Stage 3, weakening or modifying `ParquetBarStore`, using the
analysis-only store in replay/cost/backtest paths, or applying any measured
cluster, weight, threshold, or configuration proposal.
