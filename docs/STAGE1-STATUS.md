# Stage 1 status

Status: **IMPLEMENTATION COMPLETE — EVIDENCE GATE PARTIAL**

Authorization: `APPROVE PROFILE + DELEGATE STAGE 1`  
Config/decision record: `docs/PROPOSED-SHIPPING-PROFILE.md`  
Applied whole-config version: `2649cd2dcd12`  
Canonical packaged artifact version: `ffc670e8179c` (internally consistent,
but superseded by the staged current-config evidence below)

## Completed

- Pure §3.1 regime features: ADX(14), slope-aware EMA(20/50/200), ATR(14)
  trailing-100 percentile, R²(50), and explicit calendar flags.
- Ordered regime classifier, approved ADX dead bands, three-bar confirmation,
  cluster map, confidence, and H4 bias penalty.
- Production config adapter that validates the real YAML cluster registry,
  regime maps, denominators, thresholds, ALPHA, and MTF policy at startup.
- Clustered and FLAT scoring, vote tally, validity/visibility/AUTO split, and
  typed candidate-centric MTF policy with M15 as the explicit default entry
  timeframe.
- Symmetric entry zones, broker/ATR stop floors, typed opposing structures,
  one-tick inward targets, distinct TP2 support, and post-snap RR.
- Forward-only lifecycle machine plus FIFO per-symbol/timeframe service,
  explicit forming/resolution/regime-confirmation gates, provisional refresh,
  TAKEN/IGNORED events, persistence seam, expiry, immutability, and ignored-
  signal counterfactual monitoring.
- Stage 0 fallback logic: internal M1 gaps use §11.1 fallback, missing
  minutes/gap runs are diagnostic, fallback trades must be marked ambiguous,
  and more than 5% trade ambiguity is labelled `PASS (LOWER_BOUND)`.

## Verification

```text
python -m compileall -q backend scripts tests
PASS

python -m pytest -q
828 passed

python scripts/run_gate.py
cost precondition PASS
synthetic end-to-end PASS
M1 intrabar/fallback condition PASS
three RECORDED fixture periods qualified
33 recorded trades across the fixture set
STAGE 0 GATE: PASSED — RECORDED FIXTURES QUALIFIED

python scripts/run_stage1_gate.py --output-dir docs/stage1-gate-recovery-20260728
current-config replay generated
independent transition audit PASS_WITH_DIAGNOSTIC_CAVEATS
portable HTML packaging blocked by the disclosed 8-pixel reader overflow
```

No Stage 1 `NotImplementedError` remains in `backend/regime`,
`backend/scoring`, or `backend/lifecycle`.

## One-year replay evidence

The latest guarded DEMO replay, staged under
`docs/stage1-gate-recovery-20260728/`, produced:

- 27,090 ready H1 classifications across XAUUSD, EURUSD, GBPUSD, and BTCUSD;
- 1,972 effective regime switches;
- 84 independently audited one-bar segments;
- zero raw-classification, hysteresis, age, entry-support, or impossible-
  transition failures;
- 76 mechanically valid A→B→A one-bar round trips retained as an operating-
  churn diagnostic;
- one-bar price triage of 17 supportive, 49 mixed, 17 contradictory, and
  1 not-scored case;
- matching staged replay/audit/config version `2649cd2dcd12`.

Current-config staged artifacts:

- `docs/stage1-gate-recovery-20260728/artifact.json`
- `docs/stage1-gate-recovery-20260728/regime_replay.json`
- `docs/stage1-gate-recovery-20260728/transition_audit.json`
- `docs/stage1-gate-recovery-20260728/transition_audit.md`
- `docs/stage1-gate-recovery-20260728/QA.md`
- `docs/stage1-gate-recovery-20260728/report-build-failure.png`

Last known-good canonical package:

- `docs/stage1-gate/report.html`
- `docs/stage1-gate/artifact.json`
- `docs/stage1-gate/regime_replay.json`
- `docs/stage1-gate/transition_audit.json`
- `docs/stage1-gate/transition_audit.md`
- `docs/stage1-gate/QA.md`
- `docs/STAGE1-SPEC-AUDIT.md`

The report evidence is intentionally `partial`: no economic-calendar source was
available, and realised score observations cannot exist until the 28 Stage 2
modules emit results. The current-config JSON and independent audit are
complete and version-matched in staging. The canonical HTML package was not
overwritten because the required portable-browser verifier still reports an
8-pixel horizontal overflow owned by the shared reader chrome. The packaging
blocker is documented in the staged `QA.md`; no partial package was promoted.

## Remaining authorization and evidence boundaries

1. Fixture recovery was authorized and the three replacement windows were
   recorded on 2026-07-28. The recorded Stage 0 gate now passes all three
   periods without a synthetic qualifier. The high-volatility period reports
   zero executable trades and no conclusions because its 28-point spread
   exceeds the approved 26-point XAUUSD ceiling. See
   `docs/FIXTURE-RECOVERY-STATUS.md`.
2. The whole-config version is now `2649cd2dcd12`. A regenerated Stage 1 bundle
   exists under `docs/stage1-gate-recovery-20260728/`, but the portable HTML
   builder again detects the disclosed 8-pixel horizontal overflow. The
   canonical bundle remains untouched until that packaging QA passes.
3. Supply a versioned economic-calendar blackout dataset and rerun the report.
4. Stage 2 implementation/delegation was separately authorized on 2026-07-28.
   Its exact detector/history profile remains pending; see
   `docs/STAGE2-STATUS.md`. After the 28 modules and co-firing measurement,
   regenerate weights and populate the realised score distribution before
   changing ALPHA or thresholds.
5. Re-run enhanced report QA after the shared portable reader corrects or
   tolerates its 100vw scrollbar overflow.

The original Stage 1 authorization did not authorize Stage 2; that scope has
since been delegated separately. Nothing here authorizes live-account access,
order placement, AUTO execution, Stage 2b, Stage 3, or later config changes.
