# MDTAlphaFX — Quant Platform & Automated Execution Engine

**Specification v2.6** · 26 July 2026
**Supersedes:** `MDTAlphaFX QUANT PLATFORM & AUTOMATED MT5 EXECUTION ENGINE.md`
**Target:** Windows desktop · MetaTrader 5 · personal trading tool

---

## 0. How to use this document

This is the build contract. It is written to be read by AI coding agents as well as by a human, so it favours explicit rules over prose.

**Changes from v1 of the spec:**

- The 3-Tier Execution Pipeline is now specified (§3). It was absent from v1 despite being the architectural core.
- The 28 strategy modules are enumerated individually with IDs (§4), grouped into four pillars.
- **Cluster weighting** replaces flat per-module weighting in the confluence score (§5.2). The modules are not independent; ~28 modules represent ~9 independent signals.
- The confidence score formula is corrected — it previously averaged when it meant to count, and its denominator was ambiguous across regimes (§5.3).
- Execution moves to **native Python `order_send()`**. The MQL5 EA bridge is deferred to Appendix A with rationale.
- Lot sizing, broker constraints, kill switch, idempotency, state reconciliation, and time handling are specified (§7).
- Build order is restructured by dependency rather than by module (§9).

**Changes in v2.1 — threshold calibration and execution modes:**

- **The score threshold is recalibrated (§5.3).** The v2 default of 85 sat near the arithmetic ceiling of the scoring formula; the usable range is roughly 62–93 and 85 demanded five and a half of six clusters. Default is now **70**. §5.3.1 adds the calibration table that makes the number interpretable.
- **Two thresholds, not one (§5.3).** `display_threshold` controls what the user sees; `auto_execute_threshold` controls what fires unattended. A single threshold forces a choice between seeing marginal setups and auto-trading them.
- **Cluster and pillar minimums are configurable and must surface as rejection reasons (§5.3).** At a threshold of 85 they never bound. At 70 they become the binding constraint, and a silent rejection looks like a broken slider.
- **Currency-denominated take profit and trailing stops** are added to the contracts (§2) and execution engine (§7.8).
- **AUTO execution mode is specified (§7.9)** behind its own threshold, its own daily caps, and a demo-only default.
- **Reconciliation moves from startup-only to continuous (§7.6).**
- **Appendix A is rewritten.** The EA is no longer deferred wholesale — it is scoped to *local trailing and breakeven management only*. Entry routing stays in Python.

**Changes in v2.2 — lifecycle, levels, and feature parity:**

Driven by a review against a working reference implementation. The engine was largely right; the *lifecycle around it* was missing.

- **Signal lifecycle state machine (§6.1).** The critical omission. Signals now lock, and locked levels are immutable — v2 recomputed everything on each bar close, so entry, stop and targets drifted underneath a user mid-decision. Each timeframe runs its own lifecycle.
- **The generation gate is inverted (§5.3).** v2 refused to construct a `Signal` below threshold. Now every resolved direction produces a record; `display_threshold` filters the *view*, `auto_execute_threshold` is the only hard gate on action. Validity, visibility and executability are three separate questions.
- **Level derivation is specified (§5.5).** v2 declared `stop_loss` and `take_profit_*` and never said what computes them — a hole that blocked Stage 3. ATR-buffered structural stops, R-multiple targets snapped to structure, `POOR_RR` rejection.
- **Two-sided vote tally (§5.2.1).** A 4-vs-0 and a 4-vs-1 previously produced identical scores. The tally is displayed rather than scored, and a contested signal is auto-ineligible regardless of score.
- **Pattern engine (§6.4).** 16 classical formations as a fully independent advisory layer with its own lifecycle, filters and confidence scale. Never enters any score.
- **Flat-vote compatibility mode (§5.2.2)** for comparison against tools that score by raw module count — available, documented, not recommended, with the reason stated.
- **New views (§8.2):** Market Overview with an on-demand *Analyze Market* sweep, and Signal Center as a re-filterable record of every signal including below-threshold ones.
- **Chart layers and drawing (§8.3),** 18 overlays persisted per symbol and timeframe; **status indicators (§8.4)** for session, feed health and execution posture.
- **Ten interface design principles (§8.2).** Written as deliberate departures from the reference implementation — calm-by-default alerting, sentence-before-number, direction never encoded by colour alone, lifecycle-driven visual state.
- **§11 Backtesting & validation.** M1 sub-bar intrabar resolution, mandatory cost modelling, walk-forward as the only permitted parameter search, and segmented reporting. Global optimisation over this parameter space is explicitly prohibited.

**Changes in v2.3 — closing the feedback loop:**

- **§12.1 Outcome resolver.** v2.2 defined terminal states but nothing that reached them, so every untaken signal would have sat at `LOCKED` indefinitely. Taken signals resolve from broker deal history; untaken ones resolve by bar replay through the same §11.1 resolver. Untaken outcomes are first-class data — the system authored the levels, so the broker is only needed to confirm fills.
- **§12.2 Excursion analysis.** MAE, MFE, capture ratio, stop utilisation and entry efficiency for every signal. This is what answers "did we enter too early or too late" and "could we have made more" — questions win/loss cannot address.
- **§12.3 Notification guardrails.** Per-signal regret alerts on ignored signals are prohibited; counterfactual results report in aggregate on a cadence. Live "you missed +2R" notifications train the user out of the selectivity the score exists to provide.
- **§12.4 Three-tier review loop.** Measure automatically, LLM proposes in prose, human approves with walk-forward validation and immutable versioned configs. §10.5's one-way rule is extended: the model never feeds a score and never writes a config.
- **§12.5 Sample-size discipline,** with explicit floors, and a note that regime classification — not weight learning — is what actually makes the system responsive to a changing market.

**Changes in v2.4 — gate audit.** A pass over the signal path looking for contradictions and unreachable thresholds found four:

- **`auto_execute_threshold` lowered 88 → 80.** At 88, five of six clusters at quality 95 scores 87.7 — AUTO required all six firing at ≥95 average and uncontested, which is the same unreachable-ceiling mistake v2.1 was written to fix. 80 is 5 of 6 at quality 90.
- **TRANSITIONAL uplift lowered +8 → +5.** The regime's smaller denominator (57 vs 68) meant +8 demanded 4 of 5 clusters at quality 90+, materially stricter than intended. §5.3.1 now carries a per-regime calibration table instead of TRENDING only.
- **Level-derivation ordering contradiction fixed (§5.5).** Levels were specified as computed at lock, but `POOR_RR` is a validity condition and validity precedes lock. Levels are now provisional at `AWAITING_VALIDATION` and frozen on transition to `LOCKED`.
- **Two emergent behaviours documented rather than left implicit:** counter-trend signals cannot auto-execute at any quality once §3.5's 0.6 penalty applies, and `min_pillars` in RANGING depends on a single module or a single cluster for its second pillar (§5.3).

**Changes in v2.5 — making the scoring layer legible.** No behaviour changes; three things that were implicit are now written down.

- **§5.1.1 Clusters and pillars.** The two groupings are orthogonal and were being conflated. Pillars group by *method* (4, the §4 headings, organise the UI); clusters group by *observation* (9, carry the weights). The cross-cut matrix shows which clusters span pillars and why that is deliberate. Also recorded: the nine weights sum to exactly 100 and the 28 modules partition across clusters with no gaps or overlaps — both now startup assertions.
- **§5.2 The ceiling is 100.** A real bound, not an asymptote — but quality rarely exceeds 93–95, so the practical maximum is about 95, and counter-trend caps at 60 after the 0.6 penalty.
- **§5.3.2 Reachability.** What an 80 or a 90 costs in clusters and quality, why five- and six-cluster agreement is structurally uncommon (the enabled set contains retracement and expansion clusters that describe opposite price behaviour, so only a fresh break-and-retest fires both families), and the ALPHA tuning table for use if Stage 1 shows the distribution is too compressed. The stated rule is to tune ALPHA rather than lower a threshold, since lowering a threshold to meet a compressed distribution only relabels the same signals.

**Changes in v2.6 — §13 Front-end architecture & design system.** §8.2 had principles but no system, so nothing said what a new view should look like.

- **Stack pinned:** React 19 + TypeScript, Next.js App Router with `output: 'export'`, Tailwind v4 (CSS-first `@theme`), shadcn/ui copy-in, TanStack Query v5, Motion, native View Transitions API, lightweight-charts v5.
- **Static export is a constraint, not a preference.** No Node runtime, so no Server Components at runtime, no middleware, no request-time APIs, and `generateStaticParams` on every dynamic route. §1's single-process invariant survives intact — FastAPI is still the only process.
- **Two deliberate exclusions.** GSAP is not used; it overlaps Motion by roughly 80% and running both means two engines and mixed idioms. React's `<ViewTransition>` component is not used; it remains canary/experimental as of mid-2026, and the native browser call is stable.
- **Design tokens (§13.2)** as CSS custom properties, readable from both component code and the chart overlay layer. Two font weights, every number monospaced, and `--color-alert` reserved for the single `ENTRY_HIT` band.
- **A 20-component inventory (§13.4)** with defined states. Five components exist specifically to make §8.2's principles unbreakable in code — `ScoreDisplay` cannot render a score without its breadth and quality, enforced by props rather than convention.
- **Motion policy (§13.6):** never animate a value the user reads to decide. Prices, scores and levels snap; transitions and list changes animate; `prefers-reduced-motion` disables rather than shortens.
- **§13.7 add-a-view recipe** and **§13.8 accessibility checklist** — the answer to "what will it look like if I add a tab."

**Non-negotiable rules.** These appear again in `CLAUDE.md` at the repo root:

1. Strategy modules are **pure functions of a bar window**. No I/O, no global state, no network calls.
2. A strategy module **never reads the regime**. Tier 1 gates modules externally. Modules that check regime internally smear Tier 1 across 28 files and destroy testability.
3. **All times are UTC internally.** Convert only at the display boundary.
4. **No order is placed without an idempotency key.**
5. **No test connects to a live account.** A module-level guard raises unless the account is demo.
6. Evaluation happens **on bar close**, not on tick.
7. **AUTO execution defaults to off, and to demo.** Enabling it on a live account requires an explicit per-symbol toggle plus a deliberately-set environment variable (§7.9).
8. **A suppressed signal must record why.** Every gate rejection writes its failing condition to the journal. A filter the user cannot see is a filter they will misconfigure.
9. **A locked signal is immutable.** Once levels freeze, no later evaluation may change the side, entry, stop or targets of that signal (§6.1). Recomputation is the bug this rule exists to prevent.
10. **The pattern engine never enters a score.** It is advisory, separately configured, and cannot override a Smart Analyzer decision (§6.4).
11. **Every signal resolves.** Taken or not, each locked signal reaches a terminal state with an `OutcomeRecord` (§12.1). Real and replayed outcomes are never aggregated without labels.
12. **No model writes config.** The LLM reads computed statistics and proposes in prose. Weight, threshold and level changes require walk-forward validation and explicit human approval, shipped as immutable versioned configs (§12.4).

---

## 1. System architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       WINDOWS DESKTOP SYSTEM                         │
│                                                                      │
│  ┌────────────────────────────┐        ┌──────────────────────────┐  │
│  │   BROWSER UI (React SPA)   │◄──────►│  PYTHON FASTAPI ENGINE   │  │
│  │   lightweight-charts       │  WS +  │                          │  │
│  │   served from FastAPI      │  REST  │  Tier 1  Regime Gate     │  │
│  └────────────────────────────┘        │  Tier 2  28 Modules      │  │
│                                        │  Tier 3  Confluence      │  │
│                                        │          Score           │  │
│                                        │  ───────────────────     │  │
│                                        │  Risk Guards             │  │
│                                        │  Execution Manager       │  │
│                                        │  SQLite State Store      │  │
│                                        └────────────┬─────────────┘  │
│                                                     │                │
│                                          MetaTrader5 Python API      │
│                                          (data in, orders out)       │
│                                                     │                │
│                                        ┌────────────▼─────────────┐  │
│                                        │  METATRADER 5 TERMINAL   │  │
│                                        └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**Single process, single connection.** The Python engine is the only component that talks to MT5. It reads market data and places orders through the same `MetaTrader5` session. There is no HTTP polling bridge in the execution path.

**Components:**

| Component | Technology | Responsibility |
|---|---|---|
| Quant engine | Python 3.11+, FastAPI, uvicorn | Pipeline, scoring, risk, execution |
| Market data & orders | `MetaTrader5` package | Bars, symbol metadata, `order_send()` |
| State | SQLite | Signals, decisions, orders, audit log |
| UI | React 19 + Next.js (static export) + Tailwind v4, served by FastAPI | Charts, signal review, approval — see §13 |
| Charting | `lightweight-charts` | Candles + overlays |
| LLM (optional) | One provider behind an interface | Async rationale text only |

---

## 2. Core data contracts

Defined as Pydantic models in `backend/contracts/`. **Frozen before any module work begins.** Changing these later invalidates every strategy module.

