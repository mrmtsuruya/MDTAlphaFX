# MDTAlphaFX Quant Platform — Spec Review (v4)

**Reviewed:** `MDTAlphaFX QUANT PLATFORM & AUTOMATED MT5 EXECUTION ENGINE.md`, plus the 3-tier pipeline definition and full 28-module breakdown supplied separately
**Date:** 26 July 2026
**Context:** solo build driven by parallel AI agents · personal trading tool · Windows + MT5

---

## Revision note

| Version | Read | Input available |
|---|---|---|
| v1 | Ensemble → weighted score | The md file only |
| v2 | Regime dispatch | + your description (no evidence) |
| v3 | Parallel confluence, no classifier | + video frames/transcript (UI demo) |
| **v4** | **3-tier: regime gate → parallel eval → weighted confluence** | **+ the actual pipeline spec and module list** |

The reviewed md file does not contain the 3-tier pipeline. Its "Market Regime & Signal Engines" section lists the MTF Analyzer, Opportunity Radar and Multi-Pair Scanner — Tier 1 appears nowhere, and `regime` shows up only as an unexplained field in the JSON schema. A UI demo wouldn't show a gating layer either. So v2 and v3 were each half-right about a pipeline neither input fully described.

**First recommendation, therefore: put the 3-tier pipeline and the module breakdown into the spec document.** It's the architectural core of the system, it's the part agents most need to get right, and it currently lives outside the file they'll be reading. Everything below assumes it's been merged in.

---

## 1. What the design gets right

**The 3-tier structure is sound.** Gate by context, evaluate in parallel, aggregate by agreement. It maps to how a discretionary trader actually reads a chart, and — importantly — the gate is a *veto*, not a router. Strategies still all run; regime just disqualifies the inapplicable ones. That's better than true dispatch, because it degrades gracefully: a misclassified regime suppresses some strategies rather than blinding you entirely.

**Regime-based suppression of mean reversion in trends** is the single most valuable line in the spec. Mean-reversion strategies firing during a strong trend is a reliable way to lose money that no amount of confluence scoring catches, because those strategies genuinely did detect their pattern. Tier 1 solves it directly.

**Pausing entirely on HIGH_VOLATILITY/NEWS.** Standing aside is an underrated output and most systems don't implement it.

**Per-timeframe independent evaluation with disagreement surfaced.** H4 through M1 each hold their own state rather than being collapsed into one verdict.

**Named supporting strategies per signal.** What makes the system debuggable rather than merely trusted.

**Directional pairs are correctly separated** (bullish/bearish FVG, OB, sweeps as distinct modules). Since they can't fire for the same direction simultaneously, this costs nothing and keeps each module simple.

---

## 2. Findings

### 2.1 The MQL5 EA bridge is redundant — and untestable

Unchanged across all four versions, and still the clearest available win.

Orders route **Python → HTTP → MQL5 EA → MT5**, but Python is already connected to that terminal and `MetaTrader5` exposes `order_send()` for market and pending orders alike.

| Cost | Detail |
|---|---|
| Latency | 1–3s polling on every entry — material on M1/M5 scalping signals. |
| Blocking I/O | `WebRequest()` is synchronous; every poll blocks the EA thread. |
| JSON in MQL5 | No native parser. Hand-roll or vendor one, then debug it. |
| **Untestable** | **`WebRequest()` cannot execute in the Strategy Tester** — the entire execution path is invisible to MT5's own tester. |
| Manual config | URL whitelisting on every install. |
| Second codebase | Separate language and toolchain; one more thing each agent session must understand. |

The "runs on a VPS without Python" justification doesn't apply: the `MetaTrader5` package **requires the terminal running on the same Windows machine anyway**. Identical constraints, strictly worse properties.

**Recommendation:** cut from v1. Execute via `mt5.order_send()`. If you later want logic surviving a Python crash, put *local* trailing/breakeven management in an EA — not entry polling.

