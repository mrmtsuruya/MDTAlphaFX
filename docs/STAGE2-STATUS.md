# Stage 2 status

Status: **EVALUATION-WINDOW IMPLEMENTATION IN PROGRESS**

Authorization received: `APPROVE + DELEGATE STAGE 2` on 2026-07-28.  
Detector/history authorization received:
`APPROVE STAGE 2 DETECTOR + HISTORY PROFILE` on 2026-07-28.
Recovery authorization received:
`APPROVE STAGE 2 RECOVERY ADDENDUM` on 2026-07-28.
Evaluation-window authorization received:
`APPROVE STAGE 2 EVALUATION WINDOW PROFILE` on 2026-07-30.

Current whole-config version: `849d204ba18a`.

## Completed

- Applied the approved immutable detector profile in
  `config/strategies.yaml`.
- Implemented the complete static registry and all 28 pure §4 strategy
  modules. Evaluation remains closed-bar, regime-independent, deterministic,
  I/O-free, and bound to the frozen §4.1 result contract.
- Added pure shared indicator and geometry helpers with parameterized
  SMA-seeded EMA, Wilder ATR/RSI/ADX-DI, pivots, volume medians, and evidence
  validation.
- Closed the explicit per-module synthetic matrix: every module has a
  deterministic positive, a full-window negative, an approved threshold
  boundary/just-outside case, and a short-window flat case.
- The pre-recovery M15 golden and visual corpus is preserved for comparison.
  The authorized collision ranking changed recorded output for modules
  2–6 and 9, so those artifacts are now explicitly stale and will be
  regenerated under the now-authorized common-window policy.
- Implemented and tested the pure co-firing metrics/clustering core and its
  fail-closed proposal harness. It has not been run against recovered history
  and has not changed approved config.

## Verification receipt

| Gate | Result |
|---|---|
| Stage 2 non-golden suite after collision recovery | **110 passed** |
| Existing Stage 0/1 regression suite | **828 passed** |
| Clean combined regression after evaluation-window wiring | **964 passed** |
| Focused store/recorder/replay/proposal integrity suite | **63 passed** |
| Full suite audit | **965 passed · 28 expected stale-golden failures** |
| Recorded-golden comparison | **HELD · all 28 legacy payloads require explicit regeneration/review** |
| Strategy/test/script compilation | **PASS** |
| Registry | **28 modules, ids 1–28 exactly once** |
| Pre-recovery visual evidence | **STALE · preserved for comparison** |
| Pre-recovery contact-sheet SHA-256 | `202b20a2a2f1011917b884419478902531e9d3cf2a215ecd2689f6ee3d74e4bc` |

Review:

- `docs/stage2-gate/contact-sheet.png`
- `docs/stage2-gate/visual-manifest.md`

## Original history capture integrity stop

The approved guarded DEMO recorder captured complete XAUUSD H1/M15 and EURUSD
H1/M15 series, then stopped while writing GBPUSD H1. The broker-supplied
`GBPUSD.m` bar at `2025-10-30T13:00:00Z` has `spread=0`.

The strict `ParquetBarStore` correctly refused it. The row was not dropped,
interpolated, replaced, or silently accepted, and the replay/cost-valid store
was not weakened. That original strict partial capture remains incomplete and
has not been used for co-firing conclusions.

## Authorized recovery

`docs/PROPOSED-STAGE2-RECOVERY-ADDENDUM.md` now specifies:

1. the deterministic modules 1–10 same-direction candidate ranking;
2. a separate analysis-only, cost-invalid history store that preserves raw zero
   spread without ever becoming a replay/backtest source; and
3. the exact direction-aware binary-phi convention so opposite-direction fires
   remain conflicts rather than agreement.

The operator authorized `APPROVE STAGE 2 RECOVERY ADDENDUM` on 2026-07-28.
The deterministic candidate ranking is applied, and the separate
`Stage2AnalysisParquetStore` now preserves raw nonpositive spread under
`data/stage2-history-20260728/analysis-only-cofire/`. The strict partial store
and `ParquetBarStore` remain untouched.

The exact guarded cohort is captured: 27,096 H1 bars and 108,351 M15 bars
across all four symbols, with eight raw zero-spread rows preserved and every
no-bar interval hashed. Its 108 content files are transactionally finalized and
verified by content SHA-256
`c9388bb323131c9db44975f1637b4d5a5ebab14c4fd79bb3dd06dd2a08f1b38d`.
Incomplete or altered captures fail closed, and `ReplayEngine` explicitly
refuses the analysis-only/cost-invalid store. See
`docs/STAGE2-HISTORY-RECEIPT.md`.

The operator authorized the exact common-window, closed-H1/no-lookahead,
semantic cluster mapping, and partial pre-HTF score-distribution readings in
`docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md` on 2026-07-30.

Active work is attaching closed H1 regimes to M15
observations, regenerating the recorded goldens and visuals, running the
co-firing matrix, and emitting the
correlation-derived membership/equal-weight/calibration proposal. The proposal
will not be applied to config without a later explicit authorization.

The common 203-bar evaluator and exact closed-H1 attachment are wired. Resume
at the still-missing deterministic maximum-overlap mapping from measured sets
to A/B/C/D1/D2/E/F/G/H and the explicitly partial
`pre_htf_score_distribution` with `htf_penalty_applied=1.0`. The current runner
still contains obsolete `BLOCKED_PENDING_AUTHORIZATION` mapping language; that
is an implementation marker, not a new authorization requirement.

Nothing here authorizes live-account access, order placement, AUTO, Stage 2b,
Stage 3, weakening the cost-valid store, or application of measured
cluster/weight/threshold changes.