```python
from enum import Enum
from pydantic import BaseModel
from datetime import datetime

class Timeframe(str, Enum):
    H4 = "H4"; H1 = "H1"; M15 = "M15"; M5 = "M5"; M1 = "M1"

class Regime(str, Enum):
    TRENDING_BULLISH = "TRENDING_BULLISH"
    TRENDING_BEARISH = "TRENDING_BEARISH"
    RANGING          = "RANGING"
    VOLATILE_NEWS    = "VOLATILE_NEWS"
    TRANSITIONAL     = "TRANSITIONAL"      # no confident classification

class Direction(str, Enum):
    BUY = "BUY"; SELL = "SELL"; NONE = "NONE"

class SignalState(str, Enum):
    """Lifecycle. Advances forward only — never returns to an earlier state.
    Tracked independently per timeframe (§6.1)."""
    SCANNING          = "SCANNING"           # no candidate on this timeframe
    FORMING           = "FORMING"            # structure building, no entry zone yet
    AWAITING_VALIDATION = "AWAITING_VALIDATION"  # candidate found, confirmation pending
    LOCKED            = "LOCKED"             # levels frozen, waiting for price
    ENTRY_HIT         = "ENTRY_HIT"          # price in the zone — decide now
    TAKEN             = "TAKEN"              # operator accepted (or AUTO fired)
    IGNORED           = "IGNORED"            # operator declined
    MONITORING        = "MONITORING"         # position live, tracking to SL/TP
    CLOSED_TP         = "CLOSED_TP"
    CLOSED_SL         = "CLOSED_SL"
    TOO_LATE          = "TOO_LATE"           # price ran past the zone — do not chase
    EXPIRED           = "EXPIRED"            # ttl elapsed untriggered

class Candle(BaseModel):
    time: datetime          # UTC
    open: float; high: float; low: float; close: float
    tick_volume: int
    spread: int

class SymbolSpec(BaseModel):
    """Resolved once at startup. Never assume these values."""
    name: str                    # broker-resolved, e.g. "XAUUSD.m"
    digits: int
    point: float
    tick_size: float
    tick_value: float            # in account currency
    contract_size: float
    volume_min: float
    volume_max: float
    volume_step: float
    stops_level: int             # min SL/TP distance in points
    freeze_level: int

class StrategyResult(BaseModel):
    module_id: int               # 1..28
    module_name: str
    fired: bool
    direction: Direction
    score: float                 # 0..100, module's own confidence
    evidence: dict               # levels/coords for chart overlay

class ClusterResult(BaseModel):
    cluster_id: str              # "A".."H"
    cluster_name: str
    fired: bool
    direction: Direction
    score: float                 # best or mean of firing members
    contributing_modules: list[int]

class VoteTally(BaseModel):
    """Both sides of the argument. A 4-vs-0 and a 4-vs-1 are not the same
    signal, and a score that hides the opposition is not interpretable."""
    buy_votes: int
    buy_points: float            # Σ (cluster score × weight) / 10, BUY side
    sell_votes: int
    sell_points: float
    contested: bool              # both sides have ≥1 vote
    leading_contributor: str     # module_name of the highest-scoring firing module

class TimeframeState(BaseModel):
    timeframe: Timeframe
    regime: Regime
    regime_confidence: float     # 0..1
    bars_in_regime: int
    breadth: float               # 0..1, clusters agreeing / clusters available
    quality: float               # 0..100, weighted mean of firing clusters
    score: float                 # 0..100, final composite
    direction: Direction
    state: SignalState           # this timeframe's own lifecycle position
    votes: VoteTally
    clusters: list[ClusterResult]
    modules: list[StrategyResult]

class ExitPlan(BaseModel):
    """How the position is closed. Price levels and currency targets coexist —
    whichever triggers first wins. Trailing is evaluated only after activation."""
    stop_loss: float
    take_profit_1: float
    take_profit_2: float | None

    # Currency-denominated exit, in account currency. None disables.
    tp_currency: float | None = None      # close at +X account currency
    sl_currency: float | None = None      # close at -X account currency

    # Trailing. None disables. Distances in points.
    trail_activate_points: int | None = None   # profit before trailing arms
    trail_distance_points: int | None = None   # gap maintained behind price
    trail_step_points: int | None = None       # min move before stop is amended
    breakeven_at_r: float | None = 1.0         # move stop to entry at N×R

class GateOutcome(BaseModel):
    """Written for every evaluation, passing or failing. Rule 8."""
    passed: bool
    failed_conditions: list[str]   # e.g. ["MIN_CLUSTERS", "MAX_SPREAD"]
    score: float
    breadth: float
    quality: float
    display_threshold: float
    auto_execute_threshold: float

class Signal(BaseModel):
    signal_id: str               # UUID — the idempotency key
    fingerprint: str             # 7-char base36 of signal_id — for humans and support
    created_at: datetime         # UTC
    locked_at: datetime | None   # when levels froze; None before LOCKED
    expires_at: datetime         # resolved wall-clock, not a bar count
    age_bars: int                # bars elapsed on the entry timeframe since lock
    symbol: str
    direction: Direction
    order_type: str              # MARKET | BUY_LIMIT | SELL_LIMIT | BUY_STOP | SELL_STOP
    score: float
    breadth: float               # 0..1 — never omitted, see §8.2 display rule
    quality: float               # 0..100
    votes: VoteTally             # entry-timeframe tally
    entry_zone: dict             # {"min": float, "max": float}
    exit_plan: ExitPlan
    sl_basis: str                # human-readable, e.g. "1.06 ATR below swing low"
    htf_regime: Regime           # regime of the bias timeframe
    entry_timeframe: Timeframe
    timeframes: dict[Timeframe, TimeframeState]
    mtf_aligned: str             # "1/5" — timeframes agreeing with this direction
    state: SignalState
    gate: GateOutcome
    displayed: bool              # score >= display_threshold (a FILTER, not a gate)
    auto_eligible: bool          # score >= auto_execute_threshold AND symbol enabled
    pattern_context: "PatternResult | None"   # advisory only, never scored (§6.4)
    config_version: str          # stamped at lock — makes the signal explicable later
    outcome: "OutcomeRecord | None"           # written once, at resolution (§12.1)
    llm_rationale: str | None    # populated asynchronously, never scored

class OrderIntent(BaseModel):
    signal_id: str               # same key — enforces idempotency
    symbol: str
    order_type: str
    volume: float                # already rounded to volume_step
    price: float | None          # None for market orders
    stop_loss: float
    take_profit: float
    exit_plan: ExitPlan          # currency targets + trailing, managed post-fill
    magic: int = 999888
    comment: str
    origin: str                  # MANUAL | AUTO — recorded, never inferred later

class ExcursionMetrics(BaseModel):
    """Trade quality, independent of win/loss. All values in R (§12.2).
    Computed for every signal — taken or not."""
    mae_r: float                 # max adverse excursion: worst drawdown before resolution
    mfe_r: float                 # max favourable excursion: best unrealised gain reached
    mae_bar: int                 # bars after lock at which MAE occurred
    mfe_bar: int
    realised_r: float            # 0.0 for untaken signals
    capture_ratio: float         # realised_r / mfe_r — how much of the move was kept
    stop_utilisation: float      # |mae_r| / 1.0 — fraction of risk budget actually used
    entry_efficiency: float      # 0..1, fill vs best price offered in the zone
    bars_to_resolution: int

class OutcomeRecord(BaseModel):
    """Terminal record for one signal. Written once, never amended (§12.1)."""
    signal_id: str
    resolved_at: datetime
    final_state: SignalState     # CLOSED_TP | CLOSED_SL | EXPIRED | TOO_LATE
    source: str                  # BROKER | REPLAY — never conflated in a statistic
    counterfactual: bool         # True when the signal was never taken

    # Populated from broker deal history when source == BROKER.
    close_reason: str | None     # TP | SL | STOP_OUT | CLIENT | EXPERT
    close_price: float | None
    realised_pnl: float | None   # account currency, net of swap and commission

    excursion: ExcursionMetrics
    ambiguous_fill: bool         # resolved by §11.1 fallback rather than sub-bar walk
    config_version: str          # which scoring/level config produced this signal

class PatternState(str, Enum):
    FORMING            = "FORMING"             # geometry detected, watch only
    READY              = "READY"               # all filters passed, plan valid
    CONFIRMED_FILTERED = "CONFIRMED_FILTERED"  # breakout formed, a rule blocked entry
    INVALIDATED        = "INVALIDATED"

class PatternResult(BaseModel):
    """Produced by the pattern engine (§6.4). Advisory. Never enters any score."""
    formation: str               # one of the 16 in §6.4
    timeframe: Timeframe
    state: PatternState
    direction: Direction         # bias only
    confidence: float            # 0..100, the engine's own — not the §5 score
    target_r: float              # projected reward:risk from the measured move
    entry_zone: dict | None
    stop_loss: float | None
    take_profit: float | None
    blocked_by: list[str]        # populated when CONFIRMED_FILTERED
    geometry: dict               # coordinates for chart overlay

class ChartLayerState(BaseModel):
    """Persisted per (symbol, timeframe). 18 layers across 4 groups (§8.3)."""
    symbol: str
    timeframe: Timeframe
    enabled: dict[str, bool]     # layer_id -> on/off
    drawings: list[dict]         # user annotations, free-form geometry

class ExecutionReceipt(BaseModel):
    signal_id: str
    submitted_at: datetime
    retcode: int
    order_ticket: int | None
    position_ticket: int | None
    filled_volume: float
    filled_price: float | None
    broker_comment: str
```

---

## 3. Tier 1 — Market Regime Classifier

Runs **before** strategy evaluation. Determines context and gates which strategy clusters may contribute.

### 3.1 Classification inputs

| Input | Purpose |
|---|---|
| ADX(14) | Trend strength |
| EMA(20/50/200) alignment & slope | Trend direction and structure |
| ATR(14) as percentile of trailing 100 bars | Volatility level |
| Linear regression R² over 50 bars | Trend cleanliness vs. chop |
| Economic calendar proximity | News blackout |

### 3.2 Classification rules

Evaluated in order; first match wins.

```
IF within news_blackout_window        → VOLATILE_NEWS
ELIF atr_percentile > 90              → VOLATILE_NEWS
ELIF adx > adx_trend_enter (27)
     AND ema_stack_aligned
     AND r_squared > 0.60             → TRENDING_BULLISH or TRENDING_BEARISH
ELIF adx < adx_range_enter (20)
     AND atr_percentile < 60          → RANGING
ELSE                                  → TRANSITIONAL
```

### 3.3 Hysteresis — required

A regime flipping every few bars swaps half the strategy library in and out and makes signals appear and vanish. Two mechanisms, both mandatory:

**Asymmetric thresholds.** Enter TRENDING at ADX > 27; exit only below 22. Enter RANGING at ADX < 20; exit above 25. The dead band between prevents oscillation.

**Confirmation bars.** A new classification must hold for `regime_confirm_bars` (default **3**) consecutive closed bars before it takes effect. Until confirmed, the previous regime remains active and `regime_confidence` decays toward 0.

`TRANSITIONAL` is exempt from confirmation — degrading to uncertain should be immediate.

### 3.4 Regime → cluster enablement

Clusters are defined in §5.1. `SUPPRESSED` means members return `fired=False` regardless of pattern.

| Cluster | TRENDING | RANGING | VOLATILE_NEWS | TRANSITIONAL |
|---|---|---|---|---|
| A · Imbalance | ✅ | ✅ | ⛔ | ✅ |
| B · Zone retest | ✅ | ✅ | ⛔ | ✅ |
| C · Stop hunt & reject | ✅ | ✅ | ⛔ | ✅ |
| D₁ · BOS continuation | ✅ | ⛔ | ⛔ | ⛔ |
| D₂ · CHoCH / QM reversal | ✅ ¹ | ✅ | ⛔ | ✅ |
| E · Trend stack | ✅ | ⛔ | ⛔ | ⛔ |
| F · Momentum divergence | ✅ ¹ | ✅ | ⛔ | ✅ |
| G · Envelope reversion | ⛔ | ✅ | ⛔ | ⛔ |
| H · Volatility expansion | ✅ | ⛔ | ⛔ | ⛔ |

¹ `COUNTER_ONLY`. In TRENDING, clusters D₂ and F may only contribute **against** the trend direction, as early-reversal warnings. They cannot add conviction to a with-trend signal, and are excluded from that signal's scoring denominator (§5.2).

The map has three states, not two — `ENABLED` (✅), `COUNTER_ONLY` (✅¹) and `SUPPRESSED` (⛔). Implementing it as a boolean loses the distinction and silently mis-scores every trending signal.

**VOLATILE_NEWS generates no new signals at all.** Existing positions are managed; pending orders are cancelled (§7.5).

**TRANSITIONAL** applies a signal threshold uplift of **+5** and a position size multiplier of 0.5. See §5.3.1 — at +8 the regime's smaller denominator made the gate accidentally stricter than intended.

### 3.5 Per-timeframe classification

Regime is classified **independently on each timeframe**. An H4 uptrend routinely contains a ranging M15.

- A module must pass **its own timeframe's** regime gate.
- The **bias timeframe** (default H4, configurable) does not veto lower timeframes. Instead, a signal opposing the bias-timeframe regime receives a **weight penalty of 0.6** on its final score.

This keeps counter-trend setups available at reduced conviction rather than banning them — which matters because cluster F is the most orthogonal signal in the library and is inherently counter-trend.

---

## 4. Tier 2 — The 28 strategy modules

All enabled modules evaluate in parallel on every closed bar. Each returns a `StrategyResult`.

### Pillar 1 — Smart Money Concepts / ICT (10)

| ID | Module | Detects |
|---|---|---|
| 1 | Bullish FVG Fill | Price dips into a 3-candle imbalance gap |
| 2 | Bearish FVG Fill | Price rallies into an overhead sell-side gap |
| 3 | Bullish Order Block | Mitigation of last down-candle before a structural break |
| 4 | Bearish Order Block | Mitigation of last up-candle before a collapse |
| 5 | Sell-Side Liquidity Sweep | Price pierces prior equal lows, grabbing stops, then reverses |
| 6 | Buy-Side Liquidity Sweep | Price spikes above equal highs, trapping breakout buyers |
| 7 | Change of Character (CHoCH) | First structural swing break signalling potential reversal |
| 8 | Break of Structure (BOS) | Structural continuation break with the macro trend |
| 9 | Breaker Block Mitigation | Failed order block flipped into support/resistance |
| 10 | Liquidity Void Re-alignment | Rapid rebalancing of aggressive low-volume displacement |

### Pillar 2 — Price Action & Pivots (6)

| ID | Module | Detects |
|---|---|---|
| 11 | Quasimodo Level Reversal | Over-extended HH then LL returning to the left shoulder |
| 12 | Support-to-Resistance Flip | Broken horizontal key level retested from the opposite side |
| 13 | Supply / Demand Zone Retest | Institutional order-imbalance area retest |
| 14 | Double Bottom / Top Validation | Equal high/low test with volume exhaustion |
| 15 | Pinbar / Hammer Exhaustion | Long-wick rejection off a multi-timeframe key level |
| 16 | Engulfing Cluster | High-volume candle absorbing previous candle wicks |

### Pillar 3 — Trend & Momentum (6)

| ID | Module | Detects |
|---|---|---|
| 17 | Triple EMA Alignment | EMA 20 > 50 > 200 (or inverse) |
| 18 | EMA Dynamic Pullback | Price touching EMA 20 or 50 during an active trend |
| 19 | MACD Zero-Line Crossover | Momentum crossing into positive/negative territory |
| 20 | RSI Divergence (Regular) | Price HH with RSI LH — reversal warning |
| 21 | ADX Trend Acceleration | ADX rising above 25 |
| 22 | Supertrend Directional Flip | Trailing band flipping beneath/above price |

### Pillar 4 — Volatility & Mean Reversion (6)

| ID | Module | Detects |
|---|---|---|
| 23 | Bollinger Squeeze Breakout | Volatility contraction into explosive expansion |
| 24 | Bollinger Outer Reversion | Touch of 2.5σ band in a ranging market |
| 25 | VWAP Deviation Touch | VWAP stretched to extreme deviation |
| 26 | Keltner Channel Reversal | Channel touch with momentum slowdown |
| 27 | ATR Volatility Expansion | ATR spike validating breakout speed |
| 28 | Session Open Range Breakout | London/NY first-30-minute high/low break |

### 4.1 Module interface

```python
class Strategy(Protocol):
    module_id: int
    module_name: str
    cluster_id: str
    min_bars: int                       # lookback required

    def evaluate(self, bars: list[Candle], spec: SymbolSpec) -> StrategyResult:
        """Pure function. No I/O. No regime awareness. No global state."""
```

---

## 5. Tier 3 — Confluence & scoring

### 5.1 Correlation clusters

The 28 modules are **not independent evidence**. Several detect the same market event under different names. A flat per-module vote counts one observation many times and produces maximum confidence in exactly the conditions where trend-following is most dangerous.

Modules are therefore grouped into **9 clusters**, and weight is assigned per cluster, not per module.

| Cluster | Modules | Underlying observation | Base weight |
|---|---|---|---|
| **A** Imbalance | 1, 2, 10 | Low-volume displacement being rebalanced | 11 |
| **B** Zone retest | 3, 4, 9, 12, 13 | Price returning to a flipped/institutional zone | 12 |
| **C** Stop hunt & reject | 5, 6, 14, 15, 16 | Liquidity swept, then rejected | 12 |
| **D₁** Structure continuation | 8 | Trend-confirming structural break | 11 |
| **D₂** Structure reversal | 7, 11 | Trend-breaking structural shift | 11 |
| **E** Trend stack | 17, 18, 19, 21, 22 | Price is trending, measured five ways | 12 |
| **F** Momentum divergence | 20 | Momentum diverging from price | 11 |
| **G** Envelope reversion | 24, 25, 26 | Price stretched from central tendency | 10 |
| **H** Volatility expansion | 23, 27, 28 | Contraction resolving into expansion | 10 |

