# MDTAlphaFX Operator Console

Private simulation-mode frontend preview for the MDTAlphaFX quantitative
analysis and execution platform.

## Safety boundary

- All market values and candles are deterministic UI fixtures.
- The Python/MT5 engine is not connected.
- Strategy modules are pending Stage 2 implementation.
- Execution and order routing are disabled.
- Stage 0 metrics are evidence receipts, not claims of strategy profitability.

This is a five-route product slice for visual review. It is not the complete
Stage 4 interface and it is not authorized for live trading.

## Routes

- `/` — market overview
- `/signals` — signal lifecycle and validity
- `/chart` — generated chart workspace
- `/strategies` — 28-module specification catalogue
- `/backtester` — Stage 0 evidence summary

## Commands

```bash
npm install
npm run dev
npm run build
npm test
npm run lint
npx tsc --noEmit
```

The deployment target is vinext on OpenAI Sites. Optional D1 and R2 bindings
remain disabled in `.openai/hosting.json`.
