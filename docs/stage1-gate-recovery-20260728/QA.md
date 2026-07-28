# Stage 1 current-config evidence QA

Status: **DATA AND AUDIT PASS — HTML PACKAGING BLOCKED**

Generated: 2026-07-28  
Whole-config version: `2649cd2dcd12`  
Audience: technical review and Stage 1 gate audit

## Evidence receipt

- Guarded source: DEMO account `1100509764` at `JustMarkets-Demo2`.
- Replay population: 27,090 ready H1 classifications across four symbols.
- Observed effective regime switches: 1,972.
- Independently audited one-bar segments: 84.
- Sustained observed entries: 1,888.
- Independent audit: `PASS_WITH_DIAGNOSTIC_CAVEATS`.
- Replay and audit config versions match `2649cd2dcd12`.
- Raw-classification, hysteresis, age, entry-support, and impossible-transition
  failures: zero.
- Realised score observations: zero, pending Stage 2 strategy-module output.

## Report plan and chart map

The preserved technical-report structure leads with the gate outcome, then
shows the evidence supporting it:

1. **Normalized daily closing price — XAUUSD**
   - Question: what price context did the representative symbol traverse?
   - Dataset: `primary_price` from `regime_replay.json`.
   - Encoding: date on x; normalized close on y; regime, close, and ADX in the
     tooltip.
2. **Monthly regime composition**
   - Question: does the replay cover the classifier's operating regimes over
     time?
   - Dataset: `monthly_mix` from `regime_replay.json`.
   - Encoding: month on x; share on y; regime label as color.
3. **Boundary stability table**
   - Question: are one-bar segments mechanically supported, and how does the
     independent price triage describe them?
   - Dataset: independent `transition_audit.json`.
4. **Theoretical calibration table**
   - Question: is the approved scoring formula mathematically reachable?
   - Source: SPEC §5.3.2; explicitly not presented as realised observations.

## Packaging QA

The portable HTML builder first timed out before the enhanced reader was ready.
One targeted retry used a 20-second ready timeout, 8-second action timeout, and
45-second total timeout. That retry reached the verifier but failed its
`horizontal_overflow` check. The captured failure is
`report-build-failure.png`.

The observed overflow is the same disclosed 8-pixel desktop overflow associated
with the shared portable-reader `100vw` chrome. It is a packaging/reader
condition, not a classifier or evidence-data failure.

Per the report QA workflow, no further retry or verifier bypass was used.
`report.html` was not generated in this staging directory, and the existing
canonical `docs/stage1-gate/` package was left untouched.

## Remaining evidence limits

- Calendar-proximity classification is not evaluated because no versioned
  economic-calendar dataset was supplied.
- The 28 Stage 2 modules do not yet exist, so there is no realised score
  distribution or measured co-firing calibration.
- Regime labels and transition diagnostics are classifier evidence, not
  strategy-profitability evidence.
