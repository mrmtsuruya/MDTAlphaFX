# Stage 1 specification audit

Audit date: 2026-07-27  
Scope: SPEC §3, §5.1–§5.5 as assigned to Stage 1, §6.1, and the
§9 Stage 1 visual/calibration gate. Stage 2 modules, execution, AUTO routing,
orders, and fixture-window changes are outside this audit.

Status meanings:

- **PROVEN** — current production code plus direct tests or saved runtime
  evidence prove the requirement at the scope claimed.
- **INCOMPLETE** — part exists, but the required production path or evidence is
  not complete.
- **CONTRADICTION** — current evidence conflicts with the current repository
  state or the requirement.
- **MISSING** — no qualifying evidence exists.

The authoritative Stage 1 scope is the SPEC at lines 1316–1326. The delegated
prompt additionally requires explicit hysteresis, direction-aware denominators,
every calibration-table cell, provisional-before-lock levels, and post-lock
immutability (`AGENT PROMPTS - Build Kickoff.md:80-111`).

## Requirement-by-requirement result

| Requirement | Status | Current evidence and exact location |
|---|---|---|
| §3.1 ADX(14), EMA(20/50/200) alignment and slope, ATR(14) trailing-100 percentile, R²(50), calendar flag input | **PROVEN (component)** | Production computation is in `backend/regime/features.py:32-92,95-122,125-278,282-359`. The actual periods are in `config/regime.yaml:6-12`. Independent convention/edge tests are in `tests/stage1/test_regime_features.py:84-337`. Calendar flags are explicit rather than silently defaulted (`features.py:74-92,291-297`). |
| §3.2 ordered first-match classification | **PROVEN** | `backend/regime/classifier.py:136-181`; boundary and precedence tests in `tests/stage1/test_regime_classification.py:46-335`. The function runs directly with `Config.section("regime")`; it is not dependent on a test-double config shape. |
| §3.3 asymmetric ADX dead bands, three consecutive closed bars, confidence decay, immediate TRANSITIONAL | **PROVEN** | `backend/regime/classifier.py:85-133,184-274`; production values in `config/regime.yaml:35-55`; tests at `tests/stage1/test_regime_hysteresis.py:78-311`. |
| §3.4 three-state cluster map and VOLATILE_NEWS suppression | **PROVEN** | Runtime typing and map expansion are in `backend/scoring/configuration.py:160-247`; `VOLATILE_NEWS` all-suppressed is asserted at lines 196–202. The source map is `config/regime.yaml:57-108`. Cell/direction tests are `tests/stage1/test_regime_cluster_map.py:89-297`. |
| §3.4 TRANSITIONAL display uplift +5 | **PROVEN from production config** | The arithmetic predicate is `backend/scoring/gate.py:198-214`. `build_scoring_runtime_config` merges and freezes the real scoring/regime policies at `backend/scoring/configuration.py:250-325`; actual-config boundary assertions at 74.99/75.0 are `tests/stage1/test_production_scoring_configuration.py:132-136`. |
| §3.5 independent per-timeframe classification and 0.6 bias penalty | **PROVEN (component); gate coverage incomplete** | The classifier is stateless/pure and the penalty is `backend/regime/classifier.py:327-359`. Candidate-centric preservation/routing is `backend/scoring/gate.py:263-425`. The saved gate replay is H1 only (`scripts/run_stage1_gate.py:93,749,785`; `docs/stage1-gate/QA.md:8-13`), so runtime evidence does not exercise every configured analysis timeframe. |
| §5.1 nine clusters, weights total 100, modules partition 1–28, pillars independent | **PROVEN** | Immutable registry and executable invariants are `backend/scoring/types.py:25-90`. The production YAML adapter and startup checks are `backend/scoring/configuration.py:89-157`; actual-config tests are `tests/stage1/test_production_scoring_configuration.py:29-115`. |
| §5.1 approved denominators 68 / 22 / 67 / 57 | **PROVEN** | Production adapter computes and compares all four at `backend/scoring/configuration.py:204-246`. Actual-config score tests are in `tests/stage1/test_production_scoring_configuration.py:42-107`. |
| §5.1 cluster collapse: ANY firing, direction majority, ties NONE, max agreeing score | **PROVEN** | `backend/scoring/score.py:47-120`; tests in `tests/stage1/test_cluster_registry.py` and `tests/stage1/test_score_computation.py`. The production adapter also validates the declared resolution policy at `backend/scoring/configuration.py:145-150`. |
| §5.2 breadth/quality/composite kept separate; enabled denominator; full precision; 0.6 after formula | **PROVEN** | `backend/scoring/score.py:123-218`; the production model, frozen runtime policy, and config version are loaded at `backend/scoring/configuration.py:250-379`. Formula, denominator, boundary, and ceiling tests are in `tests/stage1/test_score_computation.py` and `tests/stage1/test_score_calibration.py`. |
| §5.2.1 two-sided vote tally, displayed not scored, contested flag, strongest contributor | **PROVEN** | `backend/scoring/score.py:221-274`; `tests/stage1/test_vote_tally.py`. |
| §5.2.2 FLAT compatibility mode | **PROVEN (function)** | `backend/scoring/score.py:277-312`; mode/value documented in `config/scoring.yaml:27-37`; tests are in `tests/stage1/test_score_computation.py`. Selection between CLUSTERED and FLAT remains pipeline composition in Stage 3. |
| §5.3 all structural validity failures recorded, including POOR_RR | **PROVEN (predicate)** | `backend/scoring/gate.py:29-37,115-195`; exhaustive tests in `tests/stage1/test_signal_gate.py:280-582`. The API contract requires its `firing` input to be pre-filtered to agreeing clusters (`test_signal_gate.py:24-29`), which Stage 3 must preserve. |
| §5.3 validity / visibility / AUTO threshold are separate questions; contested blocks AUTO | **PROVEN (predicates)** | `backend/scoring/gate.py:134-260`; consequence tests in `tests/stage1/test_gate_three_way_split.py:59-405`. Startup threshold ordering is invoked while building the frozen production runtime policy at `backend/scoring/configuration.py:250-325`. |
| §5.3 construct and journal a Signal whenever direction resolves, including invalid and below-threshold records | **INCOMPLETE / deferred composition** | Tests prove the intended record shape using a factory (`tests/stage1/test_gate_three_way_split.py:83-133,408-430`), but there is no production Tier-1→Tier-2→Tier-3 signal assembler or journal path yet. The SPEC assigns pipeline assembly to Stage 3 (`MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md:1346-1350`), so Stage 1 components are ready but the end-to-end behavior is not yet proven. |
| §5.3.1 and §5.3.2 every published calibration-table cell | **PROVEN arithmetically** | `tests/stage1/test_score_calibration.py:81-304` parameterizes the threshold, reachability, and ALPHA tables. Per-regime threshold consequences are covered in `tests/stage1/test_threshold_consequences.py:122-508`. |
| §5.4 H4 bias default, M15 entry default, Radar/counter-bias/suppression behavior, no averaging | **PROVEN from production config** | Routing is `backend/scoring/gate.py:263-425`. The runtime policy validates and merges engine entry/bias settings with regime multipliers at `backend/scoring/configuration.py:283-325`. Actual-config M15/0.6 behavior and a user-selected M5 override are tested at `tests/stage1/test_production_scoring_configuration.py:139-199`; detailed route tests remain in `tests/stage1/test_multi_timeframe.py`. |
| §5.5 entry zone from leading evidence; symmetric minimum ATR width | **PROVEN** | `backend/scoring/levels.py:93-157`; tests `tests/stage1/test_level_derivation.py:131-213`. The real `Config.section("levels")` shape is directly accepted. |
| §5.5 structural stop, ATR floor, broker floor widening, rounded price, human basis | **PROVEN** | `backend/scoring/levels.py:160-230`; tests `tests/stage1/test_level_derivation.py:216-469`; production values `config/levels.yaml:30-40`. |
| §5.5 R-multiple targets, inward one-tick snap, typed/stable opposing structures, distinct TP2 | **PROVEN** | `backend/scoring/levels.py:233-423`; tests `tests/stage1/test_level_derivation.py:475-667`; approved semantics `docs/PROPOSED-SHIPPING-PROFILE.md:167-177`. |
| §5.5 provisional levels before lock and POOR_RR before lock | **PROVEN (component and lifecycle guard)** | Derivation/rejection is `backend/scoring/levels.py:426-439`; ordering tests at `tests/stage1/test_level_derivation.py:732-849`. The lifecycle now refuses to lock while regime confirmation or `signal.gate.passed` is false (`backend/lifecycle/machine.py:160-181`; tests `tests/stage1/test_signal_lifecycle.py:290-340`). |
| §6.1 forward state graph and terminal states | **PROVEN** | `backend/lifecycle/machine.py:29-59,82-115`; graph/terminal tests `tests/stage1/test_signal_lifecycle.py:59-215`. |
| §6.1 SCANNING/FORMING/AWAITING transition triggers | **PROVEN** | Explicit context facts are `backend/lifecycle/machine.py:66-79`; guarded early transitions and lock are `machine.py:143-181`; regression tests `tests/stage1/test_signal_lifecycle.py:290-340`. |
| §6.1 immutable levels/side/score/votes from lock onward | **PROVEN** | Freeze set and immutable states are `backend/lifecycle/machine.py:29-51`; lock and invariant enforcement are `machine.py:160-181,277-299`; mutation/across-bar tests are `tests/stage1/test_signal_lifecycle.py:348-532`. |
| §6.1 one active signal and FIFO queue per resolved symbol/timeframe; queued record persisted immediately | **PROVEN** | `backend/lifecycle/service.py:67-108,199-230`; tests `tests/stage1/test_lifecycle_service.py:59-99`. |
| §5.5 provisional candidate refresh while service owns it | **PROVEN** | `backend/lifecycle/service.py:110-158` refreshes same-identity active/queued candidates and persists the refresh; false-gate→refresh→lock and post-lock rejection are tested at `tests/stage1/test_lifecycle_service.py:181-228`. |
| §6.1 explicit TAKEN/IGNORED event and ignored counterfactual monitoring | **PROVEN to terminal state** | Event/service code is `backend/lifecycle/service.py:30-52,172-197`; tests `tests/stage1/test_lifecycle_service.py:102-182`. Creating and attaching the terminal `OutcomeRecord` is still Stage 5b (§12), not implemented here. |
| §6.1 TTL, chase tolerance, TP1-untaken TOO_LATE, age, per-timeframe independence | **PROVEN** | `backend/lifecycle/machine.py:186-274`; tests `tests/stage1/test_signal_lifecycle.py:423-768`; production values `config/levels.yaml:61-82`. |
| §9 Stage 1: one-year regime timeline exists for chart comparison | **PROVEN; refreshed bundle staged** | The current-config replay has 27,090 ready H1 classifications, 1,972 switches, and 84 one-bar segments (`docs/stage1-gate-recovery-20260728/artifact.json`). The independent audit verified all 27,090 raw classifications and all 1,972 hysteresis transitions, with zero impossible transitions (`docs/stage1-gate-recovery-20260728/transition_audit.json`). |
| §9 Stage 1: labels and boundary flapping reviewed against contemporaneous price | **PROVEN with operating caveat** | All 84 one-bar entries and 1,888 sustained entries are mechanically supported (`docs/stage1-gate-recovery-20260728/transition_audit.json`). The review found 76/84 one-bar segments are spec-conformant A→B→A round trips, so brief cluster-map churn remains an explicit operating diagnostic. Price coherence is diagnostic and does not prove causality or profitability. |
| §9 Stage 1: calendar-proximity branch included in replay | **MISSING** | `docs/stage1-gate/QA.md:12-13,57-65` says no calendar was supplied; every saved blackout flag is false. |
| §9 Stage 1: realised one-year score distribution plotted and checked against §5.3.1 | **MISSING** | Saved score observations are zero (`docs/stage1-gate/QA.md:12`). The report says this requires Stage 2 module output and measured co-firing weights (`QA.md:57-65`). Static calibration tests do not substitute for the required realised distribution. |
| Gate artifact represents the current versioned configuration | **PROVEN in staging; canonical package stale** | The staged replay, artifact, and independent audit all record current config `2649cd2dcd12` and exact replay/audit version equality. The canonical packaged bundle remains stamped `ffc670e8179c` because its HTML replacement failed portable-reader QA. |
| Portable report browser QA | **INCOMPLETE (packaging, not classifier logic)** | The refreshed artifact validates and reaches the enhanced reader, but the packaged verifier again detects the known 8 px horizontal overflow. Failure evidence is `docs/stage1-gate-recovery-20260728/report-build-failure.png`; no inconsistent partial bundle was promoted. |

