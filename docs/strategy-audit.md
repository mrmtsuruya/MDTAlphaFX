# Strategy Audit — `src/lib/signal-engine.ts`

Scope: all 31 entries in `IMPLEMENTED_STRATEGIES` and their corresponding `evaluate*` functions, dispatched from `evaluateStrategy` (lines 1502–1577). Verified against public TradingView scripts, published TA literature (Wilder, Bollinger, Carney, Gilmore, Gartley), ICT public teaching material, and open-source references (ta-lib/pandas-ta conventions). No paid/pirated material was consulted.

Verdict legend: **CORRECT** (faithful to the canonical technique) / **SUBTLY WRONG** (a specific, citable deviation that changes what fires) / **OVERSIMPLIFIED** (a legitimate but thin variant, missing a component the technique normally requires) / **OUTDATED** (uses a stale convention, e.g. ignores DST/anchoring) / **PLACEBO** (fires on something materially unrelated to the claimed technique).

---

## Engine-wide issues (read this before the per-strategy list)

1. **Vote independence is not actually enforced.** `scanCandlesForSignal` requires `winningVotes.length >= 2` and `categories.size >= 2` (lines 1718). Several strategies below share the *same underlying trigger condition* (an N-bar high/low break) while sitting in different catalog categories, so the "2 independent categories" gate can be satisfied by what is functionally one signal counted twice. See `donchian_break` / `bos_choch` / `qullamaggie_breakout` and the `atr_expansion` note.
2. **Macro strategies default to full trust with zero empirical validation.** `strategy-weights.ts` (lines 126–131) explicitly treats a strategy that never votes during walk-forward as weight `1.0` ("neutral", not distrusted). Because `computeStrategyWeights` calls `evaluateStrategy(strategyId, window, atr, mode)` with **no macro context** (line 116), `news_reactive` and `ai_confluence` abstain for the entire backtest window every time, so they always get `weight = 1` and are never downweighted no matter how bad they are live. This is a documented, deliberate design choice, but it means these two strategies are running in production at full confidence with no walk-forward evidence behind them.
3. **`BTCUSD` is not in the currency map.** `PAIR_CURRENCIES_ENGINE` (signal-engine.ts:1410–1423) and its server-side twin `PAIR_CURRENCIES` (macro-data.server.ts:49–62) both list 11 FX pairs + XAUUSD only. `pairCurrencies("BTCUSD")` silently falls through to the `?? ["USD", "USD"]` default (line 1426). It happens to produce a plausible result (BTC does trade on USD macro), but it's accidental, not intentional — add an explicit `BTCUSD: ["USD", "USD"]` entry so this isn't relying on a fallback nobody consciously chose.
4. **`ai_confluence` cannot ever fire for BTCUSD.** `COT_MARKETS` in macro-data.server.ts (lines 65–75) has no Bitcoin/crypto entry, so `cotByPair.get("BTCUSD")` is always `undefined` → `cot: null` → `evaluateAiConfluence` returns `null` unconditionally (line 1479 guard) for one of the owner's two primary instruments. This strategy is dead weight for BTCUSD specifically.
5. **`emaSeries` seeds from the first raw price, not an SMA** (line 300: `const result = [values[0]]`). This is a standard, accepted simplification — the seed's influence decays to negligible after ~3–5× the period — and does not materially change any of the strategies below given the warmup lengths in use. Flagged once here so it isn't repeated as a "bug" per-strategy.

---

## 1. `opening_range_breakout` — **OVERSIMPLIFIED**

**Code (939–1031):** Finds the most recent session-open hour rollover (07/12/22/00 UTC) within the last 4 bars, builds a range from the first two candles of that session, and fires when the close clears that range by ≥0.4 ATR.

**What it should do:** This is a legitimate, correctly-anchored ORB (the session-boundary scan by actual hour-rollover, not a fixed bar count, is the *right* way to do this — contrast with `asian_range` below, which gets this wrong). The catalog description promises "range-expansion confirmation" but the code only checks a static 0.4-ATR breakout distance — there's no comparison to recent range/volatility contraction beforehand, so it isn't really confirming an "expansion," just a minimum breakout size.

**Severity:** Weak signals, not false ones. The core mechanic is sound.

