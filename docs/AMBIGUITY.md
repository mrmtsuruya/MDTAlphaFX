# Ambiguity register — Stage 0

> "Make agents report ambiguity, and read those reports. They are the most
> valuable output of this build. Every ambiguity an agent finds is a place the
> spec was unclear — and it is far cheaper to fix the spec than to discover the
> misreading in a backtest six months later."
> — *AGENT PROMPTS — Build Kickoff*

**Resolution update, 2026-07-27.** The operator approved
`docs/PROPOSED-SHIPPING-PROFILE.md` with
`APPROVE PROFILE + DELEGATE STAGE 1`. Items marked `APPROVED` below now use
that record's exact reading. Unmarked items remain open; no later value may be
changed without a new approval.

Three prefixes, by origin: unprefixed from the contracts/core pass, `0xx` from
the data layer, `Bxx` from the backtest layer.

**Status legend** — `OPEN` needs your decision · `EVIDENCE` the broker probe
answered it, you just confirm · `APPROVED` settled in the shipping profile ·
`SPEC` the spec itself should change.

---

## Blocking Stage 1

These stop the next stage, not this one.

### AMBIGUITY-001 · `cluster_id` says A–H, §5.1 defines nine clusters · APPROVED

**Approved reading:** ASCII ids `A`, `B`, `C`, `D1`, `D2`, `E`, `F`, `G`, `H`.

**Needed:** the string identifiers for the nine clusters.
**Conflict:** §2 freezes `ClusterResult.cluster_id: str  # "A".."H"` — eight
letters. §5.1 defines **nine** clusters, splitting D into **D₁ Structure
continuation** (module 8) and **D₂ Structure reversal** (modules 7, 11). The
weights do sum to 100 and the 28 modules do partition cleanly, so the *table* is
self-consistent; only the identifier comment is not.
**Candidate readings:** (a) ids are `"D1"`/`"D2"` and the §2 comment is stale;
(b) ids are `"D₁"`/`"D₂"` with Unicode subscripts, which will be retyped wrongly
by hand at least once; (c) D is one cluster of weight 22 and §5.1's split is
presentational — but then the weights no longer sum as tabulated.
**Cost of getting it wrong:** §5.1's startup assertion (membership partitions
1–28, weights total 100) is written against these ids. Reading (c) changes the
score of every signal.
**Note:** the field is `str`, so Stage 0 is not blocked. Settle before Stage 1.

### AMBIGUITY-B03 · swap mode and triple day · APPROVED

**Resolved plumbing:** the connector captures `swap_long`/`swap_short`, the
fixture store persists them beside the symbol metadata, and a recorded replay
passes them to the cost model through `RunSpec.swap_rates`. No frozen
`SymbolSpec` change or `BarSource` widening is required.

**Broker evidence:** `XAUUSD.m`, `EURUSD.m`, `GBPUSD.m`, and `BTCUSD.m` all
report `SYMBOL_SWAP_MODE_POINTS` and Wednesday as the three-day rollover. This
settles the unit and triple weekday for the current four-symbol watchlist,
subject to operator confirmation. Official JustMarkets pages also support
weekend `SKIPPED`; only their contradictory 19/21 UTC rollover clock remains
AMBIGUITY-B04.

The optional `US30.std` and `US500.std` indices report
`SYMBOL_SWAP_MODE_INTEREST_CURRENT` and Friday triple rollover. The current cost
model does not support annual-interest swap calculation, so either index must
remain excluded until that model is added and tested. The config comments
describing the old plumbing gap are stale but cannot be edited by a model under
rule 12.

---

## Costs — a backtest cannot run until these are set

`§11.2: "Frictionless backtests are the most common source of strategies that
work in testing and lose in production."` All of these are enforced: the replay
engine refuses to start rather than defaulting any of them to zero.

### AMBIGUITY-003 · broker-cost values need operator confirmation · APPROVED

**Approved reading:** p99 spread caps 26/47/89/858 points for
XAUUSD/EURUSD/GBPUSD/BTCUSD; commission 0; market/stop slippage 10/20 points.

| Key | Why the spec cannot supply it |
|---|---|
| `symbols.max_spread_points.<SYM>` | §7.3 requires "current spread ≤ `max_spread_points`" and never proposes a value. Per-symbol — a number sane for EURUSD is nonsense for BTCUSD. |
| `costs.commission.per_lot_per_side.<SYM>` | §11.2 says "from broker config". MT5 `symbol_info()` does not expose it, but current official contract specifications identify all four `.m` symbols as commission-free Standard-account instruments. |
| `costs.slippage.market_order_points` / `stop_order_points` | §11.2 gives `0` for limit orders and names `slippage_points` for market and stop orders without proposing one. |