## Verification run

The full repository suite was run after the lifecycle, MTF-default,
production-config, replay, and transition-audit updates:

```text
python -m pytest -q
828 passed in 19.15s
```

This proves the covered deterministic component behavior. It does not close the
missing runtime evidence rows above.

## Audit conclusion

The Stage 1 **component implementation is substantially complete and
well-tested**. The production cluster/regime configuration boundary, startup
denominator assertions, threshold ordering, M15 default, lifecycle validation
guard, provisional refresh path, TRANSITIONAL uplift, and merged MTF runtime
policy are now real production code rather than test-only assumptions.

The regime-timeline and transition-review portion of the Stage 1 gate is
complete against the current config in the staged bundle. Canonical HTML
promotion remains blocked by the portable-reader overflow. The full Stage 1
calibration gate still requires:

1. versioned economic-calendar blackout data;
2. the realised one-year score distribution after Stage 2 produces module
   results and measured co-firing weights.

The shared-reader 8 px browser overflow remains a disclosed packaging caveat;
it is not owned by the Stage 1 payload or classifier.

The Stage 1 audit did not authorize live-account access, AUTO execution, order
placement, fixture-window changes, or Stage 2 implementation. Stage 2 was
subsequently delegated under its own authorization on 2026-07-28; its current
profile gate is tracked in `docs/STAGE2-STATUS.md`.