**Fix:** Either drop "range-expansion confirmation" from the description, or actually implement it (e.g. require the breakout candle's true range to exceed the average of the last 5–10 candles).

---

## 2. `heiken_ashi_scalp` — **CORRECT**

**Code (1033–1079):** Builds real Heiken Ashi bars using the canonical recursive formula (`HA_close = (O+H+L+C)/4`, `HA_open[i] = (HA_open[i-1]+HA_close[i-1])/2`, bootstrapped correctly from the seed candle), checks three consecutive same-color HA bars plus a small-wick filter, gated by EMA21.

This is one of the best-implemented strategies in the file — the HA recursion is done properly (not just "close > open" on raw candles relabeled as Heiken Ashi, which is a common shortcut/fake seen in public scripts). No issues found.

---

## 3. `qullamaggie_breakout` — **OVERSIMPLIFIED** (arguably mislabeled)

**Code (1081–1124):** EMA50 trend filter + range compression (current 20-bar range ≤ 1.1× the recent 30-bar average range) + close breaking the prior 20-bar high/low + (volume surge OR ≥0.8 ATR breakout distance).

**What the real technique requires:** Kristjan Qullamaggie's public breakout methodology (his own YouTube/Substack write-ups, widely mirrored in retail trading education) is built on a *prior explosive move* (stock up large % over recent weeks, strong relative strength vs. the index) that consolidates into a tight base, then breaks out. The defining precondition — a big prior move / relative strength — is entirely absent here. What's implemented is a generic "tight range + EMA trend + volume breakout" strategy, which is a fine strategy in its own right but is not really "Qullamaggie-style"; it also heavily overlaps with `donchian_break` (see engine-wide note #1 — same `close > prior 20-bar high` core condition).

**Severity:** Not false signals, but the name overpromises a specific edge (leader-stock momentum continuation) that nothing in the code checks for.

**Fix:** Either rename it to what it actually is ("compression breakout with volume confirmation"), or add the missing precondition (e.g. require price to be up some threshold over the last N bars / at a fresh high relative to a longer lookback) to actually match the named technique.

---

## 4. `trendline_break` — **CORRECT**

**Code (1126–1164):** Proper least-squares linear regression over a 24-bar window (correct slope/intercept formula), checks a close crossing back through the regression line after being on the trendline's far side. This is a legitimate, correctly-implemented "statistical trendline break" — a recognized public-domain technique (regression channel breaks are standard in TradingView's built-in Linear Regression Channel and many public scripts). No issues.

---

## 5. `fib_retracement` — **CORRECT**

**Code (1166–1196):** 60-bar swing high/low, 0.5–0.618 retracement zone ("golden pocket" adjacent), requires a rejection close back through the 0.5 or 0.618 level. Textbook Fibonacci retracement-zone entry. No issues.

---

## 6. `ny_killzone` — **OUTDATED**

**Code (1198–1221):** Fires only when `hourUtc` is in `[12, 15)`, then votes on simple momentum vs. a ~24-bar-back reference "open."

**What's wrong:** The window is hardcoded in UTC and never adjusts for US Daylight Saving Time. The commonly cited ICT "New York Kill Zone" (7–10am NY local time, pre/around the NY equities open) maps to 12:00–15:00 UTC only during EST (roughly early-Nov to mid-Mar). For the ~8 months of the year the US observes DST (EDT, UTC-4), the same NY-local window is actually **11:00–14:00 UTC** — the code's window is systematically one hour late for most of the year.

Secondary, smaller issue: "session open" is approximated as `candles.slice(-24, -1)[0]`, i.e. a fixed 24-bar lookback rather than an actual UTC-hour-anchored open (contrast with `opening_range_breakout`, which correctly scans for the real hour rollover). On a scalp timeframe this reference point drifts depending on where in the 3-hour window the bar sits.

**Severity:** False signals in the sense that for 8 months of the year this strategy is evaluating the wrong hour of the day and calling it "New York Kill Zone" momentum — the label is wrong even when the underlying momentum check is directionally reasonable.

**Fix:** Compute the DST-adjusted NY-local hour (or just accept the ICT convention of publishing kill zones in UTC directly and pick a fixed, DST-agnostic UTC band with a comment acknowledging the tradeoff) rather than silently treating standard time as always in effect. Anchor "session open" to the actual `hourUtc === 12` rollover the way `opening_range_breakout` does.

---

## 7. `asian_range` — **SUBTLY WRONG**

**Code (1223–1253):** Guards to before-London-open (`hourUtc < 7`), then takes `candles.slice(-12)` and filters to the 22:00–07:00 UTC block for the range high/low.

**What's wrong:** `slice(-12)` grabs the last 12 candles *of whatever timeframe is active*, not 12 hours. `asian_range`'s declared valid timeframes are `SCALP_TIMEFRAMES` (M1/M5/M15/M30) plus H1 (line 144–148). The actual Asian block is ~9 hours (22:00–07:00 UTC). On M5, the last 12 candles cover only **1 hour** of data — the code computes a "session range" from roughly the last hour of price action, not the session. On M15 it's 3 hours; on M30 it's 6 hours. Only on H1 does 12 candles actually approximate the full session. This directly contradicts the catalog description ("Break of the Asian-session range... on the London open") on every timeframe except H1.

Compare this to `opening_range_breakout` in the same file, which correctly scans backward for the actual hour-rollover boundary regardless of timeframe — the more correct pattern already exists elsewhere in this codebase and wasn't reused here.

**Severity:** False signals. A "session range" that's really just the last 1–6 hours of noise is a materially different (and much more easily broken) level than the true Asian session extremes, so this strategy will fire "session breakouts" that aren't breaking anything session-related.

**Fix:** Replace the fixed `slice(-12)` with the same hour-rollover scan `opening_range_breakout` already uses, so the lookback window scales to always capture the true 22:00→07:00 block regardless of chart timeframe.

---

## 8. `ema_trend` — **CORRECT**

**Code (374–394):** Close and EMA21 both above/below EMA55, EMA21 rising/falling vs. 4 bars ago, minimum ATR-normalized separation to avoid a flat/noisy cross. Standard, well-implemented moving-average trend filter. No issues.

---

## 9. `supertrend` — **CORRECT**

**Code (396–466):** This is a faithful reimplementation of the standard SuperTrend algorithm (basic bands from `HL2 ± multiplier×ATR`, final-band trailing logic identical to the public formula, direction flip on a close crossing the active band). Matches the canonical algorithm almost line-for-line. No issues.

---

## 10. `ma_ribbon` — **CORRECT**

**Code (468–494):** EMA 8/13/21/34 ribbon (a recognized Fibonacci-period EMA ribbon set used in public "EMA Ribbon" scripts), requires strict ordering plus expanding spread vs. 3 bars ago. Legitimate, coherently implemented. No issues.

---

## 11. `ichimoku` — **SUBTLY WRONG** (the exact failure mode you flagged)

**Code (496–530):**
```
const tenkan = midpoint(9);
const kijun = midpoint(26);
const spanA = (tenkan + kijun) / 2;
const spanB = midpoint(52);
const latest = candles.at(-1)!.close;
...
if (latest > cloudTop && tenkan > kijun && latest > chikouReference) { ... }
```

**What's wrong:** Canonical Ichimoku Kinko Hyo plots Senkou Span A/B **26 periods forward** — the cloud visible "at" today's bar is built from Tenkan/Kijun/52-bar-high-low computed **as of 26 bars ago**, not from today's data. Every public reference (Ichimoku's own methodology, TradingView's built-in Ichimoku Cloud) applies this displacement. The code computes `spanA`/`spanB` from the *current* 9/26/52-bar windows and compares *today's* price against that — i.e. it implements a cloud with zero displacement. This isn't a cosmetic difference: the entire predictive/lagging-support-resistance property of the Kumo comes from the fact that today's price interacts with a cloud calculated on 26-bar-old data. A no-displacement cloud tracks price far more tightly, so "price outside the cloud" fires much more easily and at different moments than the real indicator would ever show — the strategy is voting off a cloud that doesn't exist on any real Ichimoku chart.

The Chikou-span check (`chikouReference = candles.at(-27)!.close`, i.e. close 26 bars back) is correctly indexed and is a reasonable close-only simplification of the Chikou confirmation rule.

**Severity:** False signals. This will disagree with what any real Ichimoku chart is showing at the same moment, on both timeframes it's enabled for (H1, H4).

**Fix:** Compute `spanA`/`spanB` from data as of `candles.length - 1 - 26` (i.e., using the 9/26/52-bar windows anchored 26 bars in the past), then compare against the current close — that reconstructs what the actual displaced cloud looks like at the current bar. Concretely: run the `midpoint()` helper against `candles.slice(0, candles.length - 26)` (or equivalent) rather than the full series.

---

## 12. `rsi_momo` — **CORRECT** (thin but honest)

**Code (532–549):** RSI14 > 55 with a rising close = long; < 45 with a falling close = short. This isn't a single "canonical" RSI signal (classic Wilder RSI uses 70/30 overbought/oversold, some use a 50 centerline cross), but "RSI trending with price, using a buffer around the centerline" is a recognized, commonly-taught variant and the code does exactly what its description says. No deception here.

---

## 13. `macd_hist` — **CORRECT**

**Code (551–577):** Standard 12/26/9 EMA MACD, histogram = MACD − signal, requires the histogram to be positive/negative and non-decreasing/non-increasing. Textbook MACD histogram momentum confirmation. No issues.

---

## 14. `stoch_rsi` — **OVERSIMPLIFIED**

**Code (579–613):** Computes `%K = (RSI − min(RSI,14)) / (max(RSI,14) − min(RSI,14)) × 100` correctly (matches Chande/Kroll's original StochRSI formula), and fires on a cross out of an oversold/overbought zone.

**What's missing:** Canonical StochRSI (and every public TradingView/ta-lib implementation) smooths `%K` with a short SMA (commonly 3) before use, and typically also plots a `%D` signal line (SMA of smoothed %K) for the actual cross signal. The code uses the raw, unsmoothed %K directly. This makes it noisier/twitchier than the indicator traders are actually looking at when they see "Stochastic RSI" on a chart.

**Severity:** Weak signals (more whipsaw-prone), not fake ones — the core formula is right.

**Fix:** Add a 3-period SMA smoothing pass on the %K series before testing the oversold/overbought cross.

---

## 15. `cci_extreme` — **CORRECT**

**Code (615–642):** `CCI = (typicalPrice − SMA20(typicalPrice)) / (0.015 × meanAbsoluteDeviation)` — this is Donald Lambert's original CCI formula, constant included, exactly as implemented in ta-lib/pandas-ta. Recovery-from-extreme logic (cross back through ±100) is a standard CCI mean-reversion signal. No issues.

---

## 16. `bollinger_squeeze` — **CORRECT**

**Code (644–683):** Bollinger Bands = SMA20 ± 2σ; bandwidth = `4σ/mean` (the standard Bollinger %B/Bandwidth normalization); squeeze = bandwidth in the bottom quartile of the last 40 readings; fires on a band break with a minimum true-range confirmation. This correctly implements John Bollinger's own "squeeze precedes expansion" concept. No issues.

---

## 17. `keltner_break` — **CORRECT**

**Code (685–709):** EMA20 ± 1.5×ATR channel, break-and-hold logic. The 1.5× multiplier is on the tighter end of common Keltner configurations (2× is the more frequently cited default), but 1.5–2.5× is within normal published range for this indicator — a threshold choice, not an error. No issues.

---

## 18. `donchian_break` — **CORRECT, but see engine-wide note #1**

**Code (711–733):** Close crossing the prior 20-bar high/low, excluding the current bar from the window (avoids look-ahead). This is the textbook Donchian Channel breakout. No formula issues — but it is functionally near-identical to `bos_choch` and is the base condition inside `qullamaggie_breakout`; see the duplication discussion below.

---

## 19. `atr_expansion` — **PLACEBO-adjacent / weakest strategy in the file**

**Code (735–759):** Fires whenever the current bar's true range exceeds 1.25× (or 1.5× on scalps) ATR, voting in the direction of *that single candle's own body*.

**What's wrong:** Every real range-expansion technique in the public literature (Toby Crabel's NR7/Range Expansion Index, the standard "volatility breakout" family) pairs range expansion with a break of an actual prior level — the expansion is a *confirmation filter* on top of a defined structure, never a standalone signal. This code has no reference to any level, trend, or prior structure at all: any sufficiently large candle, in either direction, for any reason (a spike, a wick, a liquidity grab, a news print), becomes a full-strength directional vote. There's no requirement that the range expansion break anything.

**Why this matters for the confluence system specifically:** a large-range candle is very often the *same* candle that triggers `trendline_break`, `bos_choch`, `donchian_break`, or `opening_range_breakout`. Because `atr_expansion` is the sole occupant of the `"volatility"` category, it's an easy way to rubber-stamp the engine's `categories.size >= 2` diversity requirement (line 1718) using a vote that isn't independent of the very breakout it's "confirming" — it's highly likely to fire on the same bar and in the same direction as whichever breakout strategy is already voting, without adding real information.

**Severity:** This produces false "confluence," not just a weak signal — it inflates the appearance of independent agreement.

**Fix:** Either remove it (see priority list), or redesign it to require breaking an actual reference level (e.g., only vote if the range-expansion candle also closes beyond the prior N-bar high/low), turning it into a real Crabel-style range-expansion breakout instead of an unconditional "big candle = vote."

---

## 20. `liquidity_sweep` — **CORRECT** (reasonable ICT variant)

**Code (761–783):** Prior 20-bar high swept (`high > priorHigh`) but closes back inside (`close < priorHigh`) → short; mirror for lows → long. This matches the widely-taught public definition of a liquidity sweep / stop hunt (wick beyond a resting-liquidity level, body closes back inside). It's a simplified variant — no check that the swept level actually represents equal highs/lows (real resting liquidity) rather than an arbitrary rolling extreme, and no minimum wick-size filter — but the core logic is a coherent, correctly-oriented implementation of the concept. **OVERSIMPLIFIED** would also be a fair tag; the mechanism itself is not wrong.

---

## 21. `fvg` — **CORRECT**

**Code (953–977):** Classic 3-candle imbalance test (`candle3.low > candle1.high` for a bullish gap, mirrored for bearish), requires the current bar to have re-entered the gap and closed back through its near edge. This matches the standard public FVG definition (candle 1 and candle 3 don't overlap, the gap is the imbalance) and a reasonable "retest and hold" entry rule. No issues, though it doesn't track whether a given gap has already been consumed by an earlier touch (see `order_block` for the same class of issue).

---

## 22. `order_block` — **OVERSIMPLIFIED**

**Code (785–826):** Scans for the last opposing-color candle before a ≥1.25 ATR displacement candle, defines the zone from that candle's body/wick, and fires when price retests and holds/rejects the zone.

**What's missing relative to stricter ICT definitions:** many public ICT resources require an order block to (a) sweep liquidity before forming, and (b) be "unmitigated" — i.e. this must be the *first* return to the zone since it formed. The code has no state tracking across evaluations, so a zone that's already been retested multiple times will keep re-firing every time price revisits it, which is inconsistent with how order blocks are typically taught (a mitigated block is considered used up). No liquidity-sweep precondition is checked either. The displacement/zone construction itself is a coherent, reasonable variant.

**Severity:** Weak/stale signals over time (repeated firing on an already-mitigated zone), not outright fake ones.

**Fix:** Track which zones have already produced a signal (e.g., by zone index/price) and only fire on the first qualifying retest, and/or require a liquidity sweep in the few bars preceding the block.

---

## 23. `bos_choch` — **SUBTLY WRONG**

**Code (828–853):**
```
const swingHigh = Math.max(...prior.map((candle) => candle.high));
const swingLow = Math.min(...prior.map((candle) => candle.low));
...
if (latest.close > swingHigh && priorClose <= swingHigh) { ... "bos_choch" long ... }
```

**What's wrong, specifically:**
1. **BOS and CHoCH are conflated into one undifferentiated check.** In ICT teaching these are deliberately distinct: a Break of Structure confirms the *existing* trend continuing past a swing point; a Change of Character is the *first* break in the opposite direction of the existing trend, signaling a possible reversal. Telling them apart requires tracking the recent sequence of swing highs/lows (higher-highs/higher-lows vs. lower-highs/lower-lows) to know which regime you're breaking *out of*. This code has no concept of the prevailing structure at all — it just checks "did we close beyond the rolling N-bar extreme," and labels every such event with the same strategy id and the same generic reason string regardless of whether it's actually confirming or reversing the prior trend.
2. **The "swing" isn't a real swing/fractal point.** The harmonic-pattern code elsewhere in this same file (`findSwingPoints`, lines 1264–1297) correctly implements fractal pivot detection with future-bar confirmation. `bos_choch` doesn't reuse it — its "swingHigh"/"swingLow" is just a rolling 21-bar max/min, i.e. a Donchian channel.
3. **Near-duplicate of `donchian_break`.** With the swing/fractal distinction dropped, this strategy's trigger condition (`close > rolling N-bar high`, `close` was below it last bar) is functionally the same event `donchian_break` fires on (`close > rolling 20-bar high`), just with a slightly larger window (21 vs. 20 bars) and an added "first bar only" filter. Because the two live in different catalog categories (`sr`/`breakout` vs. `orderflow`), they can both fire on the same candle and satisfy the engine's "≥2 categories" independence requirement (line 1718) while really being one underlying event counted twice — this is the exact concern flagged in the task brief.

**Severity:** False "confluence" (same failure mode as `atr_expansion`), plus the CHoCH label is actively misleading — nothing in the code distinguishes a reversal signal from a continuation signal, so half of what this strategy claims to detect isn't checked at all.

**Fix:** Reuse `findSwingPoints` to get real fractal swing highs/lows, track the last two swing highs and lows to classify the current structure (uptrend = rising swing lows, downtrend = falling swing highs), and only label an event "CHoCH" when the break is against that established structure and "BOS" when it's with it — emit them as distinguishable outcomes (or split into two strategies) rather than one.

---

## 24. `vwap_mean_rev` — **SUBTLY WRONG** (the exact failure mode you flagged)

**Code (855–885):**
```
const session = candles.slice(-Math.min(candles.length, 96));
...
const vwap = session.reduce((sum, candle, index) => sum + typical[index] * volume[index], 0) / totalVolume;
```

**What's wrong:** This is a **rolling** VWAP over a fixed 96-bar trailing window, not a session-anchored VWAP. True session VWAP resets its cumulative sum at a fixed anchor (session/day open) and never drops old bars within that session — that's precisely what gives it institutional significance (it's the actual volume-weighted average price large participants benchmark fills against for the day). A fixed 96-bar rolling window has no such anchor: it drifts continuously, straddles session boundaries arbitrarily (on M5, 96 bars = 8 hours, which will span parts of two or three different sessions depending on when it's evaluated), and bears no relationship to "today's" volume-weighted price. The catalog description itself is telling — it says "rolling session VWAP," which is a contradiction in terms; the code matches that contradictory description, but not what a trader means by "VWAP mean reversion."

The formula for VWAP given a window (`Σ(typical×volume)/Σvolume`) is itself correct — the problem is purely the choice of window.

**Severity:** False signals for anyone expecting this to trade against the actual session VWAP institutions reference — the "mean" being reverted to isn't the mean anything else in the market is looking at.

**Operational risk on top of this:** the function returns `null` whenever `totalVolume <= 0` (line 860). Spot FX/CFD gold feeds frequently carry zero or synthetic volume; if the candle feed for XAUUSD doesn't populate `volume`, this strategy silently never fires at all, on every timeframe, with no diagnostic signal that it's dead.

**Fix:** Anchor the accumulation to an actual session boundary using the same hour-rollover scan `opening_range_breakout` already implements elsewhere in this file (e.g. reset the cumulative sum at 00:00 UTC, or at the same London/NY/Asia opens used by the killzone strategies), rather than a fixed trailing bar count. Separately, verify the live data feed actually populates `volume` for XAUUSD before relying on this strategy at all.

---

## 25. `sr_confluence` — **OVERSIMPLIFIED**

**Code (887–926):** Buckets the last 60 candles' *close* prices into ATR-sized bins, finds the most-touched bucket, and treats it as a support/resistance level.

**What's missing:** Real horizontal S/R levels are defined by where price *reacted* (wicks, rejections), not just where it closed. Using close-only clustering will miss levels where price repeatedly wicked into a zone and rejected without closing there — arguably the more common S/R signature — while over-weighting long consolidation ranges where price simply closed at similar levels without any real reaction. The clustering/bucketing mechanism itself (rounding to the nearest tolerance-sized bucket and counting) is a legitimate, recognized technique for level detection; it's just fed the wrong input.

**Severity:** Weak signals (misses some real levels, may over-count irrelevant closes), not fake ones.

**Fix:** Cluster on high/low (wick) touches in addition to, or instead of, closes.

---

## 26. `london_killzone` — **OUTDATED** (same class of issue as `ny_killzone`, lower severity)

**Code (928–951):** Fires in `[7, 10)` UTC. The commonly cited ICT London Kill Zone (2:00–5:00am New York time) is usually already expressed directly in UTC/GMT terms (~7:00–10:00) in most public references, and London's own local session doesn't drive the killzone definition the way NY's DST does, so this is less exposed to the DST problem than `ny_killzone`. Still shares the same secondary issue: "session open" is a fixed 24-bar lookback rather than an actual hour-anchored open. No major correctness issue, flagged for consistency with #6.

---

## 27. `gartley` — **CORRECT**

**Code (1312–1323, evaluated via 1348–1402):** `AB = 0.586–0.65 XA` (canonical: 0.618, code brackets it with reasonable tolerance), `BC = 0.382–0.886 AB` (canonical, matches), `CD = 1.272–1.618 BC` (canonical), `D = 0.786 XA` (canonical, exact). This matches H.M. Gartley's structure as popularized by Scott Carney almost exactly, including the correct dual-check (D via XA retracement *and* via CD/BC extension). The underlying swing-point detection (`findSwingPoints`, real fractal pivots with future-bar confirmation, correct X→A→B→C chronological ordering and alternation) is solid engineering. No issues.

---

## 28. `bat_pattern` — **SUBTLY WRONG** (the exact failure mode you flagged)

**Code (1325–1334):**
```
{
  id: "bat_pattern",
  abMin: 0.382, abMax: 0.5,      // correct
  bcMin: 0.382, bcMax: 0.886,    // correct
  cdMin: 1.27,  cdMax: 1.618,    // WRONG — this is Gartley's range
  dRatio: 0.886, dTolerance: 0.06, // correct
}
```

**What's wrong, specifically:** `AB` (0.382–0.5 XA) and `D` (0.886 XA) are both correct for a Bat pattern. But the `CD/BC` extension range (`cdMin`/`cdMax`, checked against `cdActual = |touch − C.price| / bc` at line 1380) is set to **1.27–1.618**, which is the Gartley pattern's CD/BC range. Scott Carney's own Bat pattern specification explicitly requires a BC-projection of **at least 1.618, up to 2.618**, and explicitly states that a 1.27 BC projection is what invalidates a structure as a Bat and instead identifies it as a Gartley. The code has the two patterns' CD/BC bounds swapped/overlapping: any structure whose D lands at the 0.886 XA retracement (correct Bat D) but whose CD/BC ratio is only 1.27–1.618 (i.e. structurally more like a Gartley's C-to-D leg) will still pass the `cdActual` check here and fire as a "Bat," when Carney's own rules say that combination isn't a valid Bat.

Sources agree the ideal Bat BC projections are 1.618 or 2.0, with an upper bound around 2.618 — nowhere near the code's 1.618 ceiling.

**Severity:** False positives specifically on the harmonic timeframes (H1/H4) — this will label a meaningful fraction of structures "Bat" that don't satisfy the pattern's actual CD/BC requirement, since the D-ratio check alone (0.886 XA) isn't sufficient without the correct CD/BC constraint.

**Fix (signal-engine.ts:1330–1331):**
```diff
- cdMin: 1.27,
- cdMax: 1.618,
+ cdMin: 1.618,
+ cdMax: 2.618,
```

---

## 29. `butterfly_pattern` — **CORRECT** (reasonable variant)

**Code (1336–1345):** `AB = 0.75–0.825 XA` (canonical: 0.786, well-bracketed), `BC = 0.382–0.886 AB` (canonical), `CD = 1.618–2.24 BC` (within the range cited by multiple public sources for Butterfly's BC extension), `D = 1.27 XA` (canonical — Gilmore's original butterfly D ratio; the 1.618-XA "extended butterfly" variant some sources also allow simply isn't implemented, which is a legitimate scope choice, not an error). No issues found; the Bat pattern's specific bug does not recur here.

---

## 30. `news_reactive` — **PLACEBO**

**Code (1429–1470):**
```js
function eventWithinWindow(event, windowMinutes) {
  const eventMin = eventMinutesOfDay(event.time);   // parses "HH:MM" only — no date
  const now = new Date();                            // real wall-clock time, not the candle's time
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  let delta = Math.abs(eventMin - nowMin);
  if (delta > 720) delta = 1440 - delta;
  return delta <= windowMinutes;                      // windowMinutes = 480 (8 hours)
}
```

**What's wrong:**
1. `event.time` is matched against `^(\d{1,2}):(\d{2})` — **date is discarded entirely.** The check only compares hour-and-minute-of-day, so an event scheduled for 13:30 tomorrow, 13:30 yesterday, and 13:30 today are all indistinguishable to this function. (In production this is partly masked because the upstream `fetchMacroContext` in `macro-data.server.ts` already date-filters events to a ~25-hour window before handing them to the engine — but `evaluateNewsReactive` doesn't know that and re-implements its own, much weaker, date-blind check on top.)
2. The "imminent" window is **8 hours** (`eventWithinWindow(event, 480)`, line 1456). For a major FX pair or gold (`XAUUSD` maps to `["USD","USD"]`, one of the most event-dense currencies there is — CPI, NFP, PCE, Fed speakers, PMI, retail sales, etc.), there is very frequently a High-impact USD event somewhere within any given 8-hour window on a trading day. This gate is open often enough that it barely filters anything.
3. Once the gate passes, the actual "signal" is just 3-bar price momentum (`closes.at(-1) - closes.at(-4)`) exceeding 0.2 ATR — it does not read the event's actual content (surprise vs. forecast, prior revision, actual directional implication). **Nothing about this strategy analyzes the news; it only checks that news exists nearby and then votes with recent momentum.** That's functionally a duplicate of `atr_expansion`/`rsi_momo`-style momentum, wearing a news-flavored rationale string.

**Severity:** This is the clearest placebo in the file. It doesn't do what it claims (react to news direction); it fires on generic short-term momentum, gated by a condition so loose it's frequently true anyway. It also — per engine-wide note #2 — receives full default trust weight forever, since it never gets exercised (and thus never downweighted) during walk-forward testing.

**Fix:** Either (a) make it date-aware (compare against the candle's own timestamp, not `new Date()`), tighten the window to something genuinely "imminent" (e.g. 15–60 minutes pre/post release), and derive direction from the event's actual surprise (actual vs. forecast/prior) rather than raw momentum — or (b) remove it; a loosely-gated momentum strategy mislabeled as news analysis is worse than an honest momentum strategy, because it inflates confidence ("this vote is confirmed by fundamentals") that isn't real.

---

## 31. `ai_confluence` — **OVERSIMPLIFIED / mislabeled**

**Code (1472–1500):** Reads CFTC COT non-commercial net positioning; requires `|netPct| >= 8%`; votes with net long/short (inverted for JPY pairs); strength boosted if a High-impact catalyst is also nearby.

**What's real about it:** unlike `news_reactive`, this strategy actually reads and acts on real data content (COT net positioning is a genuine, widely-used sentiment/positioning signal — e.g. the "commercials vs. large speculators" extremes many discretionary traders watch). The JPY-inversion and gold-quoting logic (`pair.endsWith("JPY")` special-case, comment on `XAUUSD` quoting gold) is directionally sound reasoning, assuming the upstream COT market mapping is correct.

**What's wrong / overstated:**
1. **Timeframe mismatch.** COT reports are published weekly (Friday, reflecting the prior Tuesday's positions), yet this strategy is enabled on `M15`/`H1`/`H4` (line 261–268) — intraday and even scalp-adjacent timeframes. A once-a-week snapshot of futures positioning has no meaningful information content about what happens in the next few M15 candles; COT is a multi-day-to-multi-week positioning bias tool, not an intraday signal. Voting with it at M15 resolution is a structural mismatch between the data's actual update frequency and the timeframe it's asked to predict.
2. **Misleading name.** There is no AI/ML model here — it's a hardcoded percentage-threshold rule (`Math.abs(cot.netPct) < 8`). Calling it `ai_confluence` implies inference or learned weighting that doesn't exist; it should be named for what it does (e.g. `cot_positioning`).
3. **Dead for one of the owner's two primary instruments.** `COT_MARKETS` (macro-data.server.ts:65–75) has no Bitcoin/crypto entry, so for `BTCUSD` this strategy can never produce a vote — `cot` is always `null` and the function returns `null` at the very first guard (line 1479). Given the owner trades XAUUSD and BTCUSD primarily, this strategy is only ever live for one of those two instruments.
4. Per engine-wide note #2, like `news_reactive` it never gets exercised during walk-forward (no macro context supplied), so it also runs at full default trust with zero backtested track record.

**Severity:** Not fake — real data, coherent direction logic — but misapplied at the wrong timeframe and silently non-functional for BTCUSD, both of which materially matter given the owner's actual instrument mix.

**Fix:** Restrict this strategy to swing timeframes (H4/D1) where a weekly positioning update is actually informative, rename it to reflect that it's a COT-positioning overlay rather than "AI," and add a Bitcoin COT market mapping (or explicitly document that this strategy is FX/gold-only and should be excluded from BTCUSD's enabled strategy list).

---

# Priority-ordered fix list (most improvement to real-world signal quality first)

1. **`ichimoku` — add the missing 26-period forward displacement.** Currently voting off a cloud that doesn't correspond to any real Ichimoku chart; this is the single highest-confidence, most consequential fix (line 496–530).
2. **`bat_pattern` — fix `cdMin`/`cdMax` from `1.27/1.618` to `1.618/2.618`.** One-line fix (signal-engine.ts:1330–1331), currently mislabels a meaningful share of non-Bat structures as Bat patterns.
3. **`vwap_mean_rev` — anchor to a real session boundary instead of a rolling 96-bar window.** Currently reverting price to a number with no institutional meaning; also silently dead on feeds without volume — worth confirming the XAUUSD feed even populates `volume`.
4. **`bos_choch` — de-duplicate from `donchian_break` and actually implement the BOS vs. CHoCH distinction** using the fractal `findSwingPoints` helper that already exists in this file. This is currently the clearest "inflates confluence without adding independent information" case alongside `atr_expansion`.
5. **`atr_expansion` — require it to break an actual level**, or remove it. Currently an unconditional "big candle = vote," which both produces weak standalone signals and artificially pads the engine's category-diversity requirement.
6. **`asian_range` — fix the fixed `slice(-12)` lookback** to scale with timeframe via the hour-rollover scan pattern already used in `opening_range_breakout`. On anything faster than H1 it is currently measuring roughly the last 1–6 hours and calling it "the Asian session."
7. **`news_reactive` — either fix or remove** (see item 8 below); as implemented it's giving false confidence that a vote is "fundamentally confirmed."
8. **`ny_killzone` (and secondarily `london_killzone`) — handle DST** so the UTC window tracks the actual NY-local kill zone hours year-round, not just in winter.
9. **`ai_confluence` — restrict to H4/D1**, rename away from "ai," and add a BTCUSD/crypto COT mapping or explicitly exclude BTCUSD from its enabled-strategy list.
10. **`stoch_rsi` — add the missing %K smoothing** (3-period SMA) for a less noisy, more standard-matching oscillator.
11. **`order_block` — track mitigation state** so a zone doesn't keep re-firing every time price revisits it.
12. **`sr_confluence` — cluster on wick highs/lows, not just closes.**

---

# Recommend REMOVING outright (rather than fixing)

- **`atr_expansion`.** There is no version of "the current candle's range is big" that constitutes an independent trading edge in the public literature without pairing it to an actual level break — every citable source pairs range expansion with a breakout of a defined reference. As implemented, its main practical effect on this engine is to cheaply satisfy the "≥2 categories" independence check alongside whichever real breakout strategy is already firing on the same candle, which actively undermines the confluence system's integrity rather than adding a genuinely separate opinion. If you want to keep the concept, fold it into `donchian_break`/`opening_range_breakout` as a strength multiplier instead of a standalone vote.
- **`news_reactive`, in its current form.** It doesn't analyze news — it's a momentum strategy behind an almost-always-open gate. Keeping it as-is means every signal it contributes carries a "fundamentals-confirmed" rationale string that isn't true. Either invest in the fix described above (real surprise-vs-forecast direction, tight and date-aware imminence window) or remove it; a strategy that actively misrepresents its own basis is worse than having one fewer vote in the pool.

Everything else earns its place in the catalog even where it needs a fix — the remaining issues (`bat_pattern`, `ichimoku`, `vwap_mean_rev`, `bos_choch`, `asian_range`, killzone DST, `ai_confluence`'s timeframe/BTCUSD gaps, `stoch_rsi`, `order_block`, `sr_confluence`) are all concrete, scoped, single-function fixes, not indictments of the underlying technique.