### 2.2 The 28 modules contain roughly 9 independent signals — and the worst overlaps are cross-category

This is the centerpiece of v4, and having the full module list makes it concrete rather than speculative.

A weighted vote treats each module as separate evidence. Reading the actual definitions, many are the same observation under different names. Working through all 28:

| Cluster | Modules | What it actually detects |
|---|---|---|
| **A · Imbalance** | 1, 2 FVG · 10 Liquidity Void | A low-volume displacement gap being rebalanced. #10's definition *is* #1/2 at larger scale. |
| **B · Zone retest** | 3, 4 Order Block · 9 Breaker · 12 S/R Flip · 13 Supply/Demand | One idea. #9 is literally described as a "flipped support/resistance zone" (= #12); #13 is the non-SMC name for #3/4. |
| **C · Stop hunt & reject** | 5, 6 Liquidity Sweep · 14 Double Top/Bottom · 15 Pinbar · 16 Engulfing | A sweep of equal highs/lows *is* what forms a double top/bottom, and it prints as a pinbar or engulfing candle. Four names, one event. |
| **D₁ · Structure — continuation** | 8 BOS | Trend-confirming break. |
| **D₂ · Structure — reversal** | 7 CHoCH · 11 Quasimodo | QM is a CHoCH with extra shoulder conditions. |
| **E · Trend stack** | 17 Triple EMA · 18 EMA Pullback · 19 MACD · 21 ADX · 22 Supertrend | All five fire together in any clean trend. One observation, five votes. |
| **F · Momentum divergence** | 20 RSI Divergence | Genuinely orthogonal — *counter*-trend, anti-correlated with E. Your most valuable single module. |
| **G · Envelope reversion** | 24 BB Outer · 25 VWAP Deviation · 26 Keltner | Three volatility envelopes measuring the same stretch-from-mean. Touching one means touching the others. |
| **H · Volatility expansion** | 23 BB Squeeze · 27 ATR Expansion · 28 Session ORB | Range contraction resolving into expansion. |

**~9 effective signals from 28 modules.** Cluster B carries five votes for one idea; E carries five; C carries four; G carries three.

Three consequences:

**Your score will read high in strong trends and peak near exhaustion.** Cluster E's five modules fire together, plus BOS (D₁), plus whatever zone retest (B) the trend is pulling back into. That's seven-plus agreeing votes from what a human would call two observations — trend intact, pullback into a zone. The score says overwhelming conviction at exactly the point trend-following is most dangerous.

**Capping by the four pillars will not fix this.** The tightest duplicates cross pillar boundaries: sweep (SMC) ↔ double bottom (Price Action); breaker (SMC) ↔ S/R flip (Price Action); order block (SMC) ↔ supply/demand zone (Price Action); Quasimodo (Price Action) ↔ CHoCH (SMC). A per-pillar cap leaves every one of those pairs double-counting.

**Pillar 4 is internally incoherent as a cap unit.** "Volatility & Mean Reversion" contains both mean-reversion (24, 25, 26) and breakout (23, 27, 28) modules — opposite trades that fire in opposite regimes and essentially never co-occur. Capping their sum does nothing, while the real clusters inside it go unconstrained relative to each other.

**Recommendation:** weight by **cluster**, not by pillar. Assign each cluster a total budget; modules inside a cluster split it. Cluster B's five modules share one cluster's worth of weight, not five. Derive the cluster map empirically — run all 28 over history and build a co-firing matrix — rather than trusting the table above, which is my read of the definitions and a starting hypothesis, not a measurement. That job is small, well-specified, agent-friendly, and it parameterises your entire scoring layer.

Practical upshot: **a signal confirmed by clusters B + E + D₁ is one trade idea. A signal confirmed by clusters C + F + G is three independent ones**, and should outrank it even at a lower raw count.

### 2.3 The scoring formula has two concrete problems