**The nine weights sum to exactly 100, and all 28 modules appear exactly once.** Both are invariants: a startup assertion checks that cluster membership partitions 1–28 with no gaps and no overlaps, and that the weights total 100. A module in two clusters would be double-counted; a module in none would be silently dead. Neither failure is visible at runtime without the check.

> **These weights are a starting hypothesis derived from reading the module definitions, not a measurement.** Stage 2 includes a task to build an empirical co-firing matrix over historical data and replace this table with measured cluster membership and weights. Weights live in `config/clusters.yaml` and are never hard-coded.

#### 5.1.1 Clusters and pillars are two different groupings

This is the most common point of confusion in the design, so it is stated plainly: **pillars and clusters both group the same 28 modules, along different axes, for different purposes.**

- **Pillars** group by **method** — how the module reasons. There are 4, they are the §4 headings, and they organise the Strategy Lab UI.
- **Clusters** group by **observation** — what market event the module detects. There are 9, and they carry the weights.

They cut across each other, which is the entire point. One market event can be detected by several methods, so a cluster can span pillars:

| Cluster | w | Pillar 1 · SMC/ICT | Pillar 2 · Price action | Pillar 3 · Trend/momentum | Pillar 4 · Volatility/MR |
|---|---|---|---|---|---|
| A · Imbalance | 11 | 1, 2, 10 | | | |
| **B · Zone retest** | 12 | 3, 4, 9 | 12, 13 | | |
| **C · Stop hunt & reject** | 12 | 5, 6 | 14, 15, 16 | | |
| D₁ · Structure continuation | 11 | 8 | | | |
| **D₂ · Structure reversal** | 11 | 7 | 11 | | |
| E · Trend stack | 12 | | | 17, 18, 19, 21, 22 | |
| F · Momentum divergence | 11 | | | 20 | |
| G · Envelope reversion | 10 | | | | 24, 25, 26 |
| H · Volatility expansion | 10 | | | | 23, 27, 28 |

Bold rows span two pillars — the same event seen two ways.

**Why both are needed.** Clusters prevent double-counting: cluster E is five modules and one vote, cluster F is one module and one vote, and neither is worth more for having more parts. Pillars provide an independent sanity check while cluster membership is still a hypothesis — if three clusters fire but every contributing module comes from one methodology, the "three independent confirmations" are probably one observation wearing three hats. §5.3's `min_pillars` is that check, and it counts pillars among **firing modules**, not among firing clusters.

**Cluster resolution.** A cluster fires if **any** enabled member fires. Its direction is the majority direction of firing members; ties resolve to `NONE` and the cluster does not fire. Its score is the **maximum** score among firing members agreeing with that direction.

### 5.2 Score computation

Two distinct quantities. Do not collapse them into one number without keeping both visible.

```python
# Only clusters enabled by the current regime are considered.
available = [c for c in CLUSTERS if enabled_in(regime, c)]
firing    = [c for c in available if c.fired and c.direction == signal_direction]

breadth = sum(c.weight for c in firing) / sum(c.weight for c in available)

quality = (sum(c.score * c.weight for c in firing)
           / sum(c.weight for c in firing)) if firing else 0.0

score = 100 * (breadth ** ALPHA) * (quality / 100)      # ALPHA default 0.5
score *= htf_alignment_penalty                           # 1.0 aligned, 0.6 opposing
```

**Why this shape.** `breadth` rewards agreement across *independent* clusters — the conviction signal. `quality` reflects how strong those confirmations are. A weighted mean alone falls when a fourth confirmation arrives at below-average strength, which contradicts the intent that more agreement means more conviction. Separating the terms fixes that.

### 5.2.1 Vote tally — both sides of the argument

`score` describes only the winning side. A setup where four clusters say SELL and none say BUY, and one where four say SELL and one says BUY at strength 96, produce an identical score. They are not the same trade.

```python
def tally(clusters, regime, trend_direction) -> VoteTally:
    buy  = [c for c in clusters if c.fired and c.direction == Direction.BUY
            and enabled_in(regime, c, Direction.BUY,  trend_direction)]
    sell = [c for c in clusters if c.fired and c.direction == Direction.SELL
            and enabled_in(regime, c, Direction.SELL, trend_direction)]
    pts  = lambda cs: sum(c.score * c.weight for c in cs) / 10.0
    return VoteTally(
        buy_votes=len(buy),   buy_points=pts(buy),
        sell_votes=len(sell), sell_points=pts(sell),
        contested=bool(buy) and bool(sell),
        leading_contributor=max(buy + sell, key=lambda c: c.score).top_module,
    )
```

The tally is **displayed, not scored** — it does not modify `score`. Folding opposition into the composite would double-count the regime gate, which has already suppressed the clusters that should not be speaking. What it does do is mark `contested=True`, and §5.3 uses that.

Rendered as in the reference UI: `BUY — 1 vote / 96 pts | SELL — 4 votes / 296 pts`. The user needs to see that the one dissenting vote is the strongest single reading on the chart.

### 5.2.2 Flat-vote compatibility mode

`scoring_mode: CLUSTERED | FLAT` in `config/scoring.yaml`, default **CLUSTERED**.

`FLAT` weights every module equally and skips the §5.1 collapse, reproducing the behaviour of tools that score by raw module count. It exists so the two can be compared on the same history in the Backtester, and because you may want to reproduce a third-party number.

**It is not recommended, and the reason is mechanical.** Under FLAT, enabling all 28 modules raises the score simply because five trend modules all fire on the same trend — the score rises with the number of *detectors* pointed at an event, not with the amount of *evidence*. The inflation is largest in a strong, extended trend, which is exactly where trend-continuation entries fail. The Stage 2 co-firing matrix will quantify this; until then, treat any FLAT score above 90 as an artefact of module count.

**The ceiling is 100, not 99.** Since `score` reduces to `√breadth × quality`, breadth 1.0 with quality 100 yields exactly 100. It is a real bound, not an asymptote. In practice `quality` rarely exceeds 93–95 — a cluster's score is the maximum of its firing members, so quality above 90 means every contributing cluster had a near-textbook detection — which puts the realistic ceiling around 95. Counter-trend signals cap at **60**, because §3.5's 0.6 penalty is applied after the formula.

**The denominator is the enabled set, not all clusters.** If suppressed clusters remained in the denominator, the maximum achievable score would differ per regime and a threshold of 85 could be unreachable in one regime and routine in another, with nothing surfacing the discrepancy.

**Conditionally-enabled clusters are excluded from the denominator for signals they cannot support.** In TRENDING, clusters D₂ and F are marked ✅¹ in §3.4 — enabled, but permitted to fire only *against* the trend. A with-trend BUY can never earn their weight, so scoring it against a denominator that includes them understates breadth by roughly 25%. `enabled_in(regime, cluster, signal_direction)` therefore takes the candidate direction as an argument:

```python
def enabled_in(regime, cluster, direction, trend_direction) -> bool:
    state = REGIME_CLUSTER_MAP[regime][cluster.id]   # ENABLED | COUNTER_ONLY | SUPPRESSED
    if state == "SUPPRESSED":   return False
    if state == "COUNTER_ONLY": return direction != trend_direction
    return True
```

Working denominators under the §5.1 weights: **TRENDING with-trend = 68** (A, B, C, D₁, E, H) · **TRENDING counter-trend = 22** (D₂, F) · **RANGING = 67** (A, B, C, D₂, F, G) · **TRANSITIONAL = 57** (A, B, C, D₂, F).

### 5.3 Signal gate — validity, visibility, and execution are three different questions

**Construct the `Signal` object whenever a direction resolves.** Scoring is cheap; the bars are already loaded. A score of 41 is a real observation and belongs in the journal.

The three questions are answered separately, and conflating them was the central error in v2:

| Question | Governed by | Effect when it fails |
|---|---|---|
| Is this structurally valid? | **Validity gate** below | `Signal` recorded, never shown, cannot be taken |
| Should the user see it? | `display_threshold` (70) | Recorded and queryable, hidden from default views |
| May it fire unattended? | `auto_execute_threshold` (80) | Shown and takeable by hand, never auto-executed |

**Validity gate.** These are structural facts, not preferences. Failing any of them means the setup is not tradeable at any score:

| # | Condition | Config key | Default |
|---|---|---|---|
| 1 | ≥ N distinct clusters firing in agreement | `min_clusters` | 3 |
| 2 | ≥ N distinct pillars represented | `min_pillars` | 2 |
| 3 | Regime is not `VOLATILE_NEWS` | — | always |
| 4 | Spread ≤ `max_spread_points` | per symbol | — |
| 5 | No conflicting open position on the symbol | — | always |
| 6 | Bias timeframes not in mutual conflict (§5.4) | — | always |

Rule 2 exists because cluster membership is a hypothesis until measured; pillar diversity is a cheap independent check against the same failure. **Every failing condition is recorded, not just the first** — `GateOutcome.failed_conditions` carries all of them.

**Rule 2 has a narrow structural dependency worth knowing before you tune it.** Mapping clusters to pillars:

| Cluster | Pillars represented |
|---|---|
| A, D₁ | 1 only (SMC/ICT) |
| B, C, D₂ | 1 and 2 |
| E, F | 3 only (Trend & Momentum) |
| G, H | 4 only (Volatility & MR) |

In TRENDING, a second pillar must come from B, C, E or H. In RANGING it must come from B, C, D₂, F or G — and **F is a single module** (20, RSI divergence), while G is the only Pillar-4 cluster available. So `min_pillars = 2` in RANGING leans on either one module firing or one cluster. A pure-SMC confluence of A + B + D₂ where only the Pillar-1 members fire will clear `min_clusters` and fail `min_pillars`.

That is arguably correct — three SMC clusters reading the same displacement is exactly the correlation the rule guards against — but it is a real constraint, not a formality. Revisit it after the Stage 2 co-firing measurement, and check the journal for `MIN_PILLARS` rejection frequency before assuming the rule is inert.

**`display_threshold` is a filter, not a gate.** It sets `Signal.displayed`; it never prevents construction. The consequences are the point:

- The Signal Center can answer *"what would I have caught at 65?"* by re-filtering existing records — no re-run, no lost history.
- The Backtester can sweep the threshold across one pass over history instead of one pass per setting.
- Lowering your filter surfaces yesterday's near-misses immediately, which is how you learn where your number should be.

`display_threshold` rises by 5 in TRANSITIONAL, matching §3.4.

**`auto_execute_threshold`** (default **80**) is the only hard gate on action, checked in §7.9. It must be ≥ `display_threshold`; a config that inverts them fails validation at startup. A `contested` tally (§5.2.1) makes a signal **auto-ineligible regardless of score** — if the strongest single reading on the chart argues the other way, that is a decision for a person.

**80, not 88.** At 88 the auto gate is effectively unreachable: 5 of 6 clusters at quality 95 scores 87.7, so AUTO would require all six firing at ≥95 average *and* uncontested — plausibly once or twice a year. That is the same error this section was written to correct, reintroduced one paragraph later. 80 corresponds to 5 of 6 clusters at quality 90, uncontested, which is a defensible bar for unattended execution.

### 5.3.1 Threshold calibration — read before changing the default

`score = 100 × breadth^0.5 × quality/100` simplifies to `√breadth × quality`. Two consequences follow, and neither is obvious from the formula:

- A threshold above the achievable `quality` is **unreachable at any breadth**. At quality 90, a threshold of 91 can never be met.
- The `min_clusters` rule imposes a floor on the score. Three of six clusters is breadth ≈ 0.53, so no emitted signal scores below ≈ 62 in TRENDING regardless of the threshold.

The dial therefore has real travel only between roughly **62 and 93**. Scores in TRENDING (denominator 68), by cluster count:

| Clusters agreeing | Breadth | quality 85 | quality 90 | quality 93 |
|---|---|---|---|---|
| 3 (the `min_clusters` floor) | 0.53 | 61.8 | 65.5 | 67.7 |
| 4 | 0.69 | 70.7 | 74.8 | 77.3 |
| 5 | 0.85 | 78.5 | 83.1 | 85.9 |
| 6 (all enabled) | 1.00 | 85.0 | 90.0 | 93.0 |

**Why the default is 70.** It corresponds to four of six clusters at typical quality — a genuine confluence, with headroom above it to tighten. The v2 default of 85 required five and a half of six and was reachable only at quality ≥ 85, which made the top of the slider inert: raising it from 85 to 90 did not filter signals, it stopped them entirely.

**Guidance for the operator.** 62–68 is near-noise and exists mainly for the journal. 70–78 is the working band. 80–85 is high-conviction and appropriate for `auto_execute_threshold`. Above 90 the system is effectively off.

#### Per-regime calibration — the table above is TRENDING only

Denominators differ per regime (§5.2), so the same threshold means different things. Clusters needed at quality 90:

| Regime | Denominator | Clusters available | Display 70 needs | Auto 80 needs |
|---|---|---|---|---|
| TRENDING, with-trend | 68 | 6 | 4 of 6 | 5 of 6 |
| RANGING | 67 | 6 | 4 of 6 | 5 of 6 |
| TRANSITIONAL | 57 | 5 | 4 of 5 *(at 75)* | 4 of 5 |
| TRENDING, counter-trend | 22 | 2 | 2 of 2, ×0.6 penalty | unreachable |

**Counter-trend signals cannot auto-execute, arithmetically.** With both clusters firing at quality 95, breadth 1.0 gives 95, then §3.5's 0.6 penalty takes it to 57 — below even the display threshold. Counter-trend setups therefore surface only through the Radar and Signal Center, never as auto candidates, and rarely as displayed signals. That is a defensible outcome but it was emergent rather than designed, so it is now stated.

**TRANSITIONAL's uplift is +5, not +8.** At +8 the threshold becomes 78, which 4 of 5 clusters cannot reach at quality 85 (76.4) — the regime would need 4 of 5 at quality 90+, stricter than TRENDING's 4 of 6 by a wide margin. +5 lands it at 75, which 4 of 5 clears at quality 85. TRANSITIONAL remains stricter than TRENDING, which is the intent; it is no longer accidentally near-prohibitive.

**These figures assume `ALPHA = 0.5` and the §5.1 hypothesised weights.** The Stage 2 co-firing measurement will change the weights and therefore this whole table. Regenerating it is part of that task, not an afterthought — a stale calibration table is worse than none, because the operator will trust it.

### 5.3.2 Reachability — what an 80 or a 90 actually costs

§5.3.1 gives the thresholds. This gives the shape of the achievable region, because a threshold you can technically configure and never observe is not a setting, it is a wall.

Resulting score in TRENDING (denominator 68, ALPHA 0.5):

| Clusters agreeing | Breadth | q80 | q85 | q90 | q95 | q100 |
|---|---|---|---|---|---|---|
| 3 of 6 | 0.53 | 58 | 62 | 65 | 69 | 73 |
| 4 of 6 | 0.69 | 67 | 71 | 75 | 79 | **83** |
| 5 of 6 | 0.85 | 74 | 79 | **83** | **88** | **92** |
| 6 of 6 | 1.00 | **80** | **85** | **90** | **95** | **100** |

- **To reach 80:** four clusters need quality 96, five need 87, six need 80.
- **To reach 90:** five clusters need quality 97.5, six need 90. **Nothing below five clusters can reach 90 at any quality.**

#### Why five- and six-cluster agreement is structurally uncommon

The enabled cluster set in TRENDING contains members that describe opposite price behaviour:

