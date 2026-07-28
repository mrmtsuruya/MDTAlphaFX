# Agent prompts — MDTAlphaFX build

Copy-paste templates for handing spec sections to coding agents. Put `CLAUDE.md` at the repo root first; it loads into every agent's context automatically and carries the twelve rules.

**How to use this:** one agent, one task, one stage. Never hand an agent "build the system." The spec's §9 build order exists because the dependencies are real, and an agent given the whole document will start at §1 and produce a plausible shell of everything.

---

## The universal preamble

Prepend this to every task.

```
Read first, in this order:
  1. CLAUDE.md at the repo root
  2. Spec §0 (rules) and §2 (contracts)
  3. The specific sections named in your task below

You are working on <STAGE> only. Do not implement anything from a later
stage, even if it looks trivial or looks like it's blocking you. If it is
genuinely blocking, stop and say so — do not build ahead.

Do not modify any §2 contract. Do not modify the Strategy protocol in §4.1.
Do not introduce a numeric literal into logic; every threshold, weight and
multiple reads from config/*.yaml.

If the spec is silent, ambiguous, or contradicts itself on something you
need: STOP and report it. Do not choose a value, do not infer a default,
do not pick the reading that lets you finish. State what you needed, which
section was silent, and what the candidate readings are.

Definition of done — your task is complete when: <GATE>

Report back with:
  - what you built, file by file
  - which spec sections you implemented
  - any ambiguity you hit and how you left it
  - the gate result, with the command you ran to prove it
```

---

## Stage 0 — contracts & harness

*One agent plus you. Blocks everything.*

```
<PREAMBLE, STAGE = "Stage 0">

Implement spec §2 (contracts), §4.1 (Strategy protocol), §7.1 (symbol
resolution), §10.1 (time), §10.3 (testing), §11.1 (intrabar resolution),
§11.2 (cost modelling).

Build:
  - MT5 connector; SymbolSpec resolved per symbol at startup, never assumed
  - Historical store (Parquet or SQLite) holding, per symbol:
      * bars for every timeframe in use
      * M1 bars — required for §11.1 sub-bar resolution
      * per-bar recorded spread — required for §11.2
  - The frozen §2 contracts as Pydantic models
  - The Strategy protocol from §4.1
  - Bar-close replay engine with §11.1 intrabar resolution and §11.2 costs
  - Recorded fixtures covering trending, ranging and high-volatility periods
  - Metrics: expectancy, profit factor, max drawdown, win rate, ambiguity rate

Note on scope: M1 bars, per-bar spread, and cost modelling belong in this
stage. They are not a later polish pass — retrofitting them changes every
number the harness has produced and invalidates every judgement made
against those numbers.

GATE: a trivial strategy runs end-to-end over history and produces a
metrics report, AND a synthetic fixture where stop and target fall inside
one candle resolves correctly against M1 data.
```

---

## Stage 1 — regime classifier & scoring

### Delegated by explicit operator approval

The original build plan reserved this stage for the operator because it encodes
high-consequence judgment. On 2026-07-27 the operator explicitly approved
`docs/PROPOSED-SHIPPING-PROFILE.md` and delegated Stage 1. Implement the exact
approved readings in that record; do not choose new thresholds or semantic
branches.

The tests-only inversion below is retained as historical task context. The
current repository stage marker authorizes production implementation against
the completed suite:

```
<PREAMBLE, STAGE = "Stage 1 — tests only">

Write tests for spec §3 (regime classifier), §5.2 (scoring), §5.2.1 (vote
tally), §5.3 (validity gate), §5.3.1–§5.3.2 (calibration), §5.4 (MTF),
§5.5 (level derivation), §6.1 (lifecycle).

Write tests ONLY. Do not write the implementation.

Cover specifically:
  - Hysteresis: a regime flipping around the ADX band must not oscillate;
    a new classification must hold regime_confirm_bars before taking effect
  - The three-state cluster map (ENABLED / COUNTER_ONLY / SUPPRESSED) —
    assert a with-trend signal excludes COUNTER_ONLY clusters from its
    denominator, per §5.2
  - Every cell of the §5.3.1 and §5.3.2 tables, as parameterised cases
  - §5.5 ordering: levels are provisional at AWAITING_VALIDATION and frozen
    at LOCKED. Assert POOR_RR can be evaluated before lock
  - §6.1 locking: a locked signal's side, entry, stop and targets are
    unchanged across every subsequent bar until it resolves

GATE: the test suite runs and fails cleanly against a stub, with each
failure naming the spec section it enforces.
```

---