```
Score = Σ(Strategy Score × Weight) / Total Potential Weight
```

**Problem 1 — the denominator is ambiguous, and the answer changes everything.** Is "Total Potential Weight" the sum over all 28 modules, or only over the regime-enabled ones?

If it's all 28, then in TRENDING regime — where Tier 1 has disabled the mean-reversion modules — their weight sits in the denominator with no possibility of contributing to the numerator. Your maximum achievable score drops below 100, by a different amount in every regime. A threshold of 94 might be reachable in one regime and mathematically impossible in another, and nothing in the system would tell you. **The denominator must be the enabled set**, recomputed per regime, or scores aren't comparable across regimes and your threshold silently means different things at different times.

**Problem 2 — a weighted average measures agreement *quality*, not *breadth*, and the two are being conflated.** Part 2 of your spec gates on "three or more strategies agree," then computes an average. But an average doesn't reward breadth: if the current average is 90 and a fourth strategy fires at 85, the score *falls* to 88.75. More confirmation, lower score. That directly contradicts the stated intent that more agreement means higher conviction.

You have two separate quantities and one number trying to carry both:

- **Breadth** — how many independent clusters agree (§2.2). This is the conviction signal.
- **Quality** — how strong those confirmations are individually. This is the average.

**Recommendation:** make the score explicitly multiplicative and readable:

```
breadth  = independent clusters agreeing / clusters available in this regime
quality  = Σ(score × weight) / Σ(weight)        # enabled + firing only
Score    = 100 × breadth^α × (quality/100)
```

Whatever form you choose, keep both terms visible in the UI. "82 — 4 of 6 clusters, avg strength 91" tells you something. "82" alone doesn't, and you'll want the breakdown the first time a 95 loses.

### 2.4 Tier 1 is now a single point of failure, and three things are undefined

Because the classifier gates everything downstream, a misclassification doesn't degrade the output — it inverts which strategies are allowed to speak. Three gaps:

**No hysteresis.** ADX oscillating around 25 flips TRENDING ↔ RANGING every few bars, and each flip swaps which half of your library is enabled. Signals will appear and vanish. Require N consecutive confirming bars, or use asymmetric thresholds (enter TRENDING at ADX > 27, exit below 22).

**No transition behaviour for open positions.** You hold a long entered under TRENDING; regime flips to RANGING and the strategies that justified it are now disabled. Hold to target, tighten the stop, or exit? Same question for pending orders — a BUY_LIMIT justified by a trend is not justified once the trend is gone, and my instinct is those should be cancelled on regime change. Currently undefined, and it's the gap most likely to cost real money.

**No stated regime for the classifier's own timeframe.** See §2.5.

Also worth adding: a **UNCERTAIN / TRANSITIONAL** state between the three. Forcing every bar into TRENDING, RANGING or VOLATILE means borderline conditions get a confident label they don't deserve. An explicit "no strong regime → reduce size or stand aside" is cheap and honest.

### 2.5 At which timeframe is the regime classified?

This falls straight out of combining Tier 1 with the H4→M1 analyzer, and the spec doesn't answer it.

If regime is classified **globally**, on what timeframe? An H4 uptrend routinely contains ranging M15 and choppy M1. Gate M1 signals on H4's TRENDING and you'll enable trend strategies into intraday chop.

If regime is classified **per timeframe**, then M1 can be RANGING while H4 is TRENDING — coherent, but now you have five regimes at once and need to say how they interact with the MTF score. Does an M15 signal need M15's regime, H4's, or both?

**Recommendation:** classify per timeframe, and use the higher timeframe's regime as a *bias filter* rather than a hard gate on lower ones. Concretely: a module must pass its own timeframe's regime gate, and signals opposing the H4 regime get a weight penalty rather than a veto. That keeps counter-trend scalps available at reduced conviction instead of banning them outright — which matters, because cluster F (RSI divergence) is your most orthogonal signal and it's inherently counter-trend.