| Behaviour | Clusters | What price is doing |
|---|---|---|
| Returning to a level | A, B, C | Retracing into an imbalance, zone or swept level |
| Leaving with force | D₁, H | Breaking structure, volatility expanding |
| Mixed | E | EMA alignment is a state; the pullback returns, the momentum leaves |

A clean pullback fires A, B, C and E — four clusters, ~75 at quality 90. A clean breakout fires D₁, H and part of E — three clusters, ~65. **Neither archetype reaches 80 on its own.**

Five or six clusters requires price to be simultaneously breaking away *and* returning to a level, which describes one specific structure: **a break-and-retest with the break still fresh** — D₁ has fired, H's ATR is still elevated, and price has come back into the zone A, B and C are watching. That is a recognised high-quality setup, so the score peaking there is coherent design rather than an artefact. It also means 80+ should be uncommon and 90+ genuinely rare, and that AUTO at 80 with the uncontested requirement will fire seldom.

**Frequency is not derivable from this table.** It depends on real cluster co-firing rates, which is precisely what the Stage 2 co-firing matrix measures and what Stage 1's score-distribution replay reveals. Do not estimate it; measure it.

#### If 80+ proves too rare, tune ALPHA — not the threshold

Lowering a threshold to meet a compressed distribution just relabels the same signals. `ALPHA` changes the shape of the mapping. Scores at quality 90:

| ALPHA | 3 clusters | 4 clusters | 5 clusters | 6 clusters |
|---|---|---|---|---|
| **0.5** (default) | 65 | 75 | 83 | 90 |
| 0.4 | 70 | 78 | 84 | 90 |
| 0.3 | 74 | **81** | 86 | 90 |
| 0.2 | 79 | 84 | 87 | 90 |

At ALPHA 0.3 a four-cluster confluence reaches 80 without moving any threshold.

**The trade-off is real.** A lower ALPHA means breadth matters less and quality carries more weight — which erodes the anti-correlation protection the clustering layer exists to provide. At ALPHA 0.2, three clusters score 79 against five clusters' 87, and the distinction the whole scoring layer was built to draw begins to disappear. Note also that ALPHA has no effect at all on the six-cluster row, since 1.0 raised to any power is 1.0; it only redistributes the partial-agreement band.

**Recommendation:** hold ALPHA at 0.5 through Stage 1, plot the realised score distribution over a year of replay, and set it from that. Appendix B decision 6.

### 5.4 Multi-timeframe combination

Each timeframe produces its own `TimeframeState`. They are **not** averaged into one number.

- **Bias timeframe** (default H4) establishes directional context.
- **Entry timeframe** (user-selected, default M15; M1/M5 in Scalping Mode) generates the signal.
- Disagreement is surfaced, not resolved. The UI shows every timeframe's state.

Encoded interpretation rules:

| Pattern | Meaning | Action |
|---|---|---|
| HTF agrees, LTF disagrees | Right idea, wrong timing | Route to Opportunity Radar as pending/forming |
| HTF disagrees, LTF agrees | Counter-trend | Apply 0.6 penalty; size down |
| HTF split (H4 vs H1 conflict) | No coherent context | Suppress signal |

### 5.5 Level derivation — entry zone, stop, targets

v2 declared `entry_zone`, `stop_loss` and `take_profit_*` as fields and never said what produces them.

**Ordering matters and is easy to get wrong.** Levels are computed at `AWAITING_VALIDATION` as *provisional* values, because §5.3's validity gate includes `POOR_RR`, which cannot be evaluated before a target exists. They are then **frozen on transition to `LOCKED`** and immutable thereafter. Computing them at lock — as an earlier draft of this section said — makes the validity gate reference values that do not yet exist.

```
AWAITING_VALIDATION  →  derive levels (provisional, may be recomputed each bar)
                     →  run validity gate, including POOR_RR
        LOCKED       →  freeze. Nothing recomputes them. §6.1 rule 1 applies.
```

**Entry zone.** The leading contributor's own structure defines it — an order block's body, an FVG's gap, a sweep's rejection wick. Each module returns these coordinates in `StrategyResult.evidence`; the zone is that range, widened to a minimum of `min_zone_atr` × ATR(14) (default 0.15) so a hairline zone is not unfillable.

**Stop loss.** Structure first, volatility as the floor:

```python
def derive_stop(direction, zone, swing, atr, spec: SymbolSpec) -> tuple[float, str]:
    # 1. Anchor beyond the structure the setup depends on.
    anchor = swing.low if direction == Direction.BUY else swing.high

    # 2. Buffer past it, so a wick through the level is not a stop-out.
    buffer = atr * sl_buffer_atr            # default 0.25
    stop   = anchor - buffer if direction == Direction.BUY else anchor + buffer

    # 3. Floor: never tighter than min_sl_atr × ATR from the zone edge.
    edge     = zone["min"] if direction == Direction.BUY else zone["max"]
    min_dist = atr * min_sl_atr             # default 1.0
    if abs(edge - stop) < min_dist:
        stop = edge - min_dist if direction == Direction.BUY else edge + min_dist

    # 4. Broker floor (§7.3). Widen, never tighten.
    if abs(edge - stop) / spec.point < spec.stops_level:
        stop = _widen_to_stops_level(edge, direction, spec)

    basis = f"{abs(edge - stop) / atr:.2f} ATR beyond {swing.label}"
    return round(stop, spec.digits), basis
```

`sl_basis` carries that string to the UI — *"1.06 ATR below swing low"* — because a stop the user cannot explain is a stop they will move.

**Targets.** R-multiples off the realised stop distance, then snapped to structure:

- `R = |entry_mid − stop_loss|`
- TP1 = entry ± `tp1_r` × R (default **1.5**)
- TP2 = entry ± `tp2_r` × R (default **3.0**), `None` if no structure supports it
- Each target is pulled back to just inside the nearest opposing level (prior swing, unfilled FVG, session high/low) within `snap_atr` × ATR (default 0.5). Never pushed out — snapping may only reduce the target.

**Rejection.** If TP1 after snapping yields less than `min_rr` (default **1.2**) against the stop, the signal fails validity with `POOR_RR`. A correct read of the chart with no room to the next level is not a trade.

**Every constant above lives in `config/levels.yaml`.** They are the parameters most likely to need per-symbol tuning — a 0.25 ATR buffer on XAUUSD is not a 0.25 ATR buffer on EURUSD in practice, because the wick distributions differ.

---

## 6. Signal lifecycle, Radar, Scanner & Patterns

### 6.1 Signal lifecycle

**The single most important behaviour in the system, and absent from v2.** Without it, every module re-evaluates on each bar close and the entry zone, stop and targets drift underneath a user who is mid-decision. A signal that changes while you look at it cannot be acted on.

```
SCANNING ──► FORMING ──► AWAITING_VALIDATION ──► LOCKED ──► ENTRY_HIT ──┬─► TAKEN ──► MONITORING ──┬─► CLOSED_TP
    ▲                                               │            │      │                          └─► CLOSED_SL
    │                                               │            │      └─► IGNORED
    └───────────────── EXPIRED ◄────────────────────┴────────────┴─► TOO_LATE
```

| State | Meaning | Levels |
|---|---|---|
| `SCANNING` | No candidate on this timeframe | — |
| `FORMING` | Structure building, entry zone not yet definable | none |
| `AWAITING_VALIDATION` | Direction resolved; waiting for `regime_confirm_bars` and validity gate | provisional |
| `LOCKED` | Levels frozen. Price has not reached the zone | **immutable** |
| `ENTRY_HIT` | Price inside the zone — decide before this bar closes | **immutable** |
| `TAKEN` / `IGNORED` | Operator decided, or AUTO fired | immutable |
| `MONITORING` | Position live; later scans observe only | immutable |
| `CLOSED_TP` / `CLOSED_SL` | Resolved. Terminal — outcome and excursion written per §12.1 | immutable |
| `TOO_LATE` | Price passed the zone by > `chase_tolerance_atr` × ATR, or reached TP1 untaken | immutable |
| `EXPIRED` | `signal_ttl_bars` elapsed without a trigger | immutable |

**Locking rules — non-negotiable:**

1. On entering `LOCKED`, `entry_zone`, `exit_plan`, `direction`, `score`, `breadth`, `quality` and `votes` are frozen. `locked_at` and `expires_at` are stamped. **Nothing recomputes them.**
2. Later evaluations on the same timeframe **cannot change the side or the levels** of a locked signal. They may only advance its state, or produce a *separate* candidate that queues behind it.
3. One active locked signal per (symbol, timeframe). A second candidate while one is locked is recorded and queued, not merged.
4. Once `TAKEN` or `MONITORING`, later scans are **monitoring only** until SL or final TP. The engine stops looking for a reason to change its mind about a position it already holds.
5. `age_bars` increments on each entry-timeframe close after `locked_at`. It is display state and never affects levels.

**Per-timeframe independence.** M1, M5, M15, H1 and H4 each run their own lifecycle. H4 sitting in `MONITORING` does not stop M15 from locking a new signal — that is the point of multi-timeframe analysis, and §5.4's penalties already handle disagreement. `TimeframeState.state` carries each one; `Signal.state` reflects the entry timeframe.

**How independence coexists with §5.4's suppression rule.** These look contradictory and are not. §5.3 validity rule 6 suppresses a signal when the **bias timeframes disagree with each other** — H4 says TRENDING_BULLISH while H1 says TRENDING_BEARISH — because there is then no coherent context to trade into. It does not suppress a lower timeframe for disagreeing with the bias; that case draws §3.5's 0.6 penalty and stays available. So: bias-vs-bias conflict blocks, bias-vs-entry conflict penalises, and every timeframe still advances its own lifecycle regardless.

**Why `AWAITING_VALIDATION` is a distinct state.** A candidate exists but confirmation is pending, and the user should see *"waiting for validation"* rather than nothing. A blank panel is indistinguishable from a broken feed.

### 6.2 Opportunity Radar

Tracks setups that have not yet triggered — the `FORMING`, `AWAITING_VALIDATION` and `LOCKED` states of §6.1, before price arrives.

- Emits pending order types: `BUY_LIMIT`, `SELL_LIMIT`, `BUY_STOP`, `SELL_STOP`.
- Each row shows its lifecycle state, `age_bars`, and the resolved `expires_at` as wall-clock local time — not "12 bars", which requires the user to do arithmetic to know if they have time to act.
- `TOO_LATE` rows are shown, **not hidden**, labelled *do not chase*. Removing them teaches nothing; showing them teaches the user what chasing would have cost.
- Setups expire after `signal_ttl_bars` (default 12 bars on the entry timeframe) without triggering.

### 6.3 Multi-pair scanner

- Scans a configurable watchlist concurrently.
- Ranks by score descending, with filters for minimum score and direction.
- Displays regime and cluster breadth per row, not just the score.
- Uses the shared per-(symbol, timeframe, bar) evaluation cache — the scanner and analyzer must not compute the same bars twice.

**Correlation warning.** The scanner surfaces simultaneous setups across pairs, which makes correlated exposure *more* likely, not less. Portfolio guards (§7.4) apply at the account level and will block correlated entries even when each individual signal is valid.

### 6.4 Pattern engine

A **separate, independent** classical chart-pattern recogniser. It runs alongside the 28 modules, has its own controls, its own confidence number and its own lifecycle.

**Independence is the defining constraint.** Pattern output never enters any §5 score, never changes a cluster, and never overrides a Smart Analyzer decision. It attaches to a `Signal` as `pattern_context` for context only, and produces its own standalone plans that the user may act on separately. Enabling or disabling formations leaves the 28-strategy engine bit-for-bit unchanged — enforced by test, not convention.

**The 16 formations.**

| Bullish | Bearish |
|---|---|
| Double Bottom | Double Top |
| Inverse Head & Shoulders | Head & Shoulders |
| Bullish Channel | Bearish Channel |
| Bull Flag | Bear Flag |
| Bullish Rectangle | Bearish Rectangle |
| Bullish Pennant | Bearish Pennant |
| Bullish Triangle | Bearish Triangle |
| Bullish Wedge | Bearish Wedge |

**Lifecycle.** Distinct from §6.1 and deliberately more conservative:

| State | Meaning |
|---|---|
| `FORMING` | Geometry detected on completed candles. **Watch only — no entry, no plan.** |
| `READY` | Breakout candle completed and every enabled filter passed. A plan exists. |
| `CONFIRMED_FILTERED` | Breakout formed but a rule blocked entry. Recorded with `blocked_by`, so a filter that rejects everything is visible rather than mysterious. |
| `INVALIDATED` | Geometry broken before confirmation. |

**Detection runs on completed candles only.** A pattern half-drawn by a live candle is not a pattern; it is a hope. This is stricter than §6.1, which may lock intrabar.

**Configuration** — `config/patterns.yaml`, independent of every other config file:

| Setting | Default | Note |
|---|---|---|
| `pattern_engine_enabled` | on | Master switch |
| `scan_timeframes` | M5, M15, H1, H4 | M1 available, off by default — geometry on M1 is mostly noise |
| `min_confidence` | 65 / 100 | The engine's own scale, unrelated to §5 scores |
| `min_target_r` | 1.5 | Measured-move projection against pattern stop |
| `forming_report_after` | 12 candles | Before this, geometry is not reported at all |
| `confirmed_plus` | 3 candles | Candles beyond the breakout before a plan is issued |
| `require_trend_alignment` | **required** | Pattern direction must agree with its timeframe's regime |
| `require_breakout_retest` | optional | |
| `require_volume_expansion` | optional | |
| `allowed_formations` | 16 / 16 | Individually toggleable |

**Two confidence scales now exist and they must never be shown adjacent without labels.** A pattern confidence of 63 and a Smart Analyzer score of 63 mean different things on different scales. The UI prefixes pattern figures — *"Bearish Wedge · pattern 63"* — and the API namespaces them under `pattern_context`.

**Monitor view.** A report of all forming and formed patterns, filterable by `ALL / READY / FORMING / FILTERED / BUY / SELL`, with the count of each state surfaced as header stats: forming watchlist, ready plans, confirmed-but-filtered, timeframes monitored.

---

## 7. Execution engine

Native Python via `MetaTrader5.order_send()`. No HTTP bridge on the entry path. Appendix A explains why entry routing stays in Python and what the EA is narrowed to.

### 7.1 Symbol resolution

At startup, for every watchlist symbol:

1. Resolve the broker's actual symbol name (suffix variants: `XAUUSD`, `XAUUSD.m`, `XAUUSDm`).
2. Call `symbol_info()` and populate `SymbolSpec`.
3. Fail loudly if any field is missing. **Never assume digits, point value, or lot step.**

### 7.2 Lot sizing

```python
def calculate_lots(equity, risk_pct, entry, stop_loss, spec: SymbolSpec) -> float:
    risk_amount = equity * (risk_pct / 100.0)

    sl_distance_points = abs(entry - stop_loss) / spec.point
    if sl_distance_points < spec.stops_level:
        raise StopTooCloseError(sl_distance_points, spec.stops_level)

    # Value of one point, for one lot, in account currency.
    value_per_point = spec.tick_value * (spec.point / spec.tick_size)

    raw = risk_amount / (sl_distance_points * value_per_point)

    steps = math.floor(raw / spec.volume_step)
    lots  = round(steps * spec.volume_step, 8)

    if lots < spec.volume_min:
        raise VolumeBelowMinimumError(lots, spec.volume_min)
    return min(lots, spec.volume_max)
```

Rounding is **down** to `volume_step`, never up — rounding up silently exceeds the risk budget.

### 7.3 Broker constraint checklist