## Stage 2 — the 28 strategy modules

*Up to 28 parallel agents. One module per agent. Sequence by pillar so partial completion is useful: SMC/ICT → Trend & Momentum → Price Action → Volatility & Mean Reversion.*

### Template

```
<PREAMBLE, STAGE = "Stage 2">

Implement strategy module <ID> — <NAME> — per spec §4 and the Strategy
protocol in §4.1.

Detects: <DETECTS, copied verbatim from the §4 table>
Cluster: <CLUSTER> (§5.1)      Pillar: <PILLAR> (§4)

Constraints:
  - Pure function of a bar window. No I/O, no globals, no network, no
    clock reads, no randomness.
  - NEVER read or infer the regime. Tier 1 gates you externally (rule 2).
    You do not know and must not care what regime you are in.
  - Signature exactly as §4.1. Do not modify the protocol.
  - Populate StrategyResult.evidence with the coordinates the chart will
    draw. The client never recomputes indicators (§13.5) — if the overlay
    and the score can disagree, you have written a bug.
  - Declare min_bars honestly. Under-declaring produces silent garbage on
    short windows.
  - Score 0–100 is your own confidence in THIS detection. It is not a
    probability and not comparable across modules.

Deliverables:
  - backend/strategies/m<ID:02d>_<snake_name>.py
  - Golden-file tests against the Stage 0 fixtures — trending, ranging and
    volatile periods, at minimum
  - A short note on what you deliberately chose NOT to detect, and why

GATE: deterministic output on the fixtures, plus a rendered chart image
showing your detections land where a human analyst would draw them.
```

### Worked example — module 1

```
<PREAMBLE, STAGE = "Stage 2">

Implement strategy module 1 — Bullish FVG Fill — per spec §4 and the
Strategy protocol in §4.1.

Detects: price dips into a 3-candle imbalance gap
Cluster: A · Imbalance (weight 11)      Pillar: 1 · SMC/ICT

[...constraints as template...]

Deliverables:
  - backend/strategies/m01_bullish_fvg_fill.py
  - Golden-file tests on the fixtures
  - Note on what you chose not to detect

GATE: deterministic output on the fixtures, plus a rendered chart image
showing detections land where a human analyst would draw them.
```

### After all 28 — the co-firing task

```
<PREAMBLE, STAGE = "Stage 2">

Run all 28 modules over the full history and produce the co-firing matrix
described in §5.1 and §9 Stage 2.

Output:
  - Pairwise co-firing rates between all 28 modules, segmented by regime
  - Proposed cluster membership derived from measured correlation, to
    replace §5.1's hypothesised grouping
  - Proposed weights, normalised to sum to 100
  - Regenerated §5.3.1 and §5.3.2 tables under the measured weights

Ship this as a re-runnable script, not a one-off analysis. It will be run
again every time the module set changes.

Do NOT apply the new weights to config. Output a proposal for review —
rule 12.

GATE: the script runs end to end and emits the matrix, the proposal, and
the regenerated tables.
```

---

## Stage 2b — pattern engine

*Up to 16 parallel agents. Independent of Stages 1 and 2, so it can run concurrently.*

```
<PREAMBLE, STAGE = "Stage 2b">

Implement pattern formation "<FORMATION>" for the pattern engine per §6.4,
returning PatternResult per §2.

Constraints:
  - Detection runs on COMPLETED candles only. A pattern half-drawn by a
    live candle is not a pattern.
  - Your confidence is on the pattern engine's own 0–100 scale. It is
    unrelated to the §5 score and must never be mixed with it.
  - You never enter any score, never modify a cluster, never override a
    Smart Analyzer decision (rule 10).
  - Populate geometry for chart overlay, and blocked_by when a filter
    rejects a confirmed breakout.

GATE: deterministic detection on the fixtures, AND the isolation test —
toggling your formation on and off leaves Smart Analyzer output
bit-for-bit identical.
```

---

## Stage 3 — pipeline assembly

*One or two agents. Blocked by Stages 1 and 2.*

```
<PREAMBLE, STAGE = "Stage 3">

Wire Tier 1 → Tier 2 → Tier 3 across all timeframes per §3, §4, §5.
Implement §6.1 lifecycle tracking and lock enforcement, §6.2 Radar,
§6.3 scanner with the shared evaluation cache, pattern context attachment.

The lock enforcement is the most important thing in this stage. Read §6.1
rules 1–5 and treat them as invariants with assertions, not as intentions.

Compute budget: full watchlist scan under 2 seconds (§10.4). Cache per
(symbol, timeframe, bar); scanner and analyzer share it.

GATE: a replay in which every locked signal's side, entry, stop and
targets are asserted unchanged across every subsequent bar until it
resolves. This is the regression test that matters most in the system —
write it so it fails loudly if anyone reintroduces recomputation.
```

