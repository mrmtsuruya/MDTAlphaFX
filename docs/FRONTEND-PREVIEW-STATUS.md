# Frontend preview status

Date: 2026-07-28

## Outcome

A private, owner-only Sites deployment now provides a visible product surface
for MDTAlphaFX:

<https://mdt-alphafx-console.mrmtsuruya.chatgpt.site>

- Sites project: `appgprj_6a6895237b408191852a77a102cfbf2e`
- Saved version: 1
- Source commit: `5e0ac51c4266e05e85f5d9c95f94ae2fdca25bba`
- Local source: `frontend/`

The Hercules application was treated as a visual reference. Its simulated
ticking prices and heuristic signals were not copied as production market
logic, and its Business-plan export restriction was not bypassed.

## Implemented preview surface

- Market Overview
- Signal Center
- Chart workspace
- 28-module Strategies catalogue
- Stage 0 Backtester evidence summary
- Responsive dark terminal design system
- Explicit engine connection boundary

## Safety boundary

This deployment is a visual preview, not the complete Stage 4 application:

- every market value, candle, signal, level and score is a deterministic UI
  fixture unless explicitly identified as a Stage 0 evidence receipt;
- the Python/MT5 engine is disconnected;
- the Stage 2 strategy modules are implemented in Python but are not connected
  to this preview;
- execution and order routing remain OFF;
- no AUTO behavior, order dispatch or live trading was authorized;
- the current project stage is the Stage 2 evaluation-window authorization
  gate.

## Validation

- vinext production build: pass
- all five routes server-rendered: pass
- explicit SIM/disconnected boundary assertions: pass
- strict TypeScript: pass
- ESLint: pass
- independent UI audit findings addressed before publication

## Remaining product work

The specification's complete Stage 4 surface still requires Stage 3 API and
signal-contract readiness plus explicit authorization. Missing views and
capabilities include Smart Analyzer, Opportunity Radar, Pattern Strategy,
Scanner, Positions/Risk, Journal, Risk Calculator, Data/Settings, complete
threshold filtering, vote breakdowns, and the final grouped navigation model.

The Sites/vinext runtime is intentionally a private review target. The final
desktop/FastAPI delivery architecture in the specification remains a separate
integration task.
