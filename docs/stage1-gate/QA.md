# Stage 1 gate artifact QA

Generated: 2026-07-27T12:07:37.272738Z  
Source account: guarded `DEMO` on `JustMarkets-Demo2`  
Config version: `ffc670e8179c`

## Artifact state

- Snapshot status: `partial`
- Ready H1 classifications: 27,070 across four symbols
- Effective regime switches: 1,969
- One-bar segments independently reviewed: 83
- Raw-classification, hysteresis, age, entry-support, and impossible-transition failures: 0
- A→B→A one-bar round trips retained as an operating diagnostic: 76
- One-bar price triage: 17 supportive, 49 mixed, 17 contradictory
- Realised score observations: 0 — blocked until Stage 2 modules exist
- Calendar proximity: not supplied; ATR-percentile volatility only

The replay and independent transition audit use the same config version,
`ffc670e8179c`. The audit status is `PASS_WITH_DIAGNOSTIC_CAVEATS`: all
mechanical invariants pass, while price-coherence labels remain descriptive
rather than causal evidence.

## Packaging receipt

The canonical `artifact.json` passed package validation. The generated
`report.html` passed structural verification and exact embedded-payload equality:

```text
blocks=21 charts=2 metrics=4 tables=2 html=0
title="MDTAlphaFX Stage 1 Gate"
structural verification=PASS
embedded payload equality=PASS
```

The enhanced-browser verifier did not pass:

```text
code=horizontal_overflow
viewport=desktop 1440px
clientWidth=1425
scrollWidth=1433
overflow=8px
```

### Overflow ownership

The overflow is owned by the shared portable-reader chrome, not the Stage 1
artifact payload or `scripts/run_stage1_gate.py`. The project generator emits
the canonical JSON inputs and does not emit HTML or CSS. The shared builder
embeds a `.portable-page-header` with `width:100vw` and full-bleed
`calc(50% - 50vw)` margins; the enhanced reader applies the equivalent rule to
`.analytics-top-bar`.

At the failing desktop viewport, the vertical scrollbar reduces
`document.documentElement.clientWidth` from 1,440px to 1,425px. Centering a
1,440px (`100vw`) header against the 1,425px client area places its right edge
at 1,432.5px, which rounds to the observed 1,433px `scrollWidth`. That exact
8px signature identifies the shared chrome rule as the overflow owner. No
project-side CSS shim was added.

The failure screenshot is `report-failure.png`. The report remains a validated,
self-contained portable artifact with semantic fallback, but it must not be
described as browser-QA clean. Re-run the canonical delivery command after the
shared portable reader fixes or tolerates this reader-chrome overflow.

## Gate interpretation

This artifact completes the currently authorized Stage 1 implementation and
mechanical classifier review, but it does not close the full §9 calibration
gate. Two evidence dependencies remain visible:

1. a versioned economic-calendar blackout dataset must be supplied and replayed;
2. Stage 2 module output and measured co-firing weights must populate the
   realised score distribution before ALPHA or thresholds are reconsidered.
