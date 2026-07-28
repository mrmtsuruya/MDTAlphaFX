# MDTAlphaFX agent instructions

This repository is governed by staged operator authorization. Read these files
before changing code:

1. `MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md`
2. `CLAUDE.md`
3. `docs/CODEX-HANDOFF.md`
4. `docs/STAGE2-STATUS.md`
5. `docs/PROPOSED-STAGE2-EVALUATION-WINDOW-PROFILE.md`

The current stage is Stage 2. The recovery addendum is complete, but the
evaluation-window profile is only proposed.

Do not regenerate Stage 2 recorded goldens, rerender the Stage 2 visual pack,
run the recovered-history co-firing proposal, or add
`strategies.co_firing.evaluation_window_policy` unless the operator sends this
exact authorization:

`APPROVE STAGE 2 EVALUATION WINDOW PROFILE`

That phrase does not authorize applying the resulting measured
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

Expected: `963 passed`.
