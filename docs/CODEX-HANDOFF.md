# Codex handoff — resume here

Checkpoint date: 2026-07-30
Current stage: **Stage 2 — evaluation-window implementation in progress**
Whole-config version: `849d204ba18a`

## Required first action

Read, in order:

1. `MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md`
2. `CLAUDE.md`
3. `docs/AI-RESUME.md`
4. `docs/STAGE2-STATUS.md`
5. `docs/STAGE2-HISTORY-RECEIPT.md`
6. `docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md`
7. `docs/AMBIGUITY.md`, especially 024–026

The operator explicitly authorized
`APPROVE STAGE 2 EVALUATION WINDOW PROFILE` on 2026-07-30. Implement only the
approved profile; do not infer authorization for applying measured proposals.

## Authorizations already received

- `APPROVE PROFILE + DELEGATE STAGE 1`
- `APPROVE FIXTURE RECOVERY ADDENDUM`
- `APPROVE + DELEGATE STAGE 2`
- `APPROVE STAGE 2 DETECTOR + HISTORY PROFILE`
- `APPROVE STAGE 2 RECOVERY ADDENDUM`
- `APPROVE STAGE 2 EVALUATION WINDOW PROFILE`

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
  file excluded: `964 passed`
- Full suite audit: `965 passed, 28 failed`
- Compilation: passed

All 28 expected failures are confined to
`tests/stage2/test_recorded_goldens.py`. Every old payload lacks the authorized
common-window receipt and was recorded under the legacy evaluation horizon;
modules 2–6 and 9 were already content-stale after collision recovery. The old
28-image visual pack is preserved but also marked pre-recovery/stale.

Do not “fix” the failures by weakening comparisons or bulk-accepting output.
Regenerate explicitly under the common 203-bar harness and review every module.

## Authorized evaluation-window profile

The strategy protocol declares `min_bars` but not the caller’s post-minimum
window. Recorded evidence proves the choice changes module behavior:

- module 19’s final trending-fixture decision differs between full-prefix and
  bounded evaluation;
- modules 17 and 25 retain direction but change saved evidence; and
- ever-growing full-prefix evaluation is quadratic on the one-year cohort.

The authorized profile settles all linked semantics:

1. `COMMON_MAX_MIN_BARS`, derived from the registry and currently 203;
2. the same recent 203 closed M15 bars for every module;
3. exact no-lookahead H1 attachment at the M15 close instant;
4. deterministic maximum-overlap mapping from measured clusters back to
   semantic IDs A/B/C/D1/D2/E/F/G/H; and
5. an explicitly partial pre-HTF score distribution because the cohort has no
   H4 bias evidence.

## Authorized work in progress

1. **Completed:** mark the evaluation profile and AMBIGUITY-024/025/026
   approved.
2. **Completed:** add `evaluation_window_policy: COMMON_MAX_MIN_BARS` under
   `strategies.co_firing` in `config/strategies.yaml`.
3. **Partially completed:** the proposal runner uses the derived common
   203-bar M15 window and exact closed-H1/no-lookahead alignment.
4. **Resume here:** implement maximum-overlap semantic cluster-ID continuity,
   emit the full overlap matrix and deterministic tie break, replace the
   obsolete `BLOCKED_PENDING_AUTHORIZATION` mapping status, and emit the
   explicitly partial `pre_htf_score_distribution` with
   `htf_penalty_applied=1.0` and `calendar_supplied=false`.
5. Regenerate all 28 recorded goldens explicitly and review every change.
6. Rerender and hash all 28 evidence-only visuals.
7. Run measured co-firing across the verified four-symbol cohort. Parallelize
   by symbol if useful, but merge deterministically.
8. Emit proposal-only memberships, equal weights, calibration evidence,
   reachability tables, and receipts.
9. Run the complete regression and update status documentation.
10. Stop before applying the proposal and print the exact next authorization
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

Proposal runner:

```powershell
python scripts\run_stage2_cofire.py
```

Until the authorized implementation is complete, it may remain fail-closed.
After implementation it must emit proposal-only artifacts and must not mutate
approved cluster, weight, threshold, regime-permission, or production config.