Every order must satisfy these before submission:

- SL/TP distance ≥ `stops_level` points from current price.
- Price not within `freeze_level` of market for modify/cancel operations.
- Volume rounded to `volume_step`, within `[volume_min, volume_max]`.
- Prices normalised to `digits`.
- Current spread ≤ `max_spread_points`.
- Symbol trading session currently open.

Handle these return codes explicitly rather than treating any non-`TRADE_RETCODE_DONE` as fatal: requote, price off, invalid stops, no money, market closed, invalid volume, and partial fill.

### 7.4 Portfolio risk guards

Checked before every entry. Any failure blocks the order and logs the reason.

| Guard | Default |
|---|---|
| Risk per trade | 1.0% of equity |
| Max daily loss | 3.0% → halt new signals until next server day |
| Max total open risk | 5.0% of equity |
| Max open positions | 5 |
| Max positions per symbol | 1 |
| **Max correlated exposure** | 2 positions sharing a currency leg |
| Max spread | Per-symbol, in points |
| News blackout | ±15 min around high-impact events |
| Max AUTO trades per day | 3 (§7.9, counted separately from manual) |

Correlation is computed from currency legs: XAUUSD long, EURUSD long and GBPUSD long all carry short-USD exposure and count against the same limit.

### 7.5 Regime transition policy

When the regime on the bias timeframe changes while positions or orders are live:

| Object | Policy |
|---|---|
| Pending orders from the old regime | **Cancel.** A BUY_LIMIT justified by a trend is not justified once the trend is gone. |
| Open position, new regime = TRANSITIONAL | Hold; move stop to breakeven if in profit ≥ 1R. |
| Open position, new regime opposes direction | Tighten stop to breakeven or last swing, whichever is closer. Do not add. |
| Open position, new regime = VOLATILE_NEWS | Hold with existing stop. Do not modify during the event. |

This policy is configurable but must be explicit — an unhandled regime flip under an open position is the most expensive undefined behaviour in the system.

### 7.6 Idempotency & state

- `signal_id` (UUID) is generated once and carried through `Signal` → `OrderIntent` → `ExecutionReceipt`.
- Before submission, the execution manager checks SQLite for an existing receipt with that `signal_id`. If one exists, the order is **not** resubmitted.
- The `signal_id` is written into the order `comment` field so broker-side records can be reconciled.

**Startup reconciliation** — mandatory, runs before any new signal generation:

1. Fetch all open positions and pending orders with magic `999888`.
2. Compare against SQLite's recorded intent.
3. Positions at the broker with no local record → log loudly, surface in UI, do not auto-close.
4. Local records with no broker counterpart → mark closed/expired, reconcile realised P&L.
5. Block trading until an operator acknowledges any discrepancy.

**Continuous reconciliation** — the same comparison on a timer, default every **5 seconds**, independent of the bar-close cycle:

- Positions close without the engine's involvement — stop-outs, take-profits, margin calls, manual closes in the terminal, broker-side liquidation. A startup-only sync means the engine's view of open risk is wrong from the first stop-out until the next restart, and §7.4's portfolio guards are computed against that stale view.
- The loop updates position state, realised P&L, and live risk usage. It does **not** place, modify or cancel orders — reconciliation observes, the execution manager acts.
- A discrepancy that appears at runtime (broker position with no local record) raises the same halt as at startup. Reconciliation is not permitted to auto-resolve it.
- Runs on `asyncio`, not in the evaluation path. A slow MT5 call must never delay bar-close evaluation.

Trade-status sync is cheap and prevents an entire class of silent risk-accounting error. Build it with §7.4, not after.

### 7.7 Kill switch

One control, reachable in a single click from any UI view, **and** as a standalone script runnable when the API is down:

1. Stop signal generation.
2. Cancel all pending orders with magic `999888`.
3. Optionally flatten all open positions (separate confirmation).
4. Write a halt flag to SQLite that survives restart.

Build this before the first live order, not after it is needed.

### 7.8 Position management — currency targets & trailing

Price-level SL/TP alone cannot express "close at +$50", and a static stop cannot lock in a move that has already happened. Both live in `ExitPlan` (§2) and are evaluated by a management loop on the same 5-second timer as §7.6's reconciliation.

**Currency-denominated exits.** `tp_currency` / `sl_currency` are checked against the position's *floating* P&L in account currency, inclusive of swap and commission — the number the user sees in the terminal, not a synthetic gross figure. Whichever triggers first, price level or currency target, closes the position. Currency exits are executed as an explicit close, never by amending TP, so a partial fill or requote on the close does not silently orphan the price-level TP.

**Trailing.** Arms only once floating profit exceeds `trail_activate_points`, then maintains `trail_distance_points` behind the extreme favourable price. The stop is amended only when it would move by at least `trail_step_points` — without that hysteresis, the loop issues an order-modify every tick and the broker will throttle or reject.

Constraints, all mandatory:

- A trailing stop may only move **in the direction of profit.** A bug that walks a stop backwards converts a winner into an unbounded loser. Assert it in code, not in review.
- Respect `stops_level` and `freeze_level` (§7.3). A trail computing a stop inside the freeze band produces a rejected modify every cycle.
- Breakeven at `breakeven_at_r` (default 1.0R) is applied once and is not re-evaluated afterwards.
- Do not modify during `VOLATILE_NEWS` — this is the §7.5 policy and it overrides trailing.

**Trailing runs in Python and stops when Python stops.** That is the gap Appendix A addresses.

### 7.9 AUTO execution mode

Signals may be routed without operator approval. This is the highest-risk feature in the system and is gated accordingly.

**Preconditions — all required, checked per signal:**

1. `auto_execute` enabled globally, **and** enabled for that specific symbol. There is no "all symbols" switch.
2. `signal.score >= auto_execute_threshold` (default **80**, must be ≥ `display_threshold`). Corresponds to 5 of 6 clusters at quality 90 — see §5.3.1 before raising it.
3. Account is demo, **unless** `MDTALPHAFX_ALLOW_LIVE_AUTO=1` is set in the environment. A UI toggle is not sufficient to arm live auto-execution.
4. Every §7.4 portfolio guard passes.
5. `auto_trades_today < max_auto_trades_per_day` (default **3**) — a counter separate from the manual trade count.
6. No halt flag set (§7.7).
7. Regime is not `VOLATILE_NEWS` and not `TRANSITIONAL`. Auto-execution requires a confidently classified market; an uncertain one is exactly when a human should look.

**Behaviour:**

- The signal is written to the journal with `origin=AUTO` *before* submission, not after. If the process dies mid-submit, reconciliation must be able to find the intent.
- Auto-executed positions are managed identically to manual ones (§7.5, §7.8).
- Every auto-execution emits a UI notification and a journal entry. The user should never discover an auto trade by looking at their broker statement.
- Hitting `max_auto_trades_per_day` disables AUTO for the remainder of the server day and surfaces a banner. It does not disable manual signals.

**Defaults ship as: AUTO off, demo only, 3 trades/day, threshold 80.** Per §9, auto-execution is Stage 6 work and is enabled only after extended manual operation on the same symbol set.

---

## 8. API & UI

### 8.1 FastAPI

Bound to `127.0.0.1:8000`. **Bearer token auth on every route**; CORS restricted to the UI origin. Localhost is not a security boundary.

| Endpoint | Purpose |
|---|---|
| `GET /api/chart-data` | Candles + overlay coordinates (FVG boxes, OB zones, EMAs, BOS/CHoCH markers) |
| `GET /api/analyze` | Full `Signal` including per-timeframe states, lifecycle, votes and cluster breakdown |
| `GET /api/overview` | Market Overview: all watchlist symbols, regime and best signal per symbol |
| `POST /api/overview/analyze` | Run a full watchlist sweep on demand — the "Analyze Market" action |
| `GET /api/signal-center` | Every signal for a date range **including below-threshold**, filterable by score |
| `GET /api/scanner` | Ranked multi-pair results |
| `GET /api/radar` | Pending/forming setups with lifecycle states |
| `GET /api/patterns` | Pattern engine results, filterable by state (§6.4) |
| `POST /api/patterns/config` | Pattern rules — isolated from strategy config |
| `GET /api/layers` · `POST /api/layers` | Chart layer state and drawings per (symbol, timeframe) |
| `GET /api/regime` | Current regime per timeframe, with confidence and bars-in-regime |
| `GET /api/session` | Active trading session and overlap state (§8.4) |
| `GET /api/feed-health` | Broker name, last tick age, bar staleness per timeframe |
| `POST /api/decision` | Take or ignore a signal by `signal_id` |
| `GET /api/positions` | Open positions, pending orders, live risk usage |
| `POST /api/kill` | Kill switch |
| `POST /api/strategy-lab/config` | Enable/disable modules; update cluster weights |
| `GET /api/thresholds` | Both thresholds, cluster minimums, and the live §5.3.1 calibration table |
| `POST /api/thresholds` | Update thresholds; rejects `auto > display` inversion |
| `POST /api/auto-execute` | Enable/disable AUTO per symbol; returns refused reason if preconditions unmet |
| `GET /api/journal` | Historical signals **including gate-rejected near-misses**, decisions, outcomes |
| `GET /api/outcomes` | Resolved outcomes with excursion metrics, filterable by source and segment (§12) |
| `GET /api/review` | Latest Tier B written review and the statistics it cited |
| `GET /api/config-versions` | Config history; every signal's `config_version` resolves here |
| `WS /ws/stream` | Push updates on bar close |

Example `/api/analyze` response. **The arithmetic below is worked, not illustrative** — regenerate it if the weights in §5.1 change, and keep it as a fixture so a scoring regression breaks a test rather than a trade.

```json
{
  "signal_id": "8f2c1e40-...",
  "fingerprint": "1r6rwly",
  "symbol": "XAUUSD",
  "direction": "BUY",
  "order_type": "BUY_LIMIT",
  "score": 72.2,
  "breadth": 0.69,
  "quality": 86.8,
  "votes": {
    "buy_votes": 4, "buy_points": 407.9,
    "sell_votes": 1, "sell_points": 79.2,
    "contested": true,
    "leading_contributor": "Sell-Side Liquidity Sweep"
  },
  "htf_regime": "TRENDING_BULLISH",
  "entry_timeframe": "M15",
  "mtf_aligned": "3/5",
  "entry_zone": {"min": 2382.50, "max": 2385.00},
  "sl_basis": "1.06 ATR below swing low",
  "exit_plan": {
    "stop_loss": 2374.00,
    "take_profit_1": 2407.00,
    "take_profit_2": 2429.00,
    "tp_currency": null,
    "trail_activate_points": 1200,
    "trail_distance_points": 600,
    "trail_step_points": 100,
    "breakeven_at_r": 1.0
  },
  "state": "LOCKED",
  "locked_at": "2026-07-22T16:45:00Z",
  "expires_at": "2026-07-22T19:45:00Z",
  "age_bars": 0,
  "displayed": true,
  "auto_eligible": false,
  "pattern_context": null,
  "gate": {
    "passed": true,
    "failed_conditions": [],
    "display_threshold": 70,
    "auto_execute_threshold": 80
  },
  "clusters": [
    {"cluster_id": "C", "cluster_name": "Stop hunt & reject",
     "fired": true, "score": 94, "weight": 12, "contributing_modules": [5, 15]},
    {"cluster_id": "B", "cluster_name": "Zone retest",
     "fired": true, "score": 90, "weight": 12, "contributing_modules": [3, 13]},
    {"cluster_id": "D1", "cluster_name": "Structure continuation",
     "fired": true, "score": 85, "weight": 11, "contributing_modules": [8]},
    {"cluster_id": "E", "cluster_name": "Trend stack",
     "fired": true, "score": 78, "weight": 12, "contributing_modules": [17, 18, 21]}
  ],
  "timeframes": {
    "H4":  {"regime": "TRENDING_BULLISH", "direction": "BUY",  "score": 74, "state": "MONITORING"},
    "H1":  {"regime": "TRENDING_BULLISH", "direction": "BUY",  "score": 71, "state": "LOCKED"},
    "M15": {"regime": "TRENDING_BULLISH", "direction": "BUY",  "score": 72, "state": "LOCKED"},
    "M5":  {"regime": "RANGING",          "direction": "NONE", "score": 38, "state": "SCANNING"},
    "M1":  {"regime": "RANGING",          "direction": "SELL", "score": 44, "state": "AWAITING_VALIDATION"}
  },
  "llm_rationale": null
}
```

Derivation: enabled with-trend weight in TRENDING is 68 (A 11, B 12, C 12, D₁ 11, E 12, H 10). Four clusters fire in agreement for 47. `breadth` = 47/68 = 0.691. `quality` = (94·12 + 90·12 + 85·11 + 78·12)/47 = 86.79. `score` = 100 × √0.691 × 0.8679 = **72.2**.

Vote tally: BUY points = (94·12 + 90·12 + 85·11 + 78·12)/10 = 407.9. One counter-trend cluster (D₂, weight 11, score 72) dissents for 79.2, so `contested: true`.

Note what the response demonstrates: the signal is **displayed** (72.2 ≥ 70) and takeable by hand, but **not auto-eligible** — both because 72.2 < 80 and because the tally is contested. The M1 timeframe simultaneously holds a SELL candidate at 44 in its own lifecycle; that is expected, not an error, and is why `mtf_aligned` reads 3/5.

### 8.2 UI

**React 19 + Next.js App Router built to a static export, served by FastAPI, opened at `localhost:8000` in Chrome.** Full stack and rationale in **§13**; design tokens, component inventory and the add-a-view recipe live there too.

No Tauri/Electron wrapper and no auto-updater in v2 — packaging, signing, update manifests and rollback are meaningful work for a single-user system that updates with `git pull`. Chrome's "Install as app" provides a windowed experience at zero cost. Revisit if the tool is ever distributed.

**The single-process invariant from §1 still holds.** Next.js is statically exported; there is no Node server at runtime. FastAPI remains the only process, and the only thing that talks to MT5.

Theme: dark quantitative, `#090d16` background, slate panel borders. **Green/red is a secondary channel only** — see principle 3.

#### Design principles

The reference implementations in this space share a set of habits worth departing from deliberately. Each principle below names the habit and the reason.

**1 · Calm by default. One alert level, spent once.** The reference UI renders a red banner reading ACTION REQUIRED, a DECIDE NOW badge, a pulsing dot and a countdown — simultaneously, on a routine setup. When the interface is always shouting, the user stops hearing it, and manufactured urgency produces worse decisions in exactly the moments that matter. Alert treatment is reserved for a single condition: `ENTRY_HIT` on a bar that is about to close. Every other state — `FORMING`, `LOCKED`, `AWAITING_VALIDATION` — is rendered informationally. A tool that helps you think should not feel like an alarm clock.

**2 · The sentence before the number.** A large `86` in a ring is the least interpretable object that can be put on screen; it invites the user to trade the gauge. Lead with the finding in words — *"Sell XAUUSD — 4 of 6 clusters agree, one strong dissent"* — and render the composite score as a supporting figure beside its breadth and quality. This is §8.5's display rule expressed as layout, not just content.

**3 · Direction is never encoded by colour alone.** Roughly 8% of men have a red/green deficiency, and direction is the single most consequential bit on the screen. Every directional element carries a glyph (▼/▲), the word BUY or SELL, and colour — three redundant channels. WCAG 2.1 AA contrast throughout, verified, not assumed. This is also why the theme's accent pair is demoted to a secondary channel.

