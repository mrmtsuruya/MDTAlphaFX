# Codex handoff — resume here

Checkpoint date: 2026-07-28  
Current stage: **Stage 2 — evaluation-window authorization gate**  
Whole-config version: `f58ba49db649`

## Required first action

Read, in order:

1. `MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md`
2. `CLAUDE.md`
3. `docs/STAGE2-STATUS.md`
4. `docs/STAGE2-HISTORY-RECEIPT.md`
5. `docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md`
6. `docs/AMBIGUITY.md`, especially 024–026

Do not infer authorization from this handoff. The next operation remains
blocked until the operator sends:

`APPROVE STAGE 2 EVALUATION WINDOW PROFILE`

## Authorizations already received

- `APPROVE PROFILE + DELEGATE STAGE 1`
- `APPROVE FIXTURE RECOVERY ADDENDUM`
- `APPROVE + DELEGATE STAGE 2`
- `APPROVE STAGE 2 DETECTOR + HISTORY PROFILE`
- `APPROVE STAGE 2 RECOVERY ADDENDUM`

These do not authorize live-account access, order placement, AUTO execution,
Stage 2b, Stage 3, or applying a measured cluster/weight/threshold proposal.

## Completed implementation

- Stage 0 is closed with guarded recorded fixtures and deterministic replay.
- Stage 1 production regime, scoring, gate, level, and lifecycle code exists
  under `backend/regime/`, `backend/scoring/`, and `backend/lifecycle/`.
- All 28 Stage 2 strategy modules are registered exactly once.
- The immutable detector profile is stored in `config/strategies.yaml`.
- Modules 1–10 use the authorized deterministic same-direction collision
  ranking from `backend/strategies/candidate_ranking.py`.
- Direction-aware binary-phi, pair metrics, clustering, and the fail-closed
  proposal harness exist in `backend/analysis/` and
  `scripts/run_stage2_cofire.py`.
- `backend/data/stage2_analysis_store.py` implements the isolated,
  transactional, tamper-evident analysis-history store.
- `backend/backtest/replay.py` explicitly refuses analysis-only or
  cost-invalid sources.
- The disconnected simulation UI is under `frontend/`. It is visual product
  work only; it does not route orders or consume the Python engine.

## Recovered history receipt

Root:
`data/stage2-history-20260728/analysis-only-cofire/`

- Account captured: guarded DEMO `1100509764 @ JustMarkets-Demo2`
- Range: `[2025-07-28T00:00:00Z, 2026-07-28T00:00:00Z)`
- Symbols: `XAUUSD.m`, `EURUSD.m`, `GBPUSD.m`, `BTCUSD.m`
- Timeframes: H1 and M15
- H1 bars: 27,096
- M15 bars: 108,351
- Total bars: 135,447
- Preserved broker zero-spread rows: 8
- Inventoried content files: 108
- Content SHA-256:
  `c9388bb323131c9db44975f1637b4d5a5ebab14c4fd79bb3dd06dd2a08f1b38d`
- Root manifest SHA-256:
  `1da7130674e83e46d60383f25085f8d49423b5c829e80957c537192f5b579858`

This cohort is valid only for pure detector co-firing. It is not valid evidence
for replay, fills, costs, outcomes, trade metrics, or performance.

## Verification checkpoint

- Focused store/recorder/replay/proposal suite: `63 passed`
- Clean combined Stage 0/1/2 regression with the stale Stage 2 recorded-golden
  file excluded: `963 passed`
- Full suite audit: `985 passed, 6 failed`
- Compilation: passed

The six expected failures are modules 2, 3, 4, 5, 6, and 9 in
`tests/stage2/test_recorded_goldens.py`. They became stale when the authorized
candidate-ranking recovery corrected recorded output. The old 28-image visual
pack is preserved but also marked pre-recovery/stale.

Do not “fix” those six by accepting current output under the old full-prefix
harness.

## Why the next authorization is required

The strategy protocol declares `min_bars` but not the caller’s post-minimum
window. Recorded evidence proves the choice changes module behavior:

- module 19’s final trending-fixture decision differs between full-prefix and
  bounded evaluation;
- modules 17 and 25 retain direction but change saved evidence; and
- ever-growing full-prefix evaluation is quadratic on the one-year cohort.

The proposed profile settles all linked semantics in one authorization:

1. `COMMON_MAX_MIN_BARS`, derived from the registry and currently 203;
2. the same recent 203 closed M15 bars for every module;
3. exact no-lookahead H1 attachment at the M15 close instant;
4. deterministic maximum-overlap mapping from measured clusters back to
   semantic IDs A/B/C/D1/D2/E/F/G/H; and
5. an explicitly partial pre-HTF score distribution because the cohort has no
   H4 bias evidence.

## Work to perform after authorization

Only after receiving
`APPROVE STAGE 2 EVALUATION WINDOW PROFILE`:

1. Mark the evaluation profile and AMBIGUITY-024/025/026 approved.
2. Add `evaluation_window_policy: COMMON_MAX_MIN_BARS` under
   `strategies.co_firing` in `config/strategies.yaml`.
3. Update the proposal runner for:
   - the derived common 203-bar M15 window;
   - exact closed-H1/no-lookahead alignment;
   - maximum-overlap semantic cluster-ID continuity;
   - the overlap matrix and deterministic tie break;
   - `calendar_supplied=false`; and
   - the explicitly partial `pre_htf_score_distribution` with HTF penalty 1.0.
4. Regenerate all 28 recorded goldens explicitly and review every change.
5. Rerender and hash all 28 evidence-only visuals.
6. Run measured co-firing across the verified four-symbol cohort. Parallelize
   by symbol if useful, but merge deterministically.
7. Emit proposal-only memberships, equal weights, calibration evidence,
   reachability tables, and receipts.
8. Run the complete regression and update status documentation.
9. Stop before applying the proposal and print the exact next authorization
   phrase supported by the measured evidence.

The proposal run must not modify approved cluster membership, weights,
thresholds, regime permissions, or production configuration beyond the
specifically authorized evaluation-window policy.

## Useful commands

Clean checkpoint:

```powershell
python -m pytest -q tests\unit tests\stage1 `
  tests\golden\test_trivial_golden.py tests\stage2 `
  --ignore=tests\stage2\test_recorded_goldens.py
```

Focused integrity:

```powershell
python -m pytest -q `
  tests\unit\test_stage2_analysis_store.py `
  tests\unit\test_record_stage2_history.py `
  tests\unit\test_replay.py `
  tests\stage2\test_stage2_proposal.py
```

Current fail-closed proposal check:

```powershell
python scripts\run_stage2_cofire.py
```

Before authorization it must exit nonzero, explain the unresolved evaluation
semantics, and create no `docs/stage2-gate/cofiring-proposal/` directory.
