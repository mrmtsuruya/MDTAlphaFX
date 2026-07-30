# MDTAlphaFX agent instructions

This repository is governed by staged operator authorization. Read these files
before changing code:

1. `MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md`
2. `CLAUDE.md`
3. `docs/AI-RESUME.md`
4. `docs/CODEX-HANDOFF.md`
5. `docs/STAGE2-STATUS.md`
6. `docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md`

`docs/AI-RESUME.md` is the provider-neutral entry point. It must remain
accurate enough for a new cloud or local coding model to resume without this
chat history.

The current stage is Stage 2. The recovery addendum is complete, and the
operator authorized `APPROVE STAGE 2 EVALUATION WINDOW PROFILE` on
2026-07-30. Implement only the exact approved common-window, closed-H1,
semantic cluster-mapping, and partial pre-HTF readings. Stage 2 recorded
goldens and visuals may be regenerated and the recovered-history co-firing
proposal may be run.

That authorization does not permit applying the resulting measured
cluster/weight/threshold proposal, live-account access, AUTO, order placement,
Stage 2b, or Stage 3.

Preserve these hard boundaries:

- Strategy modules are pure, closed-bar, regime-independent functions.
- `ParquetBarStore` remains cost-valid and refuses nonpositive spread.
- `Stage2AnalysisParquetStore` is analysis-only and cost-invalid.
- `ReplayEngine` must refuse sources declaring `analysis_only=true` or
  `cost_valid=false`.
- Incomplete or content-altered Stage 2 captures must fail closed.
- The current recovered-history content SHA-256 is
  `c9388bb323131c9db44975f1637b4d5a5ebab14c4fd79bb3dd06dd2a08f1b38d`.
- Never connect tests to a live account.
- Never apply an unapproved model/config proposal.

At every authorization boundary, stop and print the exact phrase the operator
must send next. Update `docs/CODEX-HANDOFF.md`, `docs/STAGE2-STATUS.md`, and
`CLAUDE.md` whenever the durable checkpoint changes.

Clean checkpoint verification:

```powershell
python -m pytest -q tests\unit tests\stage1 `
  tests\golden\test_trivial_golden.py tests\stage2 `
  --ignore=tests\stage2\test_recorded_goldens.py
```

Expected: `964 passed`.