**4 · Lifecycle drives visual state.** §6.1 made the lifecycle the spine of the architecture; the UI should make it the spine of the layout. A `LOCKED` signal is visually distinct from a `FORMING` one — locked levels are shown as fixed values with a frozen marker, forming ones as ranges with explicit uncertainty. The user should be able to tell a signal's state at a glance without reading a label.

**5 · Never repeat the same fact at the same weight.** The reference shows `LOCKED SELL 86` in four places on one screen. Repetition consumes the space that evidence needs. State each fact once, at the weight it deserves.

**6 · Progressive disclosure for configuration.** Eighteen layer checkboxes competing with the chart teaches the user to ignore the panel. Collapse to the group level, expand on demand, and surface only the layers currently drawing something.

**7 · Show the dissent.** A contested signal (§5.2.1) gets a distinct treatment stating the consequence in plain language — *"not auto-eligible: one cluster disagrees at strength 96"* — rather than a silent flag. The reference displays the vote bar and then ignores it; the number and the disagreement must sit together or the user will read only the number.

**8 · Uncertainty is content, not a caveat.** Ambiguity rate, low-sample segments, stale feeds and unreachable thresholds are rendered inline where the affected number appears, not in footnotes. §11.5's warnings belong on the backtest result screen.

**9 · Navigation grouped by intent.** Eleven flat sidebar entries force the user to hold the taxonomy in their head. Group as **Watch** (Market Overview, Smart Analyzer, Scanner) · **Decide** (Signal Center, Radar, Patterns) · **Review** (Journal, Backtester, Positions) · **Configure** (Strategy Lab, Risk Calculator, Settings).

**10 · Execution posture is always visible, never ambiguous.** A persistent badge states whether the system can place orders, and under what constraints. Inherited directly from the reference, which gets this right — *"records your decision only, no MT5 order is sent"* next to the button is a good pattern and should be kept.

**Views, in build order:**

1. **Chart + Signal Bar** — candles with overlays; score gauge showing breadth and quality separately; the §5.2.1 vote bar; Take/Ignore.
2. **Smart Analyzer** — per-timeframe cards (H4/H1/M15/M5/M1), each with its own regime, direction, score and **lifecycle state**. Scalping Mode toggle. Shows `mtf_aligned` ("1/5 aligned") as a headline figure.
3. **Market Overview** — the no-knowledge entry point. Every watchlist symbol with its regime and best current signal, plus a single **Analyze Market** button that sweeps everything on demand. A user who does not want to learn the 28 strategies should be able to start and finish here.
4. **Signal Center** — the day's signals, all of them, with a live score filter. This is where `display_threshold` acts as a slider over existing records rather than a gate (§5.3): drag to 65 and the near-misses appear instantly.
5. **Opportunity Radar** — pending/forming setups with lifecycle state, age in bars, wall-clock expiry, and `do not chase` tags.
6. **Pattern Strategy** — the §6.4 engine: its own rule panel, formation toggles, state counts, and the forming/formed monitor. Visibly separate from the strategy engine, with a standing note that pattern signals never replace Smart Analyzer signals.
7. **Strategy Scanner** — ranked watchlist with score, regime, cluster breadth, direction.
8. **Positions & Risk** — open positions, live risk usage against each guard, kill switch.
9. **Trade Journal** — all signals including **operator-ignored ones, below-threshold near-misses with their scores, validity-gate rejections with failing conditions, and the resolved outcome of every category** (§12.1). Excursion metrics per trade, with real and counterfactual sources visually distinct. Aggregate counterfactual summary per §12.3 — never per-signal regret.
10. **Strategy Lab** — module toggles grouped by pillar, with cluster membership shown so the user can see that disabling one of five trend modules changes little — and that enabling all five does not make a signal five times better.
11. **Backtester** — replay over history using the same pipeline (§11). Segmented results per §11.4, with the ambiguity rate and §11.5's limitations rendered inline beside the equity curve rather than as a footer disclaimer.
12. **Risk Calculator**, **Data & Settings** — MT5 connection, both thresholds, risk parameters, LLM endpoint.

### 8.3 Chart layers & drawing

18 toggleable overlays in four groups, persisted **per (symbol, timeframe)** — the layers useful on XAUUSD M1 are not the ones useful on EURUSD H4, and a global setting forces the user to re-toggle on every switch.

| Group | Layers |
|---|---|
| Moving averages | EMA 20 · EMA 50 · EMA 200 |
| Market structure | Fair Value Gaps · Order Blocks · Liquidity / EQL · Equilibrium · Support & Resistance |
| Chart events | BOS / CHoCH · Liquidity Sweeps · Detected Patterns |
| Trade tools | Entry, SL & Targets · My Drawings |

All layers default **off** except *Entry, SL & Targets*. An 18-layer chart drawn at once is unreadable, and the overlays exist to answer a specific question, not to decorate.

**Drawing tools** — trendline, horizontal ray, rectangle, freehand, eraser, undo, clear. Drawings persist in `ChartLayerState.drawings` under the same (symbol, timeframe) key and survive restart.

**Rendering budget.** Overlay coordinates come from `StrategyResult.evidence`, already computed during evaluation — the chart never recomputes indicators client-side. Enabling all 18 layers must not exceed the §10.4 frame budget; if it does, cull by recency rather than dropping layers silently.

### 8.4 Status indicators

Small, and each prevents a specific misreading:

- **Session** — active session and overlap state (*London / New York overlap*). Module 28 and all session logic depend on §10.1's UTC handling; showing the resolved session is how a DST bug becomes visible instead of looking like a bad strategy.
- **Feed health** — broker name, last tick age, per-timeframe bar staleness. A frozen feed and a quiet market look identical on a chart.
- **Live / analysing** — whether a sweep is currently running, and the timestamp of the last completed check.
- **Execution posture** — a persistent badge reading *analysis only — no automatic execution*, or the active AUTO configuration. The user must never be unsure whether the machine can trade.

### 8.5 Display rules

**Score display rule.** Never show the composite score alone. Always show breadth and quality alongside it: `72 — 4 of 6 clusters, avg strength 87`. The composite alone is not interpretable when it matters.

**Vote display rule.** Wherever a score appears at decision size, the §5.2.1 tally appears with it — `BUY 1 / 96 pts · SELL 4 / 296 pts`. A `contested` signal is badged, because contested signals are auto-ineligible and the user should understand why the machine declined to act.

**Two scales, never adjacent unlabelled.** Smart Analyzer scores and pattern confidences share a 0–100 range and measure unrelated things. Pattern figures are always prefixed *pattern*.

**Threshold controls.** Data & Settings exposes `display_threshold` and `auto_execute_threshold` as separate sliders, each annotated with its cluster equivalent from §5.3.1 — *"70 — needs about 4 of 6 clusters"* — recomputed live from the loaded cluster weights rather than hard-coded. The slider range is capped at the reachable maximum for the current configuration; a dial that travels into a dead zone teaches the user that the tool is broken. `min_clusters` and `min_pillars` sit beside them, not hidden, because below ~75 they are what actually filters.

**Lifecycle is always visible.** Every signal surface shows its §6.1 state and, once locked, its age and wall-clock expiry. `LOCKED` carries an explicit note that levels are frozen — the user needs to know the numbers will not move under them.

---

## 9. Build order

Ordered by dependency. Parallelism width noted, since throughput is a function of concurrent agents rather than calendar time.

### Stage 0 — Contracts & harness · blocks everything · 1 agent + operator

MT5 connector and `SymbolSpec` resolution · historical store (Parquet/SQLite) including **M1 bars for sub-bar resolution** and **per-bar spread** · **frozen contracts from §2** · **the `Strategy` interface** · bar-close replay engine with §11.1 intrabar resolution and §11.2 cost modelling · recorded fixtures covering trending, ranging and high-volatility periods · metrics module (expectancy, profit factor, max DD, win rate, ambiguity rate).

Sub-bar resolution and cost modelling belong here, not in a later polish pass. Retrofitting them changes every number the harness has ever produced, which means every judgement made against those numbers has to be revisited.

*Gate:* a trivial strategy runs end-to-end over history and produces a metrics report, and a synthetic fixture in which stop and target share a candle resolves correctly against M1 data.

### Stage 1 — Tier 1 & Tier 3 · blocks Stage 3 · operator, by hand

Regime classifier with thresholds and hysteresis (§3) · regime→cluster map · scoring function with breadth/quality split (§5.2) · vote tally (§5.2.1) · validity gate and the three-way validity/visibility/execution split (§5.3) · MTF policy (§5.4) · **level derivation (§5.5)** · **signal lifecycle state machine (§6.1)**.

§5.5 and §6.1 are new to this stage and both are load-bearing. Level derivation blocks Stage 3 — without it a signal has no entry, stop or target. The lifecycle blocks Stage 4 — a UI cannot render a decision surface for an object whose values change underneath it.

Small code, large consequence. Encodes judgment that agents will confidently fake.

The three-state cluster map (§3.4) and the direction-aware denominator (§5.2) belong here, not in Stage 3. Both look like details and both silently mis-score every trending signal if implemented as booleans.

*Gate:* replay a year and compare the regime timeline against the chart visually. Do labels match? Does it flap at boundaries? Then plot the **score distribution** over that year and check it against §5.3.1 — if scores cluster below the threshold or pile against a ceiling, the calibration is wrong and every downstream stage inherits it.

### Stage 2 — The 28 modules · blocked by Stage 0 · up to 28 parallel agents

Each module is an independent task against a frozen interface, with golden-file tests on the fixtures. §4's table is effectively 28 ready-made prompts.

Sequence by pillar so partial completion is useful: **SMC/ICT → Trend & Momentum → Price Action → Volatility & Mean Reversion.**

**Then: the co-firing matrix task.** Run all 28 over history, output which modules fire together, and replace §5.1's hypothesised clusters and weights with measured ones. Small task, parameterises the entire scoring layer.

**Then re-run the Stage 1 calibration.** Measured weights change every denominator in §5.3.1, so the table and both thresholds must be regenerated. Ship the regeneration as a script, not a one-off analysis — it will be run again.

*Gate per module:* deterministic output on fixtures, plus a visual check that detections land where a human would draw them.

### Stage 2b — Pattern engine · blocked by Stage 0 only · up to 16 parallel agents

Independent of the 28 modules and of Tier 1/Tier 3, so it can run concurrently with Stage 2 rather than after it. Each of §6.4's 16 formations is a separate task against the `PatternResult` contract, plus one task for the state machine and filter chain.

*Gate:* the isolation test — toggling every formation on and off must leave Smart Analyzer output bit-for-bit identical on the fixtures.

### Stage 3 — Pipeline assembly · blocked by 1 + 2 · 1–2 agents

Wire Tier 1 → Tier 2 → Tier 3 across all timeframes · **per-timeframe lifecycle tracking and lock enforcement** · scanner with shared evaluation cache · Opportunity Radar · pattern context attachment · compute budget asserted (**full watchlist scan < 2s**).

*Gate:* a replay in which a locked signal's levels are asserted unchanged across every subsequent bar until it resolves. This is the regression test that matters most in the whole system.

### Stage 4 — API & UI · blocked by 3 · parallel by view

Freeze the endpoint schema first, then fan out — the twelve views in §8.2 are independently parallelizable once it's fixed. Build Chart + Signal Bar, Smart Analyzer and Market Overview first; they exercise the lifecycle and will surface contract gaps while the rest is still cheap to change.

**Before any view work: build the §13 design system.** Tokens, the shell layout, and the twenty-component inventory are one task and they block the fan-out. Twelve agents building views against an unspecified component set produce twelve dialects, and reconciling them afterwards costs more than specifying them once. `ScoreDisplay`, `DirectionLabel`, `VoteBar`, `LifecycleChip` and `SampleCountBadge` come first — they are how §8.2's principles get enforced rather than remembered.

Chart layers (§8.3) are one task, not eighteen — the overlay renderer is generic and the layers are configuration.

### Stage 5 — Execution · blocked by 4 · 1 agent, hand-reviewed

`order_send()` · lot sizing · broker constraints · portfolio guards · regime transition policy · idempotency · **startup and continuous reconciliation (§7.6)** · **currency exits and trailing (§7.8)** · kill switch.

Small surface, all the financial risk. Every line hand-reviewed. Note the ordering within the stage: the kill switch and reconciliation come *before* trailing, because trailing is the first component that amends live orders on its own initiative.

### Stage 5b — Outcome resolution · blocked by 3 · 1 agent

**§12.1 and §12.2 belong here, not in Stage 6.** The resolver for untaken signals depends only on the pipeline and the historical store, not on execution — it can ship before the first live order, and should, because every day it isn't running is a day of counterfactual data permanently lost. §12.5's sample-size floors mean the data has to start accumulating early or the review loop has nothing to work with for a year.

Outcome resolver, both paths · excursion metrics · segmented statistics store · aggregate counterfactual reporting per §12.3.

*Gate:* a replayed month produces resolved outcomes for every locked signal, taken and untaken, with `BROKER` and `REPLAY` sources correctly separated.

### Stage 6 — Unblocked

LLM rationale (async, non-scoring) · **§12.4 Tier B review generation** · pattern engine expansion · desktop packaging · auto-updater.

Tier B is last because it is worthless until Tier A has accumulated samples that clear §12.5's floors. Building the reviewer before the data exists produces confident prose about nothing.

**AUTO execution (§7.9) is last** — behind a per-symbol toggle, a separate score threshold, a daily trade cap and an environment variable for live accounts, after extended manual operation on the same symbols.

**The management EA (Appendix A) follows AUTO**, and only once §7.8 trailing is proven in Python. It is a redundancy layer; there is nothing to be redundant with until the primary works.

---

## 10. Cross-cutting requirements

### 10.1 Time

MT5 server time ≠ UTC ≠ local, and the server's DST schedule may not match the local one. Module 28 (Session ORB) and all session logic depend on this, and errors fail **silently** — a London breakout firing at the wrong hour looks like a bad strategy, not a bug.

- Store and compute in UTC.
- Resolve the server offset explicitly at startup; do not infer it per-call.
- Session windows defined in UTC in config.
- Required test: session boundaries across a DST transition.

### 10.2 Logging & audit

Append-only decision log. For every signal: regime per timeframe, every module result, cluster resolution, breadth, quality, final score, **full `GateOutcome` including all failed conditions**, `origin` (MANUAL/AUTO), decision, order intent, broker response, and every subsequent stop amendment made by trailing.

**Near-misses are logged too.** An evaluation that fails the gate is written with its `failed_conditions`, not discarded. This is what makes threshold tuning empirical rather than superstitious: it answers "what would I have caught at 65?" without a re-run, and it is the only way to notice that `min_clusters` — not the score — has been silently rejecting everything.

This is the only thing that explains a surprising trade after the fact.

### 10.3 Testing

- Recorded MT5 fixtures, replayed deterministically. No test touches the network.
- Mock broker implementing `order_send()` including realistic rejections (requote, invalid stops, invalid volume, partial fill).
- Golden-file tests per module.
- Live-account guard: a module-level check raises unless the account is demo, overridable only by a deliberately-set environment variable.

### 10.4 Performance

- Evaluate on bar close, not on tick.
- Cache per (symbol, timeframe, bar); scanner and analyzer share it.
- `ProcessPoolExecutor` for module evaluation (the GIL gives concurrency without parallelism on CPU-bound math); `asyncio` for MT5 I/O.
- Asserted budget: full watchlist scan under 2 seconds.

### 10.5 LLM rationale