**Evidence now available** for `max_spread_points`, measured over 1440 M1 bars
on your live demo (JustMarkets-Demo2). A value below p95 rejects orders
routinely; a value above max never binds:

| Symbol | p50 | p95 | p99 | max |
|---|---|---|---|---|
| XAUUSD.m | 26 | 26 | 26 | 26 |
| EURUSD.m | 9 | 29 | 47 | 55 |
| GBPUSD.m | 10 | 37 | 89 | 101 |
| BTCUSD.m | 858 | 858 | 858 | 858 |

**Commission evidence:** JustMarkets' current
[suffix guide](https://get.justmarkets.help/hc/en-us/articles/16276884869276-Trading-account-suffixes)
maps `.m` to Standard-account instruments, and its current specifications for
[XAUUSD.m](https://justmarkets.com/markets/commodities/xauusd),
[EURUSD.m](https://justmarkets.com/markets/forex/eurusd),
[GBPUSD.m](https://justmarkets.com/markets/forex/gbpusd), and
[BTCUSD.m](https://justmarkets.com/markets/crypto/btcusd) each state
`0 USD` commission per lot per side. Guarded demo history independently
observed zero commission on 330 XAUUSD trade deals. This supports `0.0` for the
current four symbols; max-spread policy and market/stop slippage remain open.

### AMBIGUITY-B01 · stored OHLC basis · APPROVED

**Approved reading:** `BID`.

The guarded demo probe reports `SYMBOL_CHART_MODE_BID` for every current
watchlist symbol. MetaTrader's official
[chart documentation](https://www.metatrader5.com/en/terminal/help/charts_advanced/charts_settings)
also states that OTC-instrument bars are formed from Bid prices. This supports
`BID`; both readings remain implemented and the operator must confirm the
config value.

### AMBIGUITY-B02 · does the exit pay spread too? · APPROVED

**Approved reading:** `ROUND_TRIP`.

MetaTrader's official
[price-data documentation](https://www.metatrader5.com/en/terminal/help/trading_advanced/price_data)
states that Ask opens longs and closes shorts, while Bid opens shorts and closes
longs. Broker-faithful replay therefore supports `ROUND_TRIP`. The specification
is silent, so both readings remain implemented and the operator must confirm
`costs.spread.charge_on`.

### AMBIGUITY-B04 · weekend rollovers · APPROVED

**Approved reading:** 19:00 UTC, Wednesday triple, weekend `SKIPPED`. The
contradictory 21:00 Help article remains provenance, not an open config value.

**Silent:** §11.2 requires swap "per position per rollover" and the triple
charge covers the weekend — so a rollover instant crossed on Saturday or Sunday
is either already paid for or double-charged, depending on the broker.
JustMarkets' current Forex, commodities, and crypto market pages say weekend
rollovers are not applied and Wednesday is tripled, supporting `SKIPPED` and
Wednesday for the existing four-symbol watchlist. Their rollover clock is
officially contradictory: the category pages state 22:00 GMT+3 (`19:00 UTC`),
while the 2026-03-30
[Help article](https://get.justmarkets.help/hc/en-us/articles/14212716595228-What-Is-Swap)
states 00:00 GMT+3 (`21:00 UTC`). `rollover_hour_utc` therefore still requires
an operator decision or broker confirmation.

### AMBIGUITY-B05 · R is in price units, costs are in currency · OPEN

**Needed:** the conversion point between §11.4's expectancy **in R** and
§11.2's commission and swap **in account currency**.
**Silent:** neither section says how the two meet. A conversion is implemented
so both can be reported, but which figure is canonical is undecided.

---

## Replay semantics

### AMBIGUITY-B08 · where does a bar-close signal fill? · OPEN

**Silent:** a module fires at the close of bar *i*. §11.2 prices a fill;
§5.5/§6.1 describe entry zones and pending orders but are Stage 1. Nothing says
what a bar-close replay does with a market entry.
**Implemented:** `NEXT_BAR_OPEN` only — the earliest instant the engine could
act on information it did not hold until bar *i* closed. Any other value raises.

### AMBIGUITY-B06 · gap fill price · APPROVED

**Approved reading:** `GAPPED_PRICE`.

A bar may *open* beyond a level. That is not §11.1's ambiguity (only one level
is crossed, so the order is known), but the fill price is a separate question
§11.1 does not answer.
**Candidates:** `GAPPED_PRICE` (fill at bar open — a gap through the stop costs
more than the stop distance) or `LEVEL_PRICE` (understates gap risk). Both
implemented; currently `GAPPED_PRICE`, which is **not** a spec statement.

### AMBIGUITY-B09 · positions still open when the data ends · OPEN

Rule 11 says every signal resolves; §11 does not say how to resolve one with no
terminal price. **Implemented:** `REPORT_SEPARATELY` — closed at the last bar's
close, counted, and *excluded* from expectancy, profit factor and win rate, with
the exclusion stated in the report.

### AMBIGUITY-B10 · position size in Stage 0 · APPROVED

**Approved reading:** 0.10 lot for the Stage 0 harness only.

§7.2 derives lots from equity and risk %; that is Stage 5, and Stage 0 has no
equity. `backtest.replay.volume` stays a sentinel rather than becoming an
invented number that silently scales every currency-denominated cost.

### AMBIGUITY-B11 · nothing tells Stage 0 where the levels are · OPEN

§5.5 level derivation is Stage 1. A Stage 0 replay therefore has no specified
source of stop and target. Implemented as a `PlanSource` seam reading named keys
from `StrategyResult.evidence`, so landing §5.5 does not mean editing the replay
loop. The seam is scaffolding, not a spec reading.

### AMBIGUITY-B07 · what supplies the trading calendar? · OPEN

§7.3's sixth condition is "symbol trading session currently open". Neither §7.3
nor §10.1 says what supplies that calendar, and `SymbolSpec` carries no session
fields. **Implemented:** `SESSION_WINDOW_UNION` only — open iff a
`config/sessions.yaml` window contains the instant. It carries **no weekend and
no holiday calendar**, so a Saturday reads as open.

---

## Data layer

### AMBIGUITY-007 · "market closed" vs "data missing" · OPEN — highest impact

**Needed:** the rule `has_m1` uses to detect partial M1 coverage.
**Silent:** §11.1 names "gaps, weekends, deep history" as cases where M1 is
unavailable but gives no recognition rule. There is no trading calendar in the
spec or in `config/`.
**Candidates:** (a) evidence-based — a minute is expected iff a coarser recorded
bar covers it; (b) a per-symbol weekday/hour calendar, wrong for BTCUSD and for
broker holidays; (c) a maximum-tolerable-gap threshold, requiring a number
nobody has specified; (d) treat every absent minute as missing, making `has_m1`
almost always False.
**Implemented:** (a), the conservative direction, documented. A tickless minute
inside an open bar reads as *missing* and forces the §11.1 fallback.
**Cost:** this choice changes every ambiguity-rate number the harness produces.

### AMBIGUITY-008 · broker reports a zero spread · OPEN

**Silent:** §11.2 mandates per-bar recorded spread and says nothing about a
zero-valued field. **Implemented:** refuse the bar at write time.
**This is live, not theoretical** — the probe read `spread now: 0 points` on
EURUSD.m while its M1 history shows a minimum of 9. Under the current rule a
broker that legitimately reports 0 cannot be recorded at all.

### AMBIGUITY-009 · how the server offset is measured · EVIDENCE

**Silent:** §10.1 says "resolve the server offset explicitly at startup" without
naming a source, and says nothing about a market-closed startup.
**Implemented:** freshest tick vs UTC, with a staleness tolerance; refuse to
start when it cannot be measured. **Measured on your broker: +180 minutes
(UTC+03:00).** The 5-second tolerance means measurement only succeeds during
market hours — confirm that is acceptable.

### AMBIGUITY-010 · which name is the store's canonical key · APPROVED

**Approved reading:** persist the broker-resolved `.m` name; accept the base
name only as an input alias.

§7.1 resolves a name, §2's `SymbolSpec.name` is the broker name, and
`BarSource.bars(symbol)` does not qualify which. Both currently resolve to the
same directory, so nothing is blocked — but the canonical form for the journal
(§10.2) and for `Signal.symbol` is open. **Concrete now:** your broker resolves
every symbol with a `.m` suffix, so `XAUUSD` and `XAUUSD.m` are genuinely two
different strings for the same instrument. Settle before Stage 3.

### AMBIGUITY-011 · which `SymbolSpec` fields are invalid at zero · EVIDENCE

§7.1 says "fail loudly if any field is missing" and does not define missing.
**Implemented:** reject zero for `point`, `tick_size`, `tick_value`,
`contract_size`, `volume_min`, `volume_max`, `volume_step`; allow zero for
`digits`, `stops_level`, `freeze_level`.
**Confirmed correct on your broker** — all four symbols report
`stops_level: 0` and `freeze_level: 0`. Had zero been rejected, none would have
resolved.

### AMBIGUITY-012 · which series is evidence of market opening hours · OPEN

The reference timeframe for 007's rule. The spec does not mention one.
**Implemented:** the finest analysis timeframe (currently M5). A coarser
reference means more minutes expected and a higher fallback rate.

### AMBIGUITY-013 · where MT5 credentials come from · OPEN

Appendix B #24 says "pin before writing sizing logic" and stops.
**Implemented:** attach to the account already logged into the running terminal
(this is what the probe did). Note that reading credentials from config would
hash a password into `Config.version` and therefore into every `config_version`
stamped on a signal.

### AMBIGUITY-014 · fixture windows · APPROVED

The original 2025 windows returned analysis bars but zero M1 bars. The operator
approved `docs/PROPOSED-FIXTURE-RECOVERY-ADDENDUM.md` on 2026-07-28. Config now
contains the three approved 2026 selections, and every analysis timeframe plus
M1 was recorded from the guarded `JustMarkets-Demo2` account.

The rejected stores are preserved under
`fixtures/_superseded_2025_20260728/`. The current stores and gate receipt are
described in `docs/FIXTURE-RECOVERY-STATUS.md`.

### AMBIGUITY-017 · zero executable trades in the high-volatility fixture · RESOLVED

The approved high-volatility XAUUSD window has complete analysis coverage,
8,987/9,000 expected M1 bars, and the intended volatility characteristics.
However, all 65 executable trivial-breakout candidates are correctly rejected
by §11.2 because the recorded spread is 28 points while the approved XAUUSD
maximum is 26 points; the final candidate has no next bar.

**Resolved reading:** §9 states the trade/report gate once for recorded history
overall, not once per regime fixture. §11.4 explicitly reports samples below
the trade floor with no conclusions, including zero. The approved recovery
addendum's exhaustive fixture interpretation requires spanning analysis/M1
coverage, gap diagnostics, conservative fallback invariants, and lower-bound
labelling; it does not add a per-period trade minimum.

Therefore a structurally valid zero-trade period qualifies, while the configured
recorded set as a whole must still contain at least one resolved trade and a
rendered metrics report. The recorded set has 33 resolved trades across
trending and ranging, so the unqualified gate passes. The 26-point spread
ceiling and all approved fixture dates remain unchanged.

### AMBIGUITY-004 · H4 bar alignment · OPEN

`floor_to_bar` anchors on midnight UTC. H4 anchoring is broker-dependent in the
general case. Asserted against recorded fixtures rather than trusted — which
means it is **not yet asserted**, because there are no fixtures.

### AMBIGUITY-005 · summer vs winter session windows · OPEN

`config/sessions.yaml` is pinned in UTC, so windows correctly do **not** shift
when London or New York change clocks. That also means the boundaries track the
northern-summer sessions year-round, and the operator may want a second winter
set. The spec does not say.

### AMBIGUITY-016 · `copy_rates_range` bound semantics · VERIFY ON WINDOWS

Not a spec question — a verification item. Request bounds are converted UTC →
server wall clock and passed as aware UTC. Pinned by a test against a double,
but **if this is inverted, every recorded window is silently shifted by the
offset with no error.** Verify on the first real recording by checking a
London-open bar lands at the London open in UTC.

---

## Stage 2 detector layer

### AMBIGUITY-018 · §4 detector definitions are not executable specifications · APPROVED

§4 fixes 28 names and one-line descriptions, while the frozen protocol requires
each module to return a deterministic direction, confidence, evidence geometry,
and honest `min_bars`. The spec does not supply the necessary pivot rules,
lookbacks, equality/touch/break tolerances, most indicator conventions, event
semantics, or module confidence mappings. No approved strategy-parameter config
exists.

**Impact:** all 28 modules are blocked from faithful production implementation.
A plausible technical-analysis default would change detections and the Stage 2
co-firing result while bypassing rule 12.

**Approved resolution:** the exact seed algorithms and values recorded in
`docs/PROPOSED-STAGE2-DETECTOR-HISTORY-PROFILE.md` were authorized with
`APPROVE STAGE 2 DETECTOR + HISTORY PROFILE` on 2026-07-28. They are applied in
`config/strategies.yaml`, the immutable module profiles, all 28 detectors,
recorded goldens, and evidence-only visual charts.

### AMBIGUITY-019 · context words exceed the frozen module input · APPROVED

Modules receive one same-timeframe `list[Candle]` and `SymbolSpec`, with no
regime or higher-timeframe context. Module 8 says “with the macro trend,” module
15 says “off a multi-timeframe key level,” module 18 says “during an active
trend,” and module 24 says “in a ranging market.”

**Approved reading:** module 8 uses confirmed local price structure; module 15
detects against a current-timeframe key level and Stage 3 owns MTF
confirmation; module 18 proves local EMA alignment; module 24 remains
regime-agnostic and Tier 1 owns the RANGING gate. This preserves the frozen
protocol and rule 2.

### AMBIGUITY-020 · full-history co-firing source is absent · APPROVED · RECOVERED

The active fixtures are three short evidence windows. The one-year Stage 1
replay omits tick volume, spread, and linked `SymbolSpec`, so it cannot
reconstruct the frozen `Candle` input or run volume-dependent modules.

**Approved resolution:** record the exact guarded-DEMO H1/M15 cohort and
half-open UTC range specified in
`docs/PROPOSED-STAGE2-DETECTOR-HISTORY-PROFILE.md`. This is analysis-only and
does not request M1 or authorize trading.

The original capture correctly stopped at the raw zero-spread row described by
AMBIGUITY-022. The approved recovery addendum then captured and transactionally
verified the complete cohort in the separate analysis-only/cost-invalid store.
See `docs/STAGE2-HISTORY-RECEIPT.md`.

### AMBIGUITY-021 · same-direction same-bar structure collisions · APPROVED

Modules 1–10 can identify more than one qualifying structure in the same
direction on one evaluation bar, while `StrategyResult` can carry only one
tradeable geometry. The approved detector profile settles opposite-direction
collisions as non-firing but does not select among same-direction candidates.
Depending on loop or collection order would make goldens and co-firing results
implementation-dependent.

**Approved resolution:** use the fully specified ordering in
`docs/PROPOSED-STAGE2-RECOVERY-ADDENDUM.md`: most recent formation index first,
then narrowest raw zone, then the lexicographically smallest canonical geometry
tuple, then the lowest stable source-index tuple. The rule is local to one
module/direction/evaluation and does not compare different modules.

Authorized with `APPROVE STAGE 2 RECOVERY ADDENDUM` on 2026-07-28.

### AMBIGUITY-022 · zero-spread row stops the cost-valid Stage 2 store · APPROVED

The guarded Stage 2 capture stopped on `GBPUSD.m` H1 at
`2025-10-30T13:00:00Z`, where the broker supplied `spread=0`.
`ParquetBarStore` correctly refuses that row because accepting it would allow a
frictionless bar into replay and cost modelling. Dropping, interpolating, or
replacing the value would falsify the approved raw cohort.

**Approved resolution:** preserve the row in a separate analysis-only store
whose manifest states `analysis_only=true` and `cost_valid=false`. That store is
never a `ParquetBarStore` and must be refused by replay, cost, backtest, outcome,
and trade-metric paths. Co-firing may read it because pure detector co-firing
does not price fills. The existing store invariant is neither modified nor
weakened, and `AMBIGUITY-008` remains open for cost-valid history.

Authorized with `APPROVE STAGE 2 RECOVERY ADDENDUM` on 2026-07-28.

### AMBIGUITY-023 · binary phi direction encoding · APPROVED

The approved co-firing profile names binary phi, defines same-direction
simultaneous fires as agreement, and says opposite-direction fires are
conflicts that never count as agreement. A direction-agnostic fire/not-fire
2×2 table would nevertheless put an opposite-direction simultaneous fire in
its joint-positive cell, contradicting that definition. A signed ternary
correlation would no longer be binary phi.

**Approved resolution:** for phi, Jaccard, and conditional rates, expand each
bar into `(bar, BUY)` and `(bar, SELL)` binary slots exactly as specified in
`docs/PROPOSED-STAGE2-RECOVERY-ADDENDUM.md`. Each module occupies at most one
positive slot per bar. Opposite directions occupy different slots, remain in
the explicit conflict metric, never enter the same-direction joint cell, and
may make phi negative. A zero phi denominator emits `0.0` with a degenerate
label.

Authorized with `APPROVE STAGE 2 RECOVERY ADDENDUM` on 2026-07-28. The pure
analysis core and recovered-history proposal may now use this exact formula.

### AMBIGUITY-024 · strategy evaluation window after `min_bars` · APPROVED

The frozen protocol calls `min_bars` the required lookback but does not specify
whether a caller supplies exactly that many bars, one shared rolling window, or
an ever-growing prefix. The original golden harness used full prefixes. A
recorded comparison proved this is semantic: module 19 changed its final-bar
decision under a bounded window, and modules 17/25 changed saved indicator
evidence.

Full-prefix one-year evaluation is also quadratic, while per-module minimum
windows give pairs different evidence horizons.

**Approved resolution:** use the common rolling window derived as the maximum
of all registered module `min_bars` values, currently 203, with the exact
no-lookahead H1 attachment boundary in
`docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md`. Early M15 bars lacking the
common window or a ready closed-H1 verdict are excluded with explicit reason
codes rather than counted as non-fires.

The shared profile was authorized with
`APPROVE STAGE 2 EVALUATION WINDOW PROFILE` on 2026-07-30; golden
regeneration and full-history co-firing may now use only the approved semantics.

### AMBIGUITY-025 · measured cluster labels vs semantic regime ids · APPROVED

Average-linkage returns unlabeled module sets, while §3.4 permissions are keyed
by semantic cluster ids. Assigning ids by sorted output position would attach
arbitrary regime permissions and corrupt the proposed score distribution.

**Approved resolution:** preserve insufficient-module anchors, then choose the
remaining one-to-one cluster-id assignment that maximizes overlap with current
membership; break equal-total-overlap assignments lexicographically as fully
specified in `docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md`. Retain the
current regime map provisionally through that mapping and disclose the overlap
matrix; do not infer new regime permissions from correlation.

### AMBIGUITY-026 · H4 penalty absent from the Stage 2 cohort · APPROVED

The approved co-firing cohort contains H1/M15 only, while `engine.bias_timeframe`
is H4 and §5.2 has a separate higher-timeframe conflict penalty. A final
realised Stage 1 score cannot be reconstructed without H4 bias evidence.

**Approved resolution:** emit observed breadth/quality plus an explicitly
partial `pre_htf_score_distribution` with penalty 1.0, and regenerate
theoretical reachability tables. Never label it a final emitted-signal
distribution or infer H4 from H1.

Authorization `APPROVE STAGE 2 EVALUATION WINDOW PROFILE` was received on
2026-07-30. All three readings are normative for Stage 2 evidence generation;
applying any measured proposal still requires later explicit authorization.

---

## Resolved by the broker probe

### AMBIGUITY-002 · which index CFD · APPROVED

**Approved reading:** defer both indices and clear `watchlist_pending` until the
`INTEREST_CURRENT` swap model exists.

`US30 / NAS100` was left pending. None of the names resolved through the
configured suffix ladder, but a guarded demo probe confirmed exact broker
symbols `US30.std` and `US500.std`. Both are fully tradeable market-execution
index CFDs. The earlier conclusion that this broker exposes no index CFDs was
wrong.

**Operator decision:** add `.std` to the suffix candidates and probe the near
matches before choosing an index, or deliberately exclude indices and remove
`symbols.watchlist_pending`. Adding either index also requires
`INTEREST_CURRENT` swap support (B03).

### AMBIGUITY-015 · report-shaping values introduced by the implementer · FYI

`probe.spread_sample_timeframe: M1`, `spread_sample_bars: 1440`, the 14-entry
index candidate list, and `--top 5`. None is read by `backend/`; each shapes a
report a human reads. Disclosed for review, change freely.

---

## What this leaves you

Stage 0 is closed against the approved profile and recovered DEMO fixtures.
Stage 2 implementation/delegation, detector/history, recovery, and
evaluation-window profiles are authorized. Current work is golden/visual
regeneration and the proposal-only recovered-history co-firing run.

Continue resolving the remaining replay/data ambiguities without changing
approved config silently. Nothing authorizes order placement, AUTO execution,
a live-account connection, Stage 2b, Stage 3, or application of measured
cluster/weight changes.
