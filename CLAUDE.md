# MDTAlphaFX — repo rules

Automated market analysis and MT5 execution for a single operator. Windows desktop. Real money.

**Source of truth:** `MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md`. If this file and the spec disagree, the spec wins and this file is a bug — report it.

**Current stage:** `Stage 2 — the 28 strategy modules`. Do not implement
anything from a later stage.

**Provider-neutral resume entry point:** `docs/AI-RESUME.md`. Keep it aligned
with this file, `docs/CODEX-HANDOFF.md`, and `docs/STAGE2-STATUS.md` whenever a
durable checkpoint changes so work can resume without access to a prior chat or
local model.

Stage 0 is **closed**. The operator approved fixture recovery on 2026-07-28,
all three replacement windows were recorded from the guarded DEMO terminal,
and the unqualified recorded-history gate passes. The high-volatility period
correctly reports zero executable trades and no conclusions because every
candidate exceeds the approved XAUUSD spread ceiling. See
`docs/FIXTURE-RECOVERY-STATUS.md`.

**Stage 1 delegation.** On 2026-07-27 the operator explicitly authorized
`APPROVE PROFILE + DELEGATE STAGE 1`. The choices in
`docs/PROPOSED-SHIPPING-PROFILE.md` are therefore normative for this stage.
Implement only those readings; do not invent alternatives or silently widen
scope.

**Stage 2 delegation.** On 2026-07-28 the operator explicitly authorized
`APPROVE + DELEGATE STAGE 2`. This authorizes implementation of the 28 pure
strategy modules, deterministic fixture and visual evidence, the re-runnable
co-firing analysis, and a proposed measured cluster/weight/calibration profile.
It does not authorize applying proposed config changes, Stage 2b, Stage 3,
live-account access, AUTO execution, or order placement.

**Stage 2 detector profile.** On 2026-07-28 the operator explicitly authorized
`APPROVE STAGE 2 DETECTOR + HISTORY PROFILE`. The exact readings in
`docs/PROPOSED-STAGE2-DETECTOR-HISTORY-PROFILE.md` are normative for Stage 2.
Apply only those algorithms, config values, evidence rules, and guarded DEMO
history bounds. Measured cluster/weight/threshold changes remain proposal-only.

**Stage 2 recovery profile.** On 2026-07-28 the operator explicitly authorized
`APPROVE STAGE 2 RECOVERY ADDENDUM`. The deterministic same-direction
candidate ranking, separate analysis-only/cost-invalid history boundary, and
direction-aware binary-phi convention in
`docs/PROPOSED-STAGE2-RECOVERY-ADDENDUM.md` are normative. Apply only those
readings. Never weaken `ParquetBarStore`, use the analysis-only cohort for
replay or costs, connect to a live account, or apply the resulting measured
cluster/weight/threshold proposal without its later explicit authorization.

**Stage 2 evaluation-window profile.** On 2026-07-30 the operator explicitly
authorized `APPROVE STAGE 2 EVALUATION WINDOW PROFILE`. The exact
common-window, closed-H1/no-lookahead, semantic cluster mapping, and partial
pre-HTF score-distribution readings in
`docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md` are normative. Stage 2
goldens and visuals may be regenerated and the recovered-history co-firing
proposal may be run using only those readings. Do not apply any resulting
measured cluster, weight, threshold, regime-permission, or production-config
proposal without its later explicit authorization.

**Stage 2 recovered history.** The authorized analysis-only/cost-invalid cohort
is complete under
`data/stage2-history-20260728/analysis-only-cofire/`: 135,447 H1/M15 bars,
108 inventoried content files, and content SHA-256
`c9388bb323131c9db44975f1637b4d5a5ebab14c4fd79bb3dd06dd2a08f1b38d`.
The store must remain fail-closed for incomplete or altered captures, and
`ReplayEngine` must continue to refuse sources declaring `analysis_only=true`
or `cost_valid=false`.