- **Never feeds the score.** One-way data flow, enforced in code.
- Generated **asynchronously**, after the signal card renders. Never blocks execution.
- Input is pre-computed facts only: cluster breakdown, detected levels, regime. It describes; it does not evaluate.
- Rendered visually subordinate to the cluster list.
- One provider behind a thin interface. Additional providers are a later convenience.
- **The same one-way rule governs §12.4's Tier B reviewer** — and extends to config. The model reads computed statistics, writes prose, and holds no write access to any config file or to the scoring path. It also takes no part in outcome resolution (§12.1), which must stay exact and reproducible.

### 10.6 Third-party notices

`lightweight-charts` is Apache-2.0 and free, but its licence requires the TradingView attribution link remain visible. Keep it in the chart component.

---

## 11. Backtesting & validation

The replay engine from Stage 0 is also the backtester — same pipeline, same code path, historical bars instead of live ones. If the backtester has its own evaluation logic, it is testing something other than the system you will trade.

**MT5's Strategy Tester is not available to this architecture.** Appendix A establishes that the EA is management-only and places no orders; there is nothing for the native tester to run. The replay engine is the only test harness, which raises the bar for its fidelity.

### 11.1 Intrabar resolution — the central fidelity problem

A candle records where price went, never in what order. When both stop and target fall inside one candle's range, OHLC cannot say which was reached first.

**Resolution order, most to least trusted:**

1. **Sub-bar walk (required).** Drop to M1 bars inside the ambiguous candle and walk them in sequence. An M15 signal with a 28-point span between stop and target resolves against fifteen M1 candles; ambiguity survives only if a single *M1* candle spans both levels, which is rare.
2. **Conservative fallback.** Where M1 data is unavailable — gaps, weekends, deep history — assume the **stop is hit first** and record the loss. Flag the trade `AMBIGUOUS_FILL` in results.
3. **Never** resolve by assuming the favourable order, and never silently.

**Report the ambiguity rate.** Every backtest result carries the percentage of trades resolved by fallback rather than by sub-bar walk. Above ~5%, the equity curve is substantially an artefact of the assumption and should be read as a lower bound, not an estimate.

**Why this matters more at tight targets.** The candle must span `stop_distance + target_distance` to contain both. At 1:1.8 with a 10-point stop that is 28 points; at 1:5 it is 60. Ordinary candles clear 28 routinely and 60 rarely, so the conservative fallback penalises tight-target strategies far more than wide-target ones. Without sub-bar resolution, a backtest will recommend wide targets for a reason that has nothing to do with the market.

### 11.2 Cost modelling

Frictionless backtests are the most common source of strategies that work in testing and lose in production. All four are mandatory:

| Cost | Treatment |
|---|---|
| Spread | Per-bar recorded spread from the historical store, not a constant. Entry fills at ask (buy) or bid (sell). |
| Commission | Per-lot, per-side, from broker config. |
| Swap | Applied per position per rollover, long and short rates differ. |
| Slippage | Configurable model; default 0 for limit orders, `slippage_points` for market and stop orders. |

**Fills obey §7.3.** A backtest that fills an order the live system would reject on `stops_level`, `volume_min` or a closed session is measuring a strategy that cannot be traded.

### 11.3 Walk-forward analysis — the only permitted parameter search

**Do not run a global optimizer over this system.** Count the free parameters: nine cluster weights, `ALPHA`, two thresholds, `min_clusters`, `min_pillars`, four ADX thresholds, `regime_confirm_bars`, six level constants (§5.5), the pattern filters, and 28 module toggles. That is well over fifty dimensions. Searching them against a year of M15 bars will find a configuration with an excellent equity curve that has memorised noise — there are vastly more configurations than there is information in the data.

Parameter selection is permitted only in walk-forward form:

1. Split history into sequential windows — default **6 months in-sample, 2 months out-of-sample**, rolled forward by 2 months.
2. Select parameters on the in-sample window only.
3. Evaluate on the immediately following out-of-sample window, **once**. No re-selection after seeing it.
4. Roll forward and repeat.
5. Report only the concatenated out-of-sample results.

**The efficiency ratio** — out-of-sample expectancy divided by in-sample expectancy — is the headline number. Below ~0.5, the search is fitting noise and the parameters should be discarded in favour of the defaults. A walk-forward that looks worse than untuned defaults is a successful experiment: it told you not to tune.

**Constrain the search space before searching it.** Optimise at most 3–4 parameters at a time, chosen for a reason, holding the rest at defaults. The Appendix B decisions most worth this treatment are 16–19, the §5.5 level constants, because they are per-symbol and have no defensible universal value.

### 11.4 Result segmentation

A single expectancy figure hides everything that matters. Every backtest reports metrics segmented by:

- **Regime** at signal time — a system that is profitable overall and loses in RANGING has a fixable problem, and the aggregate conceals it.
- **Score decile** — this is how `display_threshold` and `auto_execute_threshold` get chosen from evidence rather than taste. If deciles 7 and 9 have the same expectancy, the score is not discriminating and the threshold is theatre.
- **Cluster breadth** — validates the §5.1 weighting hypothesis directly.
- **Contested vs uncontested** (§5.2.1) — tests whether the auto-ineligibility rule earns its place.
- **Timeframe** and **session**.

Core metrics: expectancy per trade in R, profit factor, win rate, maximum drawdown, longest losing streak, trade count, and ambiguity rate. **Trade count gates the rest** — any segment under ~30 trades is reported with its count and no conclusions.

### 11.5 What a backtest cannot tell you

Stated in the UI, not just here, because the number will be believed:

- Historical spread is recorded, not guaranteed; real slippage in fast markets exceeds any model.
- Survivorship and symbol selection — testing on the pairs you already like is not evidence.
- Regime coverage — a year containing no sustained range says nothing about ranging performance.
- Every parameter chosen after looking at this data is fitted to it, walk-forward or not.

---

## 12. Outcome resolution & adaptive review

§6.1 defines terminal states. This section specifies what advances a signal into one, and what is done with the result.

**The system is the source of truth for levels.** Entry zone, stop and targets are computed by §5.5 and frozen at lock. The broker only ever confirms *fills*. This means an untaken signal is just as resolvable as a taken one — the contract existed, price either honoured it or didn't — and untaken outcomes are **first-class data, not a lesser substitute**. Most systems can only learn from trades they took, which teaches them to approve of what they already do.

### 12.1 The outcome resolver

Runs on the §7.6 timer. Two paths, one record.

**Taken signals — ask the broker.** When reconciliation finds a tracked position gone, read `history_deals_get()` for the closing deal. MT5 states the reason (`DEAL_REASON_TP`, `_SL`, `_SO`, `_CLIENT`, `_EXPERT`), the exact close price and time, and realised P&L net of swap and commission. Nothing is inferred. `source = BROKER`.

**Untaken signals — replay the bars.** For any signal that reached `LOCKED` but was ignored, filtered below threshold, or expired, walk bars forward from `locked_at` and determine which level price reached first. This is the §11.1 intrabar problem verbatim, so it uses the same resolver: M1 sub-bar walk, conservative stop-first fallback, `ambiguous_fill` flagged. `source = REPLAY`, `counterfactual = True`.

**One resolver, three callers.** The backtester, the live counterfactual tracker and the outcome checker are the same component. If they diverge, at least two of them are wrong.

**Rules:**

- `OutcomeRecord` is written **once** and never amended. A revised outcome is a bug, not an update.
- **Never aggregate `BROKER` and `REPLAY` outcomes into one figure without labelling.** Real fills carry slippage and spread; replayed ones carry modelling assumptions. Mixing them silently produces a statistic that describes neither.
- Untaken signals still resolve. A signal left at `LOCKED` forever is the failure mode this section exists to prevent — it is precisely the data you wanted.
- No language model participates in resolution. `high >= level` is exact, reproducible and free; a probabilistic answer here corrupts every statistic downstream.

### 12.2 Excursion analysis

Win/loss is one bit. It cannot tell you whether a winner was well timed or lucky, and it cannot tell you what a loser nearly did. Excursion metrics can, and they are computed for **every** signal regardless of whether it was taken.

| Metric | Definition | Question it answers |
|---|---|---|
| **MAE** | Worst adverse excursion in R before resolution | Is my stop wider than it needs to be? |
| **MFE** | Best unrealised gain in R reached | Am I exiting too early? |
| `capture_ratio` | `realised_r / mfe_r` | How much of the available move did I keep? |
| `stop_utilisation` | `\|mae_r\|` against the 1R allowance | How much risk budget is idle? |
| `entry_efficiency` | Fill vs best price offered in the zone over the next `entry_window_bars` | Did I enter early, late, or well? |
| `bars_to_resolution` | Lock to terminal state | Is `signal_ttl_bars` set sensibly? |

**What the distributions license, in aggregate:**

- Winners whose MAE rarely exceeds 0.4R → the stop is holding risk budget hostage. Tightening it lets the same setups carry more size at identical risk.
- Winners with mean MFE 2.8R against a 1.5R TP1 → systematic early exit. This is "we could have made more," measured.
- Losers reaching +1.2R before reversing → a breakeven-at-1R rule converts a share of them to scratches. §7.8 already has the mechanism; this tells you where to set it.
- Low `entry_efficiency` with high win rate → the edge is real but the fill is poor; adjust the zone, not the strategy.

**Segment before concluding.** Excursion distributions differ sharply by regime — a 1R stop that is generous in RANGING is thin in TRENDING. Report per §11.4's segments, and apply the same ~30-trade floor.

**One trade tells you nothing.** Two hundred tell you where the stop and targets belong. The UI must never present single-trade excursion as a lesson.

### 12.3 Reporting untaken outcomes — with care

The counterfactual data is valuable and the way it is surfaced is a behavioural risk worth taking seriously.

**Do not notify per signal in real time.** *"The signal you ignored just made +2R"* delivered live, repeatedly, trains the user to take everything — which destroys the selectivity the score exists to create. It also lands hardest on correct decisions, because a well-judged skip still sometimes wins. That is hindsight bias delivered as a push notification.

**Report in aggregate, on a cadence.** A weekly review answers the useful version of the question: *"you ignored 22 signals; as a group they averaged −0.1R, so your filtering added value"* or *"the 14 you skipped in the 70–75 band averaged +0.4R, which suggests your threshold is too high."* That is decision-quality feedback. Per-signal regret is not.

**Exception.** A signal the user explicitly flagged to watch may notify on resolution. Opt-in, per signal, off by default.

### 12.4 The review loop

Three tiers, and the boundaries between them are the point.

**Tier A — measure. Automatic, continuous, changes nothing.** Outcome resolution, excursion metrics, segmented statistics, the §5.1 co-firing matrix refreshed as trades accumulate. Deterministic code. This tier is always on.

**Tier B — propose. LLM as analyst, writes prose, changes nothing.** On a cadence (default monthly, or every 200 resolved signals), Claude receives the *computed statistics* — never raw bars, never the scoring path — and writes a review: which clusters are earning their weight, where excursions suggest mis-set levels, whether the score is discriminating across deciles, what has drifted. Output is a document in the journal. It has no write access to any config.

**Tier C — approve. Human, validated, versioned.** Any change to weights, thresholds or level constants must:

1. Be proposed with a stated rationale and the statistics supporting it.
2. Pass **walk-forward validation** on held-out data per §11.3, with an efficiency ratio above 0.5.
3. Be approved explicitly by the operator. No auto-application, ever.
4. Ship as a **new versioned config** — configs are immutable and append-only.
5. Be recorded, so `Signal.config_version` explains any historical trade.

**Why not close the loop automatically.** A system that adjusts its own weights while trading is a control loop with a multi-week feedback delay, no stability guarantee, and money at stake. Bad weights produce losses, losses produce more adaptation, and the adaptation is fitted to the losses. It also destroys reproducibility: without versioned configs you can never answer why a trade fired, because the configuration that fired it no longer exists.

**§10.5's one-way rule is extended, not relaxed.** The LLM never feeds a score, and now also never writes a config. Enforced in code, not convention — Tier B's process has read-only access to the statistics store and no credentials for the config directory.

### 12.5 Sample-size discipline

The binding constraint on all of this, and the one most likely to be ignored.

Two to five signals a day across three symbols is roughly 1,000 resolved signals a year. Segmented by regime (4) × direction (2) × cluster (9), that is single digits per cell. **Adaptation on single-digit samples is noise-fitting with extra ceremony.**

- No statistic is displayed without its trade count beside it.
- No Tier B proposal may cite a segment under 30 trades except to say the sample is insufficient.
- No Tier C change may be approved on fewer than 100 out-of-sample trades in the affected segment.
- Counterfactual signals count toward these thresholds — this is the main practical argument for resolving them, since they roughly triple the sample.

**Regime classification is already the fast adaptation layer.** Tier 1 re-reads the market every bar and swaps the cluster set accordingly (§3.4). That is adaptation on a timescale of hours, with no fitting and no risk of learning noise. Weight learning is a slow second-order correction on top of it — worth doing, but it is not what makes the system responsive to a changing market. If the system feels slow to adapt, look at the regime thresholds before reaching for a review cycle.

---

## 13. Front-end architecture & design system

§8.2 gives ten design *principles*. This section gives the system that implements them — tokens, components, and a recipe for adding a view without redesigning the app each time.

### 13.1 Stack

| Layer | Choice | Note |
|---|---|---|
| Framework | **React 19** + TypeScript 5.x | React Compiler enabled |
| App shell | **Next.js App Router**, `output: 'export'` | Static build, served by FastAPI |
| Styling | **Tailwind v4** | CSS-first `@theme`, no JS config |
| Components | **shadcn/ui**, copy-in source | Owned and editable, not a dependency |
| Server state | **TanStack Query v5** | Cache shared across views |
| Animation | **Motion** | GSAP explicitly not used — see §13.6 |
| Transitions | **View Transitions API**, native | `document.startViewTransition()` |
| Charting | **lightweight-charts v5** | Own canvas, outside React's tree |

**Static export is a hard constraint, not a preference.** §1 specifies one process talking to MT5. `next build` emits `/out`, FastAPI mounts it as static files, and there is no Node runtime. Consequences, all binding:

- **No Server Components at runtime.** They execute at build time only. Every data path goes through TanStack Query to a §8.1 endpoint.
- **No middleware, no `cookies()`, no `headers()`, no server `redirect()`.** Auth is the §8 bearer token held client-side.
- **Every dynamic route needs `generateStaticParams`.** Prefer query params over dynamic segments — `/journal?signal=8f2c1e40` rather than `/journal/[id]`.
- **No `next/image` optimisation loader.** Use plain `<img>`; there are no remote images anyway.

A reviewer should read this as: *Next.js is being used for its router, layouts and conventions.* Nothing else about it is load-bearing. If that stops being worth the weight, the migration target is Vite plus TanStack Router and the view code is largely unaffected.

**Why not React's `<ViewTransition>` component.** Announced April 2025, still canary/experimental as of mid-2026 and the API may change. The native browser call is stable and does the same work. Revisit when it ships in a stable React release.

### 13.2 Design tokens

Declared once in `app/globals.css` under Tailwind v4's `@theme`, which makes them real CSS custom properties — readable from component code *and* from the chart overlay layer that draws FVG boxes and entry zones. No value below is duplicated in TypeScript.

