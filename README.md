# MDTAlphaFX

MDTAlphaFX is a staged quantitative-analysis and MT5 execution-engine project
for a single operator. It includes the Python engine, deterministic tests and
evidence, the approved Stage 2 history cohort, and a disconnected simulation
frontend.

The normative product specification is
[`MDTAlphaFX SPEC v2 - Quant Platform & Execution Engine.md`](MDTAlphaFX%20SPEC%20v2%20-%20Quant%20Platform%20%26%20Execution%20Engine.md).

## Current checkpoint

The project is in **Stage 2 evaluation-window implementation**. The operator
authorized `APPROVE STAGE 2 EVALUATION WINDOW PROFILE` on 2026-07-30:

- all 28 pure strategy modules and their registry exist;
- the authorized same-bar collision ranking is applied;
- the analysis-only/cost-invalid H1/M15 cohort contains 135,447 bars;
- its 108 content files verify against SHA-256
  `c9388bb323131c9db44975f1637b4d5a5ebab14c4fd79bb3dd06dd2a08f1b38d`;
- replay explicitly refuses that detector-only data source;
- the registry-derived common evaluation window is 203 M15 bars;
- the proposal and recorded-golden harnesses now use that common window; and
- 964 clean combined tests plus 63 focused integrity tests pass.

All 28 recorded golden snapshots are intentionally stale against the new
common-window receipt and must be regenerated and reviewed explicitly. The
full suite currently reports `965 passed, 28 failed`, with all failures confined
to `tests/stage2/test_recorded_goldens.py`.

The next code checkpoint is the deterministic maximum-overlap mapping from
measured clusters to semantic IDs A/B/C/D1/D2/E/F/G/H, followed by the approved
partial pre-HTF score distribution. Do not apply the measured proposal to
production config.

Start any new cloud or local agent session with [`AGENTS.md`](AGENTS.md) and the
provider-neutral [`docs/AI-RESUME.md`](docs/AI-RESUME.md). The older
[`docs/CODEX-HANDOFF.md`](docs/CODEX-HANDOFF.md) remains a detailed compatible
handoff.

## Repository map

- `backend/` — contracts, data boundaries, replay, Stage 1 engine, 28 Stage 2
  detectors, and proposal analysis
- `config/` — versioned strategy, cluster, regime, execution, and level config
- `data/stage2-history-20260728/analysis-only-cofire/` — verified detector-only
  H1/M15 cohort; never valid for replay, costs, fills, or performance
- `fixtures/` and `tests/` — deterministic recorded evidence and regression
  suites
- `scripts/` — guarded recorders, gate runners, visualization, and co-firing
  proposal entry points
- `frontend/` — responsive disconnected SIM operator console
- `docs/` — approvals, ambiguity register, status receipts, and evidence

## Backend setup

Python 3.11+ is the target:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m pytest -q
```

The complete suite currently reports 28 expected stale-golden failures in
`tests/stage2/test_recorded_goldens.py`. The clean checkpoint command is:

```powershell
python -m pytest -q tests\unit tests\stage1 `
  tests\golden\test_trivial_golden.py tests\stage2 `
  --ignore=tests\stage2\test_recorded_goldens.py
```

Expected result: `964 passed`.

## Frontend setup

Node.js 22.13+:

```powershell
Set-Location frontend
npm ci
npm run dev
```

The UI is a deterministic SIM preview and is not connected to MT5 or the
Python execution engine. The private deployed preview and safety boundary are
documented in [`docs/FRONTEND-PREVIEW-STATUS.md`](docs/FRONTEND-PREVIEW-STATUS.md).

## Safety

Nothing in the current checkpoint authorizes live-account access, order
placement, AUTO execution, applying measured cluster/weight/threshold
proposals, Stage 2b, or Stage 3. See [`CLAUDE.md`](CLAUDE.md) for the standing
engineering constraints.