So in `backend/regime/`, `backend/scoring/` and `backend/lifecycle/`:

- Stage 1 production code is implemented against the approved readings.
- The full suite is green and the one-year evidence report exists. The gate is
  partial until its declared data and later-stage dependencies are available;
  see `docs/STAGE1-STATUS.md`.
- Tests assert against config they declare themselves, never against
  `config/*.yaml`, so a calibration table stays pinned to the ALPHA and weights
  the spec computed it with.

---

## The twelve rules

Violating any of these fails the task, regardless of whether the code works.

1. **Strategy modules are pure functions of a bar window.** No I/O, no global state, no network, no clock reads.
2. **A strategy module never reads the regime.** Tier 1 gates modules externally. A module that checks regime internally smears Tier 1 across 28 files and destroys testability.
3. **All times are UTC internally.** Convert only at the display boundary.
4. **No order is placed without an idempotency key.**
5. **No test connects to a live account.** A module-level guard raises unless the account is demo.
6. **Evaluation happens on bar close, not on tick.**
7. **AUTO execution defaults to off, and to demo.** Live requires a per-symbol toggle plus `MDTALPHAFX_ALLOW_LIVE_AUTO=1`.
8. **A suppressed signal must record why.** Every gate rejection writes its failing condition to the journal.
9. **A locked signal is immutable.** Once levels freeze, no later evaluation may change side, entry, stop or targets.
10. **The pattern engine never enters a score.** Advisory only, separately configured, cannot override a Smart Analyzer decision.
11. **Every signal resolves.** Taken or not, each locked signal reaches a terminal state with an `OutcomeRecord`. Real and replayed outcomes are never aggregated without labels.
12. **No unapproved model config writes.** The LLM reads computed statistics
    and proposes in prose. A model may apply an exact reviewed profile only
    after explicit human approval; later parameter changes still require
    walk-forward validation and a new approval.

---

## Standing constraints

**Contracts are frozen.** The Pydantic models in spec §2 are fixed after Stage 0. Do not add, rename, reorder or retype a field to make your task easier — changing them invalidates every module. If a contract genuinely blocks you, stop and report it.

**Config, never constants.** Every threshold, weight, ATR multiple, timeout and session window lives in `config/*.yaml`. A numeric literal in logic is a bug. Applies to: cluster weights, ALPHA, both thresholds, ADX bands, level constants, pattern filters, trailing distances.

**Never assume broker values.** `digits`, `point`, `tick_value`, `volume_step`, `stops_level`, `freeze_level` come from `symbol_info()` at startup and are resolved per symbol. Hardcoding any of them is a financial bug, not a style issue.

**Two numbers are always shown together.** A score never appears without its breadth and quality. Enforced by the `ScoreDisplay` component's props, not by convention.

**Direction is never colour alone.** Glyph, word, and colour — three channels, always.

---

## When you are uncertain

Stop and report. Do not choose a value, infer a default, or pick the interpretation that lets you finish.

The spec deliberately leaves 28 decision rows to the operator (Appendix B) and marks the cluster weights as an unmeasured hypothesis. Those are handoff points, not gaps for you to fill. A confident guess that compiles is the most expensive thing you can produce here.

Report ambiguity as: what you needed, which spec section was silent or contradictory, and what the candidate readings are. Do not pick one.

---

## Testing

- Recorded MT5 fixtures, replayed deterministically. No test touches the network.
- Golden-file tests per strategy module.
- Mock broker implementing `order_send()` with realistic rejections: requote, invalid stops, invalid volume, partial fill, market closed.
- Live-account guard raises unless the account is demo, overridable only by a deliberately-set environment variable.

## Stack

Python 3.11+ · FastAPI · SQLite · MetaTrader5 package · React 19 · Next.js App Router (`output: 'export'`, served by FastAPI — there is no Node runtime) · Tailwind v4 · TanStack Query v5 · Motion · lightweight-charts v5.

One process talks to MT5. That process is the Python engine. No exceptions.
