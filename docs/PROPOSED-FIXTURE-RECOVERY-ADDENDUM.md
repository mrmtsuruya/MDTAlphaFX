# Proposed fixture recovery addendum

Status: **APPROVED AND APPLIED 2026-07-28**

This addendum exists because the approved 2025 fixtures failed their recording
gate against the guarded `DEMO` account on `JustMarkets-Demo2`. The terminal
returned all requested analysis bars for those windows but returned zero M1
bars. Without any M1 series, §11.1 cannot attempt its preferred sub-bar walk.

The shipping profile already says that a failed fixture gate sends the window
back for reselection. Rule 12 still requires an explicit approval before the
replacement dates are written to `config/backtest.yaml`.

## Replacement windows

All bounds are half-open and UTC. Each replacement was read successfully at H4,
H1, M15, M5, and M1. The recovery window length is 150 H1 bars. ADX(14),
ATR(14), the trailing-100 ATR percentile, and H1 selection granularity are
unchanged.

| Period | Symbol | Start | End | Selection evidence | M1 diagnostics |
|---|---|---|---|---|---|
| Trending | BTCUSD | 2026-06-29T04:00:00Z | 2026-07-05T10:00:00Z | mean ADX 32.1868; 130/150 bars above 27 | 8,961/8,965 expected minutes; 4 missing in 3 runs; longest run 2 minutes |
| Ranging | GBPUSD | 2026-06-09T16:00:00Z | 2026-06-17T22:00:00Z | mean ADX 17.8050; 104/150 bars below 20; 71/150 jointly ADX < 20 and ATR percentile < 60 | 8,979/9,000 expected minutes; 21 missing in 13 runs; longest run 4 minutes |
| High volatility | XAUUSD | 2026-06-07T23:00:00Z | 2026-06-16T11:00:00Z | mean ATR percentile 63.2333; 45/150 bars above 90; volatility wins the ordered classifier on those bars | 8,987/9,000 expected minutes; 13 missing in 7 runs; longest run 2 minutes |

The expected-minute denominator follows the store's own rule: five expected M1
bars for each recorded M5 bar.

## Gate interpretation

Internal M1 gaps do not invalidate a fixture. §11.1 requires the conservative
`STOP_FIRST` fallback and an `AMBIGUOUS_FILL` flag whenever a necessary sub-bar
walk is unavailable. Minute-gap percentage is diagnostic only; the replay's
trade-level ambiguity rate is authoritative. A rate above 5% makes the equity
curve a lower bound and must be reported as such.

The recorded-fixture gate must therefore:

1. require every analysis timeframe to span the requested window;
2. require a non-empty M1 series whose coverage reaches the window;
3. report M1 gap runs and missing minutes without rejecting internal gaps;
4. assert that every `FALLBACK_NO_M1` trade has `ambiguous_fill=True`;
5. qualify a replay above 5% ambiguity as `PASS (LOWER_BOUND)`.

## Approval

The operator supplied the exact authorization:

`APPROVE FIXTURE RECOVERY ADDENDUM`

This approval authorizes only the three replacement fixture selections and the
gate interpretation above. It does not authorize live-account access, order
placement, AUTO execution, or any later-stage parameter change.