### 2.6 Compute budget

Tier 1 helps — disabled modules skip evaluation — but you still run the enabled set across 5 timeframes × N pairs, every bar, for the scanner's cross-pair ranking.

- **Evaluate on bar close, not on tick.** Every module in the list changes state only on bar close. The spec says "every candle tick"; if that means literal ticks it's the single largest waste in the system.
- Cache per (symbol, timeframe, bar) — the scanner and the analyzer request identical evaluations.
- The GIL gives concurrency without parallelism on CPU-bound math. `ProcessPoolExecutor` for modules, `asyncio` for MT5 I/O.
- Budget: *full watchlist scan under 2 seconds*, asserted in a test. Retrofitting performance across 28 modules costs far more than designing to a number.

### 2.7 LLM rationale: non-blocking, non-scoring

**Never let it feed the score** — one-way data flow, enforced in code. **Generate asynchronously**, after the card renders.

With the cluster model there's a natural job for it: narrate *which clusters* agreed and what that combination means, from pre-computed facts. Have it describe, not evaluate — models are fluent and unreliable on raw numeric market data and will state confabulated levels confidently. Build against one provider behind a thin interface; the Settings Hub's five can wait.

---

## 3. Requirements missing from the spec

**Execution safety.** Kill switch (halt generation, cancel all pending on your magic number, optionally flatten) in one click, plus a standalone script that works when the UI is down — before the first live order. Idempotency keys so a retry or restart can't double a position. Startup reconciliation against the broker's actual state. SQLite persistence of every signal, regime, cluster breakdown, decision and broker response.

**Portfolio guards.** Daily loss cap → halt. Max concurrent open risk. **Correlation limits** — XAUUSD, EURUSD and GBPUSD longs are largely one USD-short bet, and a cross-pair scanner hunting simultaneous setups makes this *more* likely. It's §2.2's independence error one level up: correlated instruments, same as correlated strategies. Spread guard. News blackout — which should also drive Tier 1's VOLATILE_NEWS state from an actual calendar feed, not just ATR.

**Broker reality.** `SYMBOL_TRADE_STOPS_LEVEL`. Freeze level. Lot rounding to `VOLUME_MIN`/`_MAX`/`_STEP` — your formula yields `0.0374`, the broker wants `0.04`. Symbol suffixes resolved at startup. Digits — 5- vs 4-digit pricing makes the lot formula wrong by 10× if assumed. `SYMBOL_TRADE_TICK_VALUE` for non-USD accounts. Contract size for metals. Requote, slippage and partial-fill return codes.

**Time handling.** MT5 server time ≠ UTC ≠ local, and the server's DST schedule may not match yours. Module 28 (Session ORB) and Tier 1's session logic depend on this and fail *silently* when wrong — your London breakout fires at the wrong hour and you blame the strategy. UTC internally, pin the offset explicitly, test across a DST transition.

**Security.** `127.0.0.1:8000` with no auth is reachable by any local process. Bearer token plus CORS locked to your origin — ten minutes.

---

## 4. Execution plan — by dependency, not duration

Ordered by what blocks what, with parallelism width and relative cost.

### Stage 0 — Contracts & harness · `blocks everything` · `1 agent + you` · `low cost`

MT5 connector with full symbol metadata. Historical store. **Frozen Pydantic contracts**: `Candle`, `Regime`, `StrategyResult`, `TimeframeState`, `Signal`, `OrderIntent`, `ExecutionReceipt`. **The `Strategy` base interface** — highest-consequence file in the repo; all 28 implement it, and changing it later means re-running every module. Bar-close replay engine. Fixtures spanning trending, ranging and high-volatility periods.

*Gate:* a trivial strategy runs end-to-end over history and produces a metrics report.

### Stage 1 — Tier 1 classifier & Tier 3 scoring · `blocks Stage 3` · `you, by hand` · `low cost, high judgment`