---

## Stage 4 — design system, then views

*Design system first — it blocks the fan-out.*

```
<PREAMBLE, STAGE = "Stage 4 — design system">

Implement §13 in full: tokens (§13.2), shell layout and nav (§13.3), and
the 20-component inventory (§13.4) with every state listed.

Build these five first — they are how §8.2's principles get enforced
rather than remembered:
  ScoreDisplay · DirectionLabel · VoteBar · LifecycleChip · SampleCountBadge

ScoreDisplay must be incapable of rendering a score without its breadth
and quality. Enforce it in the props type, not in a comment.

Next.js App Router with output: 'export'. No Node runtime — read §13.1's
constraint list before writing a single route.

GATE: every component renders in every listed state in a gallery route,
and the §13.8 accessibility checklist passes on the gallery.
```

Then, per view:

```
<PREAMBLE, STAGE = "Stage 4">

Implement the <VIEW NAME> view, item <N> in §8.2's list.

Follow the §13.7 recipe exactly. Compose from §13.4 only — if you need a
component that does not exist, add it to the inventory WITH its states in
the same change. No one-off components.

Handle four states explicitly: loading, empty, error, populated. Use
EmptyState to distinguish "nothing found" from "not yet run" — a blank
panel is indistinguishable from a broken feed.

Fetch with TanStack Query, keyed ['<view>', symbol, timeframe] so the
cache is shared rather than duplicated.

GATE: §13.8 checklist passes; the view renders correctly in all four
states against a mocked endpoint.
```

---

## Stage 5 — execution

*One agent. Every line hand-reviewed by you. Do not parallelise this.*

```
<PREAMBLE, STAGE = "Stage 5">

Implement §7 in the order the section is written: symbol resolution,
lot sizing, broker constraints, portfolio guards, regime transition
policy, idempotency, startup AND continuous reconciliation, kill switch,
then position management.

Build the kill switch (§7.7) and reconciliation (§7.6) BEFORE trailing
(§7.8). Trailing is the first component that amends live orders on its
own initiative; you want the stop button working first.

Every §7.3 return code handled explicitly. Rounding is DOWN to
volume_step, never up (§7.2) — rounding up silently exceeds the risk
budget.

Do not implement §7.9 AUTO mode in this stage. It is Stage 6.

GATE: the mock broker suite passes including requote, invalid stops,
invalid volume, partial fill and market closed; a trailing stop is
asserted never to move against the position.
```

---

## Stage 5b — outcome resolution

*One agent. Ship before the first live order.*

```
<PREAMBLE, STAGE = "Stage 5b">

Implement §12.1 (outcome resolver, both paths), §12.2 (excursion metrics),
and the segmented statistics store feeding §11.4.

Both paths, one record:
  - Taken signals resolve from broker deal history. source = BROKER.
  - Untaken signals resolve by bar replay through the SAME §11.1 resolver
    used by the backtester. source = REPLAY, counterfactual = True.

Never aggregate BROKER and REPLAY outcomes into one figure without
labelling (rule 11). OutcomeRecord is written once and never amended.

Do not build the §12.4 Tier B reviewer. That is Stage 6 and it is
worthless until samples clear §12.5's floors.

GATE: a replayed month produces resolved outcomes for every locked signal,
taken and untaken, with sources correctly separated and ambiguity rate
reported.
```

---

## What not to delegate

| Work | Why |
|---|---|
| **Stage 1** thresholds, hysteresis, cluster weights, calibration | Small code, large consequence. An agent will produce plausible numbers and you will not be able to tell. |
| **Appendix B decisions** (all 28 decision rows) | Operator judgment, some of them per-symbol. The spec deliberately leaves them open. |
| **Any config change** after measurement | Rule 12. Walk-forward validation plus explicit approval. |
| **Reviewing Stage 5** | All the financial risk lives in a small surface. Read every line yourself. |
| **Deciding when AUTO goes live** | Per-symbol, after extended manual operation, and it is your money. |

---

## Two habits worth keeping

**Update the stage marker in `CLAUDE.md`** as you move. It is the cheapest guardrail against agents building ahead.

**Make agents report ambiguity, and read those reports.** They are the most valuable output of this build. Every ambiguity an agent finds is a place the spec was unclear — and it is far cheaper to fix the spec than to discover the misreading in a backtest six months later.
