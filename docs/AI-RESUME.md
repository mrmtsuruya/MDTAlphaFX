# MDTAlphaFX provider-neutral AI resume

Updated: 2026-07-30
Current stage: **Stage 2 — evaluation-window implementation in progress**
GitHub: `mrmtsuruya/MDTAlphaFX`
Handoff branch: `agent/github-handoff-sync`

This is the canonical entry point for a new cloud or local coding model. It is
deliberately independent of Codex, Claude, Hermes, LM Studio, Obsidian, and the
chat that produced the checkpoint.

## Start here

Before editing:

```powershell
git status -sb
git log -5 --oneline --decorate
```

Then read, in order and in full:

1. `MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md`
2. `CLAUDE.md`
3. `AGENTS.md`
4. this file
5. `docs/CODEX-HANDOFF.md`
6. `docs/STAGE2-STATUS.md`
7. `docs/STAGE2-HISTORY-RECEIPT.md`
8. `docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md`
9. `docs/AMBIGUITY.md`, especially 024–026

Do not rely on a model's summary of these files. The specification and staged
authorizations are the contract.

## Authorization ledger

The operator has explicitly authorized:

- `APPROVE PROFILE + DELEGATE STAGE 1`
- `APPROVE FIXTURE RECOVERY ADDENDUM`
- `APPROVE + DELEGATE STAGE 2`
- `APPROVE STAGE 2 DETECTOR + HISTORY PROFILE`
- `APPROVE STAGE 2 RECOVERY ADDENDUM`
- `APPROVE STAGE 2 EVALUATION WINDOW PROFILE`
- `APPROVE GITHUB HANDOFF SYNC`

These authorizations permit the current Stage 2 evaluation-window evidence
work. They do **not** permit applying a measured proposal, live-account access,
order placement, AUTO execution, Stage 2b, or Stage 3.

## Durable code checkpoint

Implemented and verified:

- 28 pure, closed-bar, regime-independent strategy modules are registered
  exactly once.
- `strategies.co_firing.evaluation_window_policy` is
  `COMMON_MAX_MIN_BARS`.
- The shared window is derived from the registry and is currently 203 M15 bars.
- `evaluate_common_window_population()` supplies the same recent 203 closed
  bars to every strategy.
- H1 verdict attachment uses the exact no-lookahead close boundary.
- The co-firing CLI now consumes the authorized common window.
- The recorded-golden harness records the policy, common window, and all 28
  module `min_bars` values.
- The visual renderer validates one identical evaluation receipt before it
  creates output.
- The recovered analysis-only/cost-invalid cohort remains fail-closed with
  content SHA-256
  `c9388bb323131c9db44975f1637b4d5a5ebab14c4fd79bb3dd06dd2a08f1b38d`.
- `ReplayEngine` still refuses analysis-only or cost-invalid sources.

## Exact resume point

Resume in:

- `backend/analysis/stage2_proposal.py`
- `scripts/run_stage2_cofire.py`
- `tests/stage2/test_stage2_proposal.py`

The runner still emits neutral P01–P09 clusters and says semantic mapping is
`BLOCKED_PENDING_AUTHORIZATION`. That language is now obsolete: the evaluation
profile authorized the mapping algorithm, but did not authorize applying its
result.

The next bounded implementation checkpoint is:

1. Implement the deterministic maximum-total-overlap one-to-one assignment
   from measured sets to semantic IDs `A/B/C/D1/D2/E/F/G/H`.
2. Preserve cluster IDs anchored by insufficient modules.
3. Break equal-overlap assignments by measured-set member tuple, then choose
   the lexicographically smallest cluster-ID tuple.
4. Emit the complete measured-set × current-ID overlap matrix, chosen
   assignment, objective total, and tie-break receipt.
5. Use the mapped proposal only to regenerate theoretical Stage 1 reachability
   evidence. Do not write it into `config/clusters.yaml` or the regime map.
6. Emit an explicitly partial `pre_htf_score_distribution` with
   `htf_penalty_applied=1.0`, `calendar_supplied=false`, and a clear statement
   that final realised Stage 1 scores remain unavailable without H4 evidence.
7. Add focused unit tests for the mapping optimum, anchored IDs, tie break,
   overlap receipt, and partial-distribution labels.

After that checkpoint:

1. Regenerate all 28 recorded goldens explicitly.
2. Review every changed payload; do not bulk-accept snapshots.
3. Rerender and hash all 28 evidence-only visuals.
4. Run the verified four-symbol recovered-history proposal.
5. Review proposal memberships, equal weights, calibration evidence,
   reachability, hashes, and receipts.
6. Run the complete regression and update `CLAUDE.md`,
   `docs/CODEX-HANDOFF.md`, `docs/STAGE2-STATUS.md`, this file, and
   `docs/AI-RESUME.json`.
7. Stop before applying anything and print the exact next operator
   authorization phrase supported by the measured evidence.

## Verification receipt

Last run on 2026-07-30:

```powershell
python -m pytest -q tests\unit tests\stage1 `
  tests\golden\test_trivial_golden.py tests\stage2 `
  --ignore=tests\stage2\test_recorded_goldens.py
```

Result: **964 passed**.

```powershell
python -m pytest -q `
  tests\unit\test_stage2_analysis_store.py `
  tests\unit\test_record_stage2_history.py `
  tests\unit\test_replay.py `
  tests\stage2\test_stage2_proposal.py
```

Result: **63 passed**.

Full audit:

```powershell
python -m pytest -q
```

Result: **965 passed, 28 failed**. Every failure is
`tests/stage2/test_recorded_goldens.py::test_module_matches_recorded_fixture_golden`
for modules 1–28. This is the expected stale-snapshot boundary: the legacy
payloads lack the authorized common-window receipt and use the old evaluation
horizon. Treat any other failing test as a new regression.

## Hard safety boundaries

- Never connect tests to a live account.
- Never place, modify, or cancel an order in Stage 2.
- Never enable AUTO.
- Never weaken `ParquetBarStore`; it must reject nonpositive spread.
- Never use `Stage2AnalysisParquetStore` for replay, costs, fills, outcomes, or
  performance.
- Never accept incomplete or content-altered history.
- Never change strategy purity, closed-bar evaluation, or regime independence.
- Never apply measured cluster membership, weights, thresholds, alpha, regime
  permissions, or production configuration without a later exact approval.
- Never hide, rewrite, or reinterpret the expected golden failures to make the
  full suite green.

## Copy/paste prompt for another model

```text
Resume MDTAlphaFX from branch agent/github-handoff-sync. Read AGENTS.md and
docs/AI-RESUME.md, then every required source they list, in full. The current
authorized task is Stage 2 evaluation-window evidence only. Start at the exact
resume point in docs/AI-RESUME.md: implement and test deterministic
maximum-overlap semantic cluster mapping plus the explicitly partial pre-HTF
distribution. Preserve every fail-closed data/replay boundary. Do not apply the
measured proposal, access a live account, place orders, enable AUTO, or start
Stage 2b/Stage 3. Verify each bounded patch and update all durable handoff files
before stopping at the next authorization boundary.
```