The regime classifier with explicit thresholds and hysteresis (§2.4), the regime→module enable map, the per-timeframe regime policy (§2.5), and the scoring function with its breadth/quality split (§2.3). Small code, large consequence, encodes judgment agents will confidently fake.

*Gate:* replay a year and eyeball the regime timeline against the chart. Do the labels match what you see? Does it flap at boundaries?

### Stage 2 — The 28 modules · `blocked by Stage 0` · `up to 28 parallel agents` · `highest total cost`

Where the parallelism pays, and the reason for freezing the interface first. Each module is independent and well-specified: *implement module N against the `Strategy` interface, with golden-file tests against the fixtures.* Your numbered list is already close to 28 ready-made agent prompts.

Sequence by pillar so partial completion is useful: **SMC/ICT (10) → Trend & Momentum (6) → Price Action & Pivots (6) → Volatility & Mean Reversion (6).**

Then one cheap, high-value task: **the co-firing matrix** (§2.2). Run all 28 over history, output the empirical clusters, and use it to replace the hypothesised cluster table with a measured one.

*Gate per module:* deterministic output on fixtures, plus a visual check that detections land where you'd draw them by hand.

### Stage 3 — Pipeline assembly · `blocked by 1 + 2` · `1–2 agents` · `medium cost`

Wire Tier 1 → Tier 2 → Tier 3 across H4/M1. Cross-pair scanner with ranking and the confidence/new-pairs filters. Opportunity Radar with take/too-late validity. Compute budget asserted.

*Gate:* full pipeline over replayed history within budget, with per-cluster breakdown inspectable on every signal.

### Stage 4 — API & UI · `blocked by 3` · `parallel by view` · `medium cost`

FastAPI (token-authed) plus React. Freeze the endpoint schema first, then fan out. By dependency of use: **Chart + Signal Bar → Smart Analyzer → Strategy Scanner → Opportunity Radar → Journal → Strategy Lab → Pattern Workspace → Backtester → Risk Calculator → Settings.**

### Stage 5 — Execution · `blocked by 4` · `1 agent, hand-reviewed` · `low cost, high consequence`

`mt5.order_send()`, lot sizing with the full broker-constraint set, portfolio guards, kill switch, idempotency, reconciliation. Small surface, all the financial risk — read every line yourself.

### Stage 6 — Unblocked, freely parallel

LLM rationale (async, non-scoring) · pattern expansion · desktop packaging · auto-updater · MQL5 EA if a concrete need emerges. **Auto-execution last**, behind a per-symbol toggle and a daily loss cap.

---

## 5. Working with parallel AI agents

**Merge the 3-tier spec and module list into the md file first.** Agents read that file. Right now the architectural core isn't in it, and every session will re-derive or invent Tier 1.

**Freeze contracts before fanning out.** The biggest credit sink in a project this shape is 28 agents producing subtly incompatible modules against a drifting interface, then paying again to reconcile.

**Write `CLAUDE.md` at the repo root** with non-negotiables as flat rules: *"Modules are pure functions of a bar window — no I/O, no global state." "A module never reads the regime; Tier 1 gates it externally." "All times UTC internally." "Never place an order without an idempotency key." "Never connect to a live account in a test."*

That second rule matters structurally: keeping modules regime-unaware means Tier 1 stays swappable and modules stay independently testable. If modules start checking regime internally, you've smeared Tier 1 across 28 files.

**Fixtures are a throughput tool, not just a safety one.** With deterministic replay an agent writes a module, runs it, sees output, self-corrects — inside one session. Without them it produces plausible code neither of you can evaluate, and you pay again next pass.

**Batch by pillar.** Agents working within one pillar share conceptual context, so batched prompts cost less per module than random assignment.

**One module per session, under ~300 lines changed.** Commit at each green run.

**Guard the live account in code** — a module-level check that raises unless the account is demo, overridable only by an environment variable you set deliberately.

---