```css
@theme {
  /* Surfaces — 0 is the page, ascending is nearer the viewer */
  --color-surface-0: #090d16;   /* page */
  --color-surface-1: #0e1420;   /* in-flow card */
  --color-surface-2: #141b2a;   /* raised panel */
  --color-surface-3: #1b2436;   /* popover, menu */

  /* Text */
  --color-text-primary:   #e6ebf4;
  --color-text-secondary: #97a3b8;
  --color-text-muted:     #5f6b80;
  --color-text-disabled:  #3d4658;

  /* Borders */
  --color-border:         #1e2736;
  --color-border-strong:  #2a3547;
  --color-border-stronger:#3a4759;

  /* Direction — never the sole carrier of meaning (§8.2 principle 3) */
  --color-dir-long:  #34d399;
  --color-dir-short: #f87171;

  /* Status */
  --color-alert:   #f87171;   /* reserved: ENTRY_HIT on a closing bar only */
  --color-warn:    #fbbf24;   /* contested, ambiguous fill, low sample */
  --color-ok:      #34d399;
  --color-accent:  #60a5fa;   /* locked, focus, links */

  /* Type — 14px base. This is a dense instrument, not an article. */
  --text-2xs: 11px;  --text-xs: 12px;  --text-sm: 13px;
  --text-base: 14px; --text-lg: 16px;  --text-xl: 19px;
  --text-2xl: 22px;  --text-3xl: 28px;

  --font-sans: "Inter var", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  /* Spacing — 4px base */
  --spacing-1: 4px;  --spacing-2: 8px;   --spacing-3: 12px;
  --spacing-4: 16px; --spacing-6: 24px;  --spacing-8: 32px;
  --spacing-12: 48px;

  --radius-sm: 4px; --radius: 8px; --radius-lg: 12px;

  /* Motion */
  --dur-fast: 120ms; --dur-base: 200ms; --dur-slow: 320ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

**Rules that are not negotiable:**

- **Two font weights only** — 400 and 500. Heavier weights on a dark dense UI read as noise.
- **Every number is `--font-mono`.** Prices, scores, R-multiples, lot sizes, timestamps. Proportional digits make a column of prices unreadable and hide changes in magnitude.
- **`--color-alert` appears in exactly one place**: the `ENTRY_HIT` band. Using it anywhere else spends the only attention budget the interface has.
- **No hardcoded hex anywhere outside this block.** A colour literal in a component is a bug — it will not follow a theme change and will not be found by review.

### 13.3 Layout & navigation

**Shell.** Three fixed regions, one scrolling.

```
┌────────────────────────────────────────────────────────────┐
│ status strip · feed · session · clock · execution posture   │  40px, fixed
├──────────┬─────────────────────────────────────────────────┤
│ nav rail │  view content                                    │
│  216px   │  scrolls independently                           │
│  fixed   │  max-width 1600px, centred                       │
│          │                                                  │
└──────────┴─────────────────────────────────────────────────┘
```

The status strip and nav rail persist across every route — that is the reason the App Router's nested layouts earn their place. Implement them in `app/layout.tsx`; view content is the `{children}` slot.

**Navigation grouped by intent** (§8.2 principle 9), not as eleven flat entries:

| Group | Views |
|---|---|
| **Watch** | Market Overview · Smart Analyzer · Strategy Scanner |
| **Decide** | Signal Center · Opportunity Radar · Pattern Strategy |
| **Review** | Trade Journal · Backtester · Positions & Risk |
| **Configure** | Strategy Lab · Risk Calculator · Data & Settings |

Group headings are `--text-2xs`, `--color-text-muted`, uppercase, non-interactive. Active item carries a 2px left border in `--color-accent` and `--color-surface-2` background. Badge counts sit right-aligned.

**Content grid.** 12 columns, `--spacing-4` gutter. Standard decision layout is chart 7 / evidence panel 5 at ≥1440px, stacking to a single column below 1024px. The evidence panel never drops below 380px — below that the vote bar and level rows stop being legible, and a cramped decision surface is worse than a scrolling one.

### 13.4 Component inventory

Every component below has a defined set of states. A component used in a state not listed here is a gap to be specified, not improvised.

| # | Component | States / variants |
|---|---|---|
| 1 | `Button` | primary · secondary · ghost · danger; default / hover / active / focus-visible / loading / disabled |
| 2 | `DirectionLabel` | long · short · none. Always renders glyph **and** word **and** colour |
| 3 | `LifecycleChip` | one per §6.1 state, 12 total. Neutral except `ENTRY_HIT` |
| 4 | `ScoreDisplay` | Renders score, breadth and quality together. **Cannot render score alone** — enforced by the component's props, not by convention |
| 5 | `VoteBar` | uncontested · contested. Both sides always labelled with counts and points |
| 6 | `AlertBand` | The only `--color-alert` surface. Takes a countdown and one line of copy |
| 7 | `ZoneTracker` | Live price within entry zone; before-zone · in-zone · past-zone |
| 8 | `LevelRow` | label · optional basis text · monospace value. Used for entry, stop, targets |
| 9 | `MetricCard` | value · label · optional delta · optional sample count |
| 10 | `TimeframeCard` | per-TF regime, direction, score, lifecycle state; aligned / opposed / neutral |
| 11 | `ClusterBreakdown` | firing · suppressed · counter-only; shows weight and contributing module IDs |
| 12 | `SignalCard` | Composed of 2–5, 8, 9. Compact (list) and full (decision) variants |
| 13 | `DataTable` | sortable · filterable · virtualised beyond 200 rows; empty · loading · error |
| 14 | `ThresholdSlider` | Annotated live with its §5.3.1 cluster equivalent. Range capped at the reachable maximum |
| 15 | `LayerPanel` | 4 collapsible groups, 18 toggles, collapsed by default (§8.3) |
| 16 | `NavRail` | 4 groups, active · hover · badge |
| 17 | `StatusStrip` | feed live · stale · disconnected; session; execution posture |
| 18 | `PatternBadge` | Always prefixed *pattern* to keep the two confidence scales apart (§6.4) |
| 19 | `EmptyState` | Distinguishes *nothing found* from *not yet run* from *error*. Never a bare blank panel |
| 20 | `SampleCountBadge` | Sits beside any statistic; warns below the §12.5 floor |

Components 4, 5, 6, 18 and 20 exist specifically to make §8.2's principles unbreakable in code rather than aspirational in prose. `ScoreDisplay` refusing to render a lone number is the clearest example: the rule stops depending on whoever writes the next view.

### 13.5 Chart & overlay conventions

`lightweight-charts` owns a canvas and sits outside React's reconciler. Treat it as an imperative peer, not a component to re-render.

- Instantiate once in a `useEffect` with an empty dependency array; drive it thereafter through its own API. **Never** re-create the chart on data change.
- Overlay coordinates come from `StrategyResult.evidence`, already computed server-side. The client never recalculates an indicator — if the chart and the score disagree, there is exactly one place to look.
- Overlay colours read the §13.2 tokens via `getComputedStyle` at mount, so a theme change does not desynchronise the canvas from the DOM.
- Locked signals draw entry, stop and targets as solid lines; provisional (`AWAITING_VALIDATION`) levels draw dashed. The visual difference between frozen and provisional is load-bearing (§6.1).
- Keep the TradingView attribution link visible (§10.6, Apache-2.0 licence condition).

### 13.6 Motion policy

**Never animate a value the user reads to make a decision.** A price counting from 4147.13 to 4147.28 over 300ms displays, for 300ms, a number that was never true. On a surface with a closing-bar countdown, that is not polish — it is a lie with an easing curve. Prices, scores, breadth, quality, R-multiples and levels **snap**.

| Animate | Duration | Never animate |
|---|---|---|
| Route transitions | `--dur-base`, View Transitions API | Prices, scores, levels |
| Card enter / exit in a list | `--dur-fast`, Motion `AnimatePresence` | Any monospace number |
| `AlertBand` appearing | `--dur-fast` | Countdown digits |
| Panel expand / collapse | `--dur-fast` | Chart data |
| Chart overlay draw-in | `--dur-base` | Table row values |

- **View transitions** handle route changes: `document.startViewTransition()` wrapping the router navigation, with `view-transition-name` on the persistent chart so it holds position across views.
- **Motion** handles everything within a view. Motion only — GSAP is not a dependency of this project.
- **`prefers-reduced-motion: reduce` disables all of the above.** Not "shortens" — disables. Nothing in this interface depends on motion to be comprehensible, which is the test a motion system should pass.

### 13.7 Recipe — adding a new view

The answer to *"what will it look like if I add a tab."* Seven steps, no design decisions required.

1. **Add the endpoint** to §8.1 and implement it. The view is a renderer; it computes nothing.
2. **Create `app/(shell)/<view>/page.tsx`.** It inherits the status strip and nav rail from the shell layout automatically — no chrome to rebuild.
3. **Register the nav entry** under one of the four intent groups in §13.3. If it fits none of them, that is a signal the view is doing two jobs.
4. **Fetch with TanStack Query**, keyed `['<view>', symbol, timeframe]` so the cache is shared with the scanner and analyzer rather than duplicating work (§10.4).
5. **Compose from §13.4 only.** A view needing a component that does not exist adds it to the inventory *with its states*, in the same change. No one-off components.
6. **Handle four states explicitly** — loading, empty, error, and populated. `EmptyState` distinguishes *nothing found* from *not yet run*; a blank panel is indistinguishable from a broken feed.
7. **Run the §13.8 checklist** before it is considered done.

Anything that renders a score uses `ScoreDisplay`. Anything that renders a direction uses `DirectionLabel`. Anything that renders a statistic attaches `SampleCountBadge`. These are not suggestions — they are how the design principles survive contact with the twentieth view.

### 13.8 Accessibility checklist

Per view, before it ships. WCAG 2.1 AA is the target and it is verified, not assumed.

- [ ] Contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI boundaries — measured with a tool
- [ ] Direction conveyed by glyph and text, not colour alone; the view is comprehensible in greyscale
- [ ] Every interactive element reachable by keyboard, in a sensible order, with a visible `focus-visible` ring
- [ ] Hit targets ≥ 32×32px — smaller is acceptable only for chart handles
- [ ] Live regions (`aria-live="polite"`) on lifecycle changes; **`assertive` only for `ENTRY_HIT`**
- [ ] Charts have a text alternative — the signal panel already states everything the chart shows
- [ ] `prefers-reduced-motion` honoured
- [ ] No information conveyed only by hover; touch and keyboard users get it too
- [ ] Numbers in `--font-mono` with tabular figures
- [ ] Screen-reader pass on the decision surface — the one screen where a misread costs money

---

## Appendix A — The MQL5 EA, scoped

The v1 spec routed **orders** through the EA: Python → HTTP → MQL5 EA → MT5. That path is rejected. A narrower EA is retained.

### A.1 Rejected — entry routing via EA

`MetaTrader5.order_send()` already places market and pending orders from the same Python session that reads the data. Interposing an EA on that path adds 1–3s polling latency on every entry, uses a synchronous `WebRequest()` that blocks the EA thread, requires hand-rolled JSON parsing in MQL5, needs URL whitelisting on every install, and adds a second language and toolchain. Critically, **`WebRequest()` cannot execute in the MT5 Strategy Tester**, so the entire execution path would be untestable in MT5's own tooling.

The usual justification — the EA runs on a VPS without Python — does not apply, because the `MetaTrader5` package requires the terminal running on the same Windows machine regardless. Identical deployment constraints, strictly worse properties.

### A.2 Retained — local position management only

§7.8 specifies trailing stops, breakeven moves and currency-denominated exits in Python. All three stop working the moment the Python process stops: a crash, a Windows update, a closed laptop lid. The position stays open at the broker with whatever stop was last written to it, and an armed trail that was 20 points behind price becomes a static stop 200 points away.

An EA solves precisely this, and nothing else:

**Scope — the whole of it.**

- Reads open positions with magic `999888`. Places no orders and opens no positions, ever.
- Maintains trailing stops, breakeven moves and currency-denominated closes for those positions, using parameters read from the position `comment` field or a config file written by Python at entry time.
- Idles when the Python engine is alive. Python writes a heartbeat timestamp; the EA takes over management only once the heartbeat is stale by more than `ea_takeover_seconds` (default 30). Two components trailing the same stop will fight.
- No `WebRequest()`. No network. No JSON. This is what keeps it testable in the Strategy Tester and small enough to hand-verify.

**Why this is worth a second toolchain and the earlier one was not.** This is a capability Python genuinely cannot provide, because the defining condition is Python not running. Entry polling was never that — it was a slower, less testable route to something Python does natively.

**Sequencing.** Stage 6, and only after §7.8 works in Python. The EA is a redundancy layer for a mechanism that must already be correct; building it first means debugging two implementations of the same logic with no reference to check against.

**Hand-off correctness is the whole risk.** The failure mode is both components managing the same position, or neither. Required tests: heartbeat expiry with a live position, Python restarting while the EA holds management, and a stop already moved by the EA being read back correctly on Python's return.

---

## Appendix B — Open decisions

Parameters requiring an operator decision before Stage 1. Defaults are proposals, not settled values.

| # | Decision | Proposed default |
|---|---|---|
| 1 | ADX enter/exit thresholds for TRENDING | 27 / 22 |
| 2 | ADX enter/exit thresholds for RANGING | 20 / 25 |
| 3 | `regime_confirm_bars` | 3 |
| 4 | Bias timeframe | H4 |
| 5 | Counter-bias weight penalty | 0.6 |
| 6 | `ALPHA` exponent on breadth | 0.5 — hold through Stage 1, then set from the realised score distribution (§5.3.2) |
| 7 | `display_threshold` | 70 — see §5.3.1 before changing |
| 8 | `auto_execute_threshold` | 80 (must be ≥ display) |
| 9 | Minimum clusters / pillars | 3 / 2 |
| 10 | Risk per trade | 1.0% |
| 11 | Max daily loss | 3.0% |
| 12 | `max_auto_trades_per_day` | 3 |
| 13 | `ea_takeover_seconds` (heartbeat staleness) | 30 |
| 14 | Reconciliation interval | 5s |
| 15 | Trailing defaults (activate / distance / step) | Per symbol — no sane cross-symbol default |
| 16 | `sl_buffer_atr` / `min_sl_atr` (§5.5) | 0.25 / 1.0 |
| 17 | `tp1_r` / `tp2_r` / `min_rr` (§5.5) | 1.5 / 3.0 / 1.2 |
| 18 | `min_zone_atr` / `snap_atr` (§5.5) | 0.15 / 0.5 |
| 19 | `signal_ttl_bars` / `chase_tolerance_atr` | 12 / — pin per symbol |
| 20 | Pattern `min_confidence` / `min_target_r` (§6.4) | 65 / 1.5 |
| 21 | Pattern trend alignment | Required |
| 22 | `scoring_mode` (§5.2.2) | CLUSTERED |
| 22b | `entry_window_bars` for entry efficiency (§12.2) | 3 |
| 22c | Tier B review cadence (§12.4) | Monthly or 200 resolved signals |
| 22d | Counterfactual reporting cadence (§12.3) | Weekly, aggregate only |
| 23 | Starting watchlist | 2–3 well-understood symbols |
| 24 | Broker / demo account | — pin before writing sizing logic |
| 25 | Open-position policy on regime flip | Per §7.5 table |

Decisions 16–19 are the ones most likely to be wrong at first and cheapest to fix later; they are per-symbol and should be tuned from Backtester output rather than argued about up front.

Decisions 7 and 8 are coupled to the §5.1 weights. Re-derive both after the Stage 2 co-firing measurement — a threshold tuned against hypothesised weights is meaningless once the weights are measured.

---

*Cluster definitions in §5.1 are a hypothesis pending the Stage 2 co-firing measurement. All weights, thresholds and policies live in config files, never in code.*