## 6. Smaller recommendations

**Skip the desktop wrapper and auto-updater for now.** Tauri/Electron packaging plus a GitHub Releases pipeline is real work for a system with one user who has the repo locally. Serve React from FastAPI, open `localhost:8000`, use Chrome's "Install as app" for a windowed experience at zero cost.

**Fix the spec document.** The ASCII diagram is collapsed to one unreadable line (needs a fenced code block). Section 3 has lost all line breaks. The lot formula uses `$$...$$` LaTeX that won't render in most viewers, and is dimensionally incomplete — it needs the point-value-per-lot term and must round to `SYMBOL_VOLUME_STEP`, or it produces unfillable volumes.

**Reconcile the two category schemes.** The md file's §2 lists six categories (including Breakout and Pattern Engine); the module breakdown uses four pillars with breakout folded into Volatility. Pick one, since the strategy list and the Strategy Lab UI both key off it.

**lightweight-charts attribution.** Apache-2.0 and free, but the licence requires the TradingView logo/link stay visible.

**Log rejected signals and their outcomes.** Over time this is the one measurement that improves the human in the loop rather than the code.

**Segment results by regime and by cluster breadth.** Two diagnostics that matter most here: does the classifier actually improve outcomes versus running ungated? And do broad-cluster 78s outperform single-cluster 92s? If the second holds — and §2.2 predicts it will — that alone justifies the cluster-weighting work.

---

## 7. Open decisions

1. **Drop the MQL5 EA from v1?** (Recommended: yes — §2.1)
2. **Cluster weighting instead of flat per-module weights?** (Recommended: yes. §2.2 is the highest-value change available.)
3. **Score denominator — enabled set or all 28?** (Recommended: enabled set, or thresholds mean different things per regime. §2.3)
4. **Split the score into breadth × quality?** (Recommended: yes, and show both. §2.3)
5. **Regime classified per timeframe or globally?** (Recommended: per timeframe, with HTF as weight penalty not hard veto. §2.5)
6. **Hysteresis parameters** for regime transitions, and whether to add an UNCERTAIN state. (§2.4)
7. **Open-position policy on regime change** — hold, tighten, or exit? And cancel pending orders? (§2.4 — the most expensive gap remaining.)
8. **Starting symbol set** — the scanner is built for many; start with two or three you know well.
9. **Broker/demo account**, pinned before sizing logic is written.
10. **Risk parameters** — per-trade, daily cap, max concurrent, in a config that takes a deliberate edit to change.

---

## Closing

With the full pipeline visible, the architecture is better than either of my earlier reads suggested. Tier 1 as a veto layer rather than a router is the right choice, and regime-suppressing mean reversion during trends addresses a failure mode confluence scoring can't reach.

The two findings that matter most are both about the assumption of independence. **§2.2:** the 28 modules are roughly 9 signals, the tightest duplicates cross pillar boundaries, and a flat weighted vote will read maximum conviction in exactly the conditions where trend-following is most dangerous. **§2.3:** the score formula averages when it means to count, so more confirmation can lower the number — and its denominator, read one way, makes your threshold mean something different in every regime.

Both are cheap to fix now and expensive to discover later. Everything else is sequencing, and the sequencing is favourable: one narrow judgment-heavy layer you write yourself, and 28 bounded modules that fan out as wide as your budget allows.

---

**Sources for technical claims:**

- [MQL5 Docs — WebRequest / Network Functions](https://www.mql5.com/en/docs/network/webrequest)
- [MQL5 — Limitations of functions in the tester](https://www.mql5.com/en/book/automation/tester/tester_limitations)
- [MQL5 Docs — order_send / Python Integration](https://www.mql5.com/en/docs/python_metatrader5/mt5ordersend_py)
- [MDTAlpha/DKA SuperChart demo](https://www.youtube.com/watch?v=pJfNxZUM5_Y) — UI surface only; contains no Tier 1 detail
