import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRiskLevels,
  evaluateStrategy,
  getEngineStrategyCapability,
  latestAtr,
  macroConfluenceAdjustment,
  scanCandlesForSignal,
  type SignalEngineCandle,
} from "./signal-engine.ts";
import { ALL_ENGINE_STRATEGY_IDS, computeStrategyWeights } from "./strategy-weights.ts";
import { followabilityForSignal, replaySignalPath } from "./signal-scorer.ts";
import {
  buildLearningReport,
  buildSignalAutopsy,
  computeStrategyLearning,
  trustMultiplier,
  type ResolvedSignalForLearning,
} from "./signal-learning.ts";
import { computeMtfAgreement, evaluateTfDirection, MTF_PLANS } from "./mtf-engine.ts";

function trendCandles(direction: "long" | "short", count = 120): SignalEngineCandle[] {
  const sign = direction === "long" ? 1 : -1;
  const candles = Array.from({ length: count }, (_, index) => {
    const close = 100 + sign * index * 0.04;
    return {
      time: new Date(Date.UTC(2026, 6, 1, 0, index * 5)).toISOString(),
      open: close - sign * 0.04,
      high: close + 0.25,
      low: close - 0.25,
      close,
      complete: true,
      volume: 100 + index,
    };
  });
  const previous = candles.at(-2)!;
  candles[candles.length - 1] =
    direction === "long"
      ? {
          ...candles.at(-1)!,
          open: previous.close,
          low: previous.close - 0.2,
          high: previous.close + 1.8,
          close: previous.close + 1.5,
        }
      : {
          ...candles.at(-1)!,
          open: previous.close,
          low: previous.close - 1.8,
          high: previous.close + 0.2,
          close: previous.close - 1.5,
        };
  return candles;
}

/** YYYY-MM-DD `n` days before now, UTC — for COT reportDate fixtures that must
 *  stay a fixed age relative to whenever the suite actually runs. */
function isoDateDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * COT report date `n` days before the LAST BAR of a fixture, not before the
 * wall clock.
 *
 * The engine now evaluates macro-aware strategies against the bar being
 * scanned rather than `Date.now()` (so a replay of 2023 does not ask whether a
 * release is imminent today). Fixture candles are stamped in the past, so a
 * wall-clock COT date would sit in the FUTURE relative to them and read as a
 * negative age. Deriving it from the candles keeps each fixture internally
 * coherent and makes these tests deterministic regardless of when they run.
 */
function cotDateForCandles(candles: { time: string }[], daysAgo: number): string {
  const lastBar = Date.parse(candles.at(-1)!.time);
  return new Date(lastBar - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// A clean uptrend that ends on an extended, red pullback candle. Slow trend
// readers (ema_trend) still see the broader move as long, while fast /
// extension-driven strategies (macd_hist, vwap_mean_rev, trendline_break)
// flip short on that one bar. This is the only way to get REAL, independently
// -evaluated opposing votes out of the strategy catalog on a single candle
// series, which BUG D's tests need (DIRECTION_MARGIN is exercised through
// scanCandlesForSignal / evaluateTfDirection, not a synthetic vote list).
function pullbackFromHighCandles(pullbackSize: number, count = 120): SignalEngineCandle[] {
  const candles = trendCandles("long", count);
  const previous = candles.at(-2)!;
  candles[candles.length - 1] = {
    ...candles.at(-1)!,
    open: previous.close + pullbackSize * 0.6,
    high: previous.close + pullbackSize * 0.65,
    low: previous.close - pullbackSize * 0.3,
    close: previous.close - pullbackSize * 0.1,
    volume: 400,
  };
  return candles;
}

test("a signal requires real, agreeing strategy votes from independent categories", () => {
  const candles = trendCandles("long");
  const latest = candles.at(-1)!;
  const result = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "scalper",
    quote: {
      bid: latest.close - 0.0001,
      ask: latest.close + 0.0001,
      mid: latest.close,
    },
    candles,
    enabledStrategyIds: ["ema_trend", "atr_expansion"],
  });

  assert.ok(result.signal);
  assert.equal(result.signal.direction, "long");
  assert.equal(result.signal.entry, latest.close + 0.0001);
  assert.deepEqual(result.signal.contributingStrategies.sort(), ["atr_expansion", "ema_trend"]);
  assert.ok(result.signal.stopLoss < result.signal.entry);
  assert.ok(result.signal.takeProfit1 > result.signal.entry);
  assert.ok(result.signal.takeProfit2 > result.signal.takeProfit1);
});

test("one indicator can never masquerade as confluence", () => {
  const candles = trendCandles("long");
  const latest = candles.at(-1)!;
  const result = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "scalper",
    quote: {
      bid: latest.close - 0.0001,
      ask: latest.close + 0.0001,
      mid: latest.close,
    },
    candles,
    enabledStrategyIds: ["ema_trend"],
  });

  assert.equal(result.signal, null);
  assert.match(result.diagnostics.reason, /independent strategy votes/i);
});

test("bearish confluence uses the executable bid and produces correctly ordered levels", () => {
  const candles = trendCandles("short");
  const latest = candles.at(-1)!;
  const result = scanCandlesForSignal({
    pair: "XAUUSD",
    mode: "scalper",
    quote: {
      bid: latest.close - 0.1,
      ask: latest.close + 0.1,
      mid: latest.close,
    },
    candles,
    enabledStrategyIds: ["ema_trend", "atr_expansion"],
  });

  assert.ok(result.signal);
  assert.equal(result.signal.direction, "short");
  assert.equal(result.signal.entry, Number((latest.close - 0.1).toFixed(3)));
  assert.ok(result.signal.stopLoss > result.signal.entry);
  assert.ok(result.signal.takeProfit1 < result.signal.entry);
  assert.ok(result.signal.takeProfit2 < result.signal.takeProfit1);
});

test("incompatible and unknown strategies are never evaluated", () => {
  const candles = trendCandles("long");
  const latest = candles.at(-1)!;
  const result = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "scalper",
    quote: {
      bid: latest.close - 0.0001,
      ask: latest.close + 0.0001,
      mid: latest.close,
    },
    candles,
    enabledStrategyIds: ["ma_ribbon", "gartley", "ema_trend", "atr_expansion", "phantom_strategy"],
  });

  assert.ok(result.signal);
  // ma_ribbon and gartley are H1+ strategies — incompatible on an M5 scalper
  // scan; phantom_strategy is not implemented at all (catalog-only).
  assert.deepEqual(result.diagnostics.incompatibleStrategyIds.sort(), ["gartley", "ma_ribbon"]);
  assert.deepEqual(result.diagnostics.catalogOnlyStrategyIds, ["phantom_strategy"]);
  assert.deepEqual(result.diagnostics.evaluatedStrategyIds, ["ema_trend", "atr_expansion"]);
});

test("short risk uses executable bid and respects recent structure", () => {
  const candles = trendCandles("short");
  const levels = buildRiskLevels({
    pair: "XAUUSD",
    mode: "scalper",
    direction: "short",
    quote: { bid: 2652.84, ask: 2653.12, mid: 2652.98 },
    candles: candles.map((candle, index) => ({
      ...candle,
      open: 2658 - index * 0.02,
      high: index === candles.length - 4 ? 2661 : 2658.4 - index * 0.02,
      low: 2657.6 - index * 0.02,
      close: 2658 - index * 0.02,
    })),
    atr: 3.183411,
  });

  assert.equal(levels.entry, 2652.84);
  assert.ok(levels.stopLoss > 2661);
  assert.ok(levels.riskDistance > 8);
  assert.ok(levels.riskDistance > 3.183411 * 1.2);
  assert.equal(
    Number(((levels.entry - levels.takeProfit1) / levels.riskDistance).toFixed(2)),
    1.25,
  );
  assert.equal(Number(((levels.entry - levels.takeProfit2) / levels.riskDistance).toFixed(2)), 2);
});

test("every catalog strategy now has an engine evaluator (no more CATALOG_ONLY)", () => {
  // The full 28-strategy catalog — all must be implemented.
  const catalog = [
    "ema_trend",
    "ichimoku",
    "supertrend",
    "ma_ribbon",
    "rsi_momo",
    "macd_hist",
    "stoch_rsi",
    "cci_extreme",
    "bollinger_squeeze",
    "keltner_break",
    "donchian_break",
    "atr_expansion",
    "vwap_mean_rev",
    "order_block",
    "fvg",
    "liquidity_sweep",
    "bos_choch",
    "sr_confluence",
    "fib_retracement",
    "trendline_break",
    "gartley",
    "bat_pattern",
    "butterfly_pattern",
    "london_killzone",
    "ny_killzone",
    "asian_range",
    "news_reactive",
    "ai_confluence",
  ];
  for (const id of catalog) {
    assert.equal(getEngineStrategyCapability(id).implemented, true, `${id} should be engine-ready`);
  }
  assert.deepEqual(getEngineStrategyCapability("keltner_break"), {
    implemented: true,
    timeframes: ["M5", "M15", "M30", "H1", "H4"],
    description: "Close crossing the EMA20 ± 1.5 ATR Keltner channel.",
  });
  assert.deepEqual(getEngineStrategyCapability("gartley"), {
    implemented: true,
    timeframes: ["H1", "H4"],
    description:
      "Ratio-validated Gartley (D at 0.786 of XA): pullback to the potential reversal zone with a rejection close.",
  });
});

test("scalper mode sizes risk tighter than intraday on identical market data", () => {
  const candles = trendCandles("long");
  const latest = candles.at(-1)!;
  const quote = { bid: latest.close - 0.0001, ask: latest.close + 0.0001, mid: latest.close };
  const scalper = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "scalper",
    quote,
    candles,
    enabledStrategyIds: ["ema_trend", "atr_expansion", "heiken_ashi_scalp"],
  });
  const intraday = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "intraday",
    quote,
    candles,
    enabledStrategyIds: ["ema_trend", "atr_expansion", "qullamaggie_breakout"],
  });
  // Both modes produce a signal on the clean synthetic trend; scalper risk
  // distance must be at most intraday's (1.6 ATR floor vs 1.8 ATR floor).
  assert.ok(scalper.signal);
  assert.ok(intraday.signal);
  assert.ok(scalper.signal.risk.volatilityFloor < intraday.signal.risk.volatilityFloor);
});

// ---------------------------------------------------------------------------
// BUG D: direction is decided by summed weighted STRENGTH, not raw vote
// count — an exact tie must hold no signal (never default long), and a
// strength-dominant minority of votes must beat a weaker majority.
// ---------------------------------------------------------------------------

// Regime shift (documented, not a regression): this fixture used to be an
// EXACT tie in weighted strength — ema_trend(78, trend) + ai_confluence(~59,
// ai) on the long side landed within a couple of points of
// vwap_mean_rev(75, mean_reversion) + trendline_break(62, sr) on the short
// side (137 vs 137) — which produced no signal. The underlying 119-bar
// series is a clean, strong uptrend: readRegime now classifies it
// strong_trend/long, which is exactly the case regime weighting exists to
// correct — a mean-reversion short and an sr short fading an established
// uptrend should not carry the same weight as a trend vote riding it.
// strong_trend boosts trend (x1.20) and holds ai flat (x1.00) on the long
// side while damping mean_reversion (x0.65) and sr (x0.90) on the short
// side: long 93.6 + 59 = 152.6 vs short 48.75 + 55.8 = 104.55, a 59.4% share
// that now clears the 58% DIRECTION_MARGIN. The pure tie-resolution case
// (exact tie -> neutral, never a default long) stays covered independently
// by "evaluateTfDirection (BUG D)" below, which does not apply regime
// weighting.
test("scanCandlesForSignal (regime): the old exact tie now resolves long, because the underlying series is a strong uptrend", () => {
  const candles = pullbackFromHighCandles(0.7);
  const latest = candles.at(-1)!;
  const macro = {
    events: [],
    cot: { net: 5000, netPct: 8, reportDate: cotDateForCandles(candles, 0) },
  };
  const result = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "intraday",
    timeframe: "M15",
    quote: { bid: latest.close - 0.0001, ask: latest.close + 0.0001, mid: latest.close },
    candles,
    enabledStrategyIds: ["ema_trend", "ai_confluence", "vwap_mean_rev", "trendline_break"],
    macro,
  });
  assert.ok(result.signal, `expected a long signal, got null: ${result.diagnostics.reason}`);
  assert.equal(result.signal!.direction, "long");
  assert.equal(result.signal!.regime?.regime, "strong_trend");
  assert.equal(result.signal!.regime?.trendDirection, "long");
  const longStrength = result.diagnostics.votes
    .filter((v) => v.direction === "long")
    .reduce((sum, v) => sum + v.strength, 0);
  const shortStrength = result.diagnostics.votes
    .filter((v) => v.direction === "short")
    .reduce((sum, v) => sum + v.strength, 0);
  assert.equal(result.diagnostics.votes.length, 4, "expected exactly 2 long + 2 short votes");
  assert.ok(
    longStrength > shortStrength,
    `expected regime to tip long ahead of the old tie, got long=${longStrength} short=${shortStrength}`,
  );
});

// Regime shift (documented, not a regression): count-vs-strength still works
// exactly as BUG D fixed it — short's 2 votes still out-total long's 3 in
// weighted strength (103.65 vs 93.2) — but this series is the same clean,
// strong uptrend as the tie fixture above, so strong_trend now ALSO boosts
// the long side's trend category (x1.20) and damps the short side's
// mean_reversion (x0.65) and sr (x0.90) categories. Short's SHARE of total
// weighted strength drops from 62.5% (trust downweighting alone) to 52.7%
// (trust + regime), which no longer clears the 58% DIRECTION_MARGIN. This is
// the feature working as designed: a mean-reversion/sr short fading a strong
// uptrend is damped, which here is enough to cost it a signal it used to win
// outright — count still doesn't decide direction, but neither side has
// enough conviction to trade.
test("scanCandlesForSignal (BUG D / regime): 2 shorts still outweigh 3 longs by strength, but regime damping now costs them the DIRECTION_MARGIN", () => {
  const candles = pullbackFromHighCandles(0.2);
  const latest = candles.at(-1)!;
  const macro = {
    events: [],
    cot: { net: 5000, netPct: 8, reportDate: cotDateForCandles(candles, 0) },
  };
  const result = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "intraday",
    timeframe: "M15",
    quote: { bid: latest.close - 0.0001, ask: latest.close + 0.0001, mid: latest.close },
    candles,
    enabledStrategyIds: [
      "ema_trend",
      "heiken_ashi_scalp",
      "ai_confluence", // 3 LONG votes, downweighted to "weak" below
      "vwap_mean_rev",
      "trendline_break", // 2 SHORT votes, left at full "strong" weight
    ],
    // Downweight only the long-voting strategies so 3 votes' combined
    // strength still loses to 2 undiminished, independently-categorised
    // short votes — count favors long 3-to-2, strength favors short.
    strategyWeights: { ema_trend: 0.4, heiken_ashi_scalp: 0.4, ai_confluence: 0.4 },
    macro,
  });
  assert.equal(result.signal, null, `expected no signal: ${result.diagnostics.reason}`);
  assert.match(result.diagnostics.reason, /neither side holds a clear majority/i);
  const longVotes = result.diagnostics.votes.filter((v) => v.direction === "long");
  const shortVotes = result.diagnostics.votes.filter((v) => v.direction === "short");
  assert.equal(longVotes.length, 3);
  assert.equal(shortVotes.length, 2);
  const longStrength = longVotes.reduce((sum, v) => sum + v.strength, 0);
  const shortStrength = shortVotes.reduce((sum, v) => sum + v.strength, 0);
  assert.ok(
    shortStrength > longStrength,
    `expected the 2 shorts (${shortStrength}) to still outweigh the 3 longs (${longStrength}) by strength`,
  );
  assert.ok(
    shortStrength / (shortStrength + longStrength) < 0.58,
    `expected short's regime-damped share under DIRECTION_MARGIN, got ${shortStrength / (shortStrength + longStrength)}`,
  );
});

// The two tests above are honest about what the regime table does to those
// fixtures, but between them they stopped asserting the two properties BUG D
// was fixed to guarantee: an exact tie must not default long, and direction
// must follow strength rather than count. Regime weighting moved both fixtures
// off the boundary being tested. These two pin `regimeOverride: "none"` so the
// DIRECTION_MARGIN logic is exercised in isolation — otherwise a regression in
// the tie-break could ship green.

test("scanCandlesForSignal (BUG D, regime off): an exact weighted-strength tie yields no signal, never a default long", () => {
  const candles = pullbackFromHighCandles(0.7);
  const latest = candles.at(-1)!;
  const result = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "intraday",
    timeframe: "M15",
    quote: { bid: latest.close - 0.0001, ask: latest.close + 0.0001, mid: latest.close },
    candles,
    enabledStrategyIds: ["ema_trend", "ai_confluence", "vwap_mean_rev", "trendline_break"],
    macro: { events: [], cot: { net: 5000, netPct: 8, reportDate: cotDateForCandles(candles, 0) } },
    regimeOverride: "none",
  });
  assert.equal(result.signal, null, `expected no signal on a tie: ${result.diagnostics.reason}`);
  assert.match(result.diagnostics.reason, /neither side holds a clear majority/i);
  const longStrength = result.diagnostics.votes
    .filter((v) => v.direction === "long")
    .reduce((sum, v) => sum + v.strength, 0);
  const shortStrength = result.diagnostics.votes
    .filter((v) => v.direction === "short")
    .reduce((sum, v) => sum + v.strength, 0);
  assert.equal(longStrength, shortStrength, "fixture is meant to be an exact strength tie");
});

test("scanCandlesForSignal (BUG D, regime off): 2 strong shorts outvote 3 weak longs, so direction follows strength not count", () => {
  const candles = pullbackFromHighCandles(0.2);
  const latest = candles.at(-1)!;
  const result = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "intraday",
    timeframe: "M15",
    quote: { bid: latest.close - 0.0001, ask: latest.close + 0.0001, mid: latest.close },
    candles,
    enabledStrategyIds: [
      "ema_trend",
      "heiken_ashi_scalp",
      "ai_confluence",
      "vwap_mean_rev",
      "trendline_break",
    ],
    strategyWeights: { ema_trend: 0.4, heiken_ashi_scalp: 0.4, ai_confluence: 0.4 },
    macro: { events: [], cot: { net: 5000, netPct: 8, reportDate: cotDateForCandles(candles, 0) } },
    regimeOverride: "none",
  });
  assert.ok(result.signal, `expected a short signal: ${result.diagnostics.reason}`);
  assert.equal(result.signal!.direction, "short");
  const longVotes = result.diagnostics.votes.filter((v) => v.direction === "long");
  const shortVotes = result.diagnostics.votes.filter((v) => v.direction === "short");
  assert.ok(
    longVotes.length > shortVotes.length,
    "count must favour long, so only strength can explain a short verdict",
  );
});

test("scanCandlesForSignal (BUG D): a clear majority still produces a signal as before", () => {
  const candles = trendCandles("long");
  const latest = candles.at(-1)!;
  const result = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "intraday",
    quote: { bid: latest.close - 0.0001, ask: latest.close + 0.0001, mid: latest.close },
    candles,
    enabledStrategyIds: ["ema_trend", "atr_expansion", "macd_hist"],
  });
  assert.ok(result.signal);
  assert.equal(result.signal.direction, "long");
});

test("newly implemented engine strategies are available with mode-aware timeframes", () => {
  assert.equal(getEngineStrategyCapability("opening_range_breakout").implemented, true);
  assert.equal(getEngineStrategyCapability("heiken_ashi_scalp").implemented, true);
  assert.equal(getEngineStrategyCapability("qullamaggie_breakout").implemented, true);
  assert.equal(getEngineStrategyCapability("ny_killzone").implemented, true);
  assert.equal(getEngineStrategyCapability("asian_range").implemented, true);
  assert.equal(getEngineStrategyCapability("trendline_break").implemented, true);
  assert.equal(getEngineStrategyCapability("fib_retracement").implemented, true);
  assert.equal(getEngineStrategyCapability("gartley").implemented, true);
  assert.equal(getEngineStrategyCapability("bat_pattern").implemented, true);
  assert.equal(getEngineStrategyCapability("butterfly_pattern").implemented, true);
  assert.equal(getEngineStrategyCapability("news_reactive").implemented, true);
  assert.equal(getEngineStrategyCapability("ai_confluence").implemented, true);
  assert.deepEqual(getEngineStrategyCapability("opening_range_breakout").timeframes, [
    "M1",
    "M5",
    "M15",
    "M30",
  ]);
});

// Build a synthetic XABCD zigzag: a textbook bullish Gartley geometry
// (AB/XA 0.618, BC/AB 0.618, D at 0.786 of XA with CD/BC in range), ending on
// a wick into the D zone that closes back up (the rejection entry).
function harmonicCandles(): SignalEngineCandle[] {
  const make = (index: number, open: number, close: number): SignalEngineCandle => ({
    time: new Date(Date.UTC(2026, 6, 10, index, 0)).toISOString(),
    open,
    high: Math.max(open, close) + 0.05,
    low: Math.min(open, close) - 0.05,
    close,
    complete: true,
    volume: 100,
  });
  const x = 100;
  const a = 120;
  const b = a - 0.618 * (a - x); // 107.64
  const c = b + 0.618 * (a - b); // 115.28
  const d = a - 0.786 * (a - x); // 104.28
  // Adjacent leg candles must open BELOW the peak / ABOVE the trough so the
  // swing pivots are strictly confirmed by the k=2 zigzag (equal highs/lows
  // disqualify a pivot).
  const candles: SignalEngineCandle[] = [
    // warmup with lows clearly above X (100.55) so X is a confirmed pivot low
    { ...make(0, 100.9, 100.8), low: 100.75 },
    { ...make(1, 100.8, 100.7), low: 100.65 },
    // X -> A (X is the pivot low at 100.55)
    { ...make(2, 100.7, 105), low: 100.55 },
    make(3, 105, 110),
    make(4, 110, 115),
    make(5, 115, a),
    // A -> B (first down candle opens below the peak)
    make(6, 119, 116),
    make(7, 116, 112),
    make(8, 112, b),
    // B -> C (first up candle opens above the trough)
    make(9, 108.2, 111),
    make(10, 111, c),
    // C -> D: two down candles then the rejection wick into D
    make(11, 114.5, 110),
    make(12, 110, 105.5),
    {
      time: new Date(Date.UTC(2026, 6, 10, 13, 0)).toISOString(),
      open: 105.5,
      close: 105.8,
      high: 105.85,
      low: d, // wick to the D zone
      complete: true,
      volume: 100,
    },
  ];
  return candles;
}

test("gartley harmonic: ratio-validated XABCD votes long from the D reversal zone", () => {
  const vote = evaluateStrategy("gartley", harmonicCandles(), 0.5, "intraday");
  assert.ok(vote, "expected a Gartley vote on the synthetic XABCD");
  assert.equal(vote.direction, "long");
  assert.ok(vote.strength >= 55 && vote.strength <= 80);
});

test("harmonics abstain on a plain trend (no valid XABCD ratio structure)", () => {
  const candles = trendCandles("long");
  assert.equal(evaluateStrategy("gartley", candles, 1), null);
  assert.equal(evaluateStrategy("bat_pattern", candles, 1), null);
  assert.equal(evaluateStrategy("butterfly_pattern", candles, 1), null);
});

function calendarEvent(overrides: {
  currency: string;
  title: string;
  timestamp: number;
  impact?: string;
}) {
  return {
    currency: overrides.currency,
    title: overrides.title,
    time: new Date(overrides.timestamp).toISOString().slice(11, 16),
    timestamp: overrides.timestamp,
    impact: overrides.impact ?? "High",
  };
}

test("news_reactive votes with momentum only while a high-impact release is imminent", () => {
  const candles = trendCandles("long", 40);
  const macro = {
    events: [
      calendarEvent({
        currency: "EUR",
        title: "ECB Rate Decision",
        timestamp: Date.now() + 45 * 60 * 1000,
      }),
    ],
    cot: null,
  };
  const vote = evaluateStrategy("news_reactive", candles, 0.5, "intraday", {
    pair: "EURUSD",
    macro,
  });
  assert.ok(vote);
  assert.equal(vote.direction, "long");
  // No imminent event -> abstains.
  assert.equal(
    evaluateStrategy("news_reactive", candles, 0.5, "intraday", {
      pair: "EURUSD",
      macro: { events: [], cot: null },
    }),
    null,
  );
});

// BUG A: news_reactive used to parse only HH:MM from event.time and compare
// it to the current time-of-day with a wrapped ±480-minute window — the
// event's DATE was discarded, so it fired for roughly two-thirds of the week.
test("news_reactive (BUG A): fires within the release window and abstains outside it", () => {
  const candles = trendCandles("long", 40);

  // 6 hours away, today -> outside (-30, 60], must abstain.
  const sixHoursAway = calendarEvent({
    currency: "EUR",
    title: "ECB Rate Decision",
    timestamp: Date.now() + 6 * 60 * 60 * 1000,
  });
  assert.equal(
    evaluateStrategy("news_reactive", candles, 0.5, "intraday", {
      pair: "EURUSD",
      macro: { events: [sixHoursAway], cot: null },
    }),
    null,
    "an event 6 hours out must not fire",
  );

  // The SAME event 30 minutes away -> inside (-30, 60], must fire.
  const thirtyMinAway = calendarEvent({
    currency: "EUR",
    title: "ECB Rate Decision",
    timestamp: Date.now() + 30 * 60 * 1000,
  });
  const vote = evaluateStrategy("news_reactive", candles, 0.5, "intraday", {
    pair: "EURUSD",
    macro: { events: [thirtyMinAway], cot: null },
  });
  assert.ok(vote, "an event 30 minutes out must fire");
});

test("news_reactive (BUG A): an event with today's clock time but tomorrow's date must not fire", () => {
  // This is the exact regression. An event exactly 24h away has the SAME UTC
  // clock time as right now — only its date differs. The old code compared
  // bare HH:MM and would have matched it as imminent; the fix reads the real
  // timestamp and must not.
  const candles = trendCandles("long", 40);
  const now = Date.now();
  const tomorrowSameClockTime = now + 24 * 60 * 60 * 1000;
  const event = calendarEvent({
    currency: "EUR",
    title: "ECB Rate Decision",
    timestamp: tomorrowSameClockTime,
  });
  assert.equal(
    event.time,
    new Date(now).toISOString().slice(11, 16),
    "sanity check: the fixture's clock time must match now's clock time",
  );
  const vote = evaluateStrategy("news_reactive", candles, 0.5, "intraday", {
    pair: "EURUSD",
    macro: { events: [event], cot: null },
  });
  assert.equal(
    vote,
    null,
    "an event 24h away must not fire even though its clock time matches now",
  );
});

test("ai_confluence votes with strong COT positioning, quote-aware and catalyst-boosted", () => {
  const candles = trendCandles("long", 40);
  const cot = { net: 5000, netPct: 32, reportDate: isoDateDaysAgo(2) };
  const longEur = evaluateStrategy("ai_confluence", candles, 0.5, "intraday", {
    pair: "EURUSD",
    macro: { events: [], cot },
  });
  assert.ok(longEur);
  assert.equal(longEur.direction, "long"); // net long EUR -> long EURUSD
  // JPY-quote pair inverts: net long JPY -> short USDJPY.
  const jpy = evaluateStrategy("ai_confluence", candles, 0.5, "intraday", {
    pair: "USDJPY",
    macro: { events: [], cot },
  });
  assert.equal(jpy?.direction, "short");
  // Weak positioning -> abstains.
  assert.equal(
    evaluateStrategy("ai_confluence", candles, 0.5, "intraday", {
      pair: "EURUSD",
      macro: { events: [], cot: { net: 100, netPct: 4, reportDate: isoDateDaysAgo(2) } },
    }),
    null,
  );
});

// BUG C: COT positioning used to vote at full strength no matter how stale
// cot.reportDate was. CFTC COT is Tuesday data published Friday — routinely
// 3-8 days old, and over two weeks old by the following Thursday.
test("ai_confluence (BUG C): a fresher COT report votes stronger than a stale one; very stale abstains", () => {
  const candles = trendCandles("long", 40);
  const netPct = 30;

  const fresh = evaluateStrategy("ai_confluence", candles, 0.5, "intraday", {
    pair: "EURUSD",
    macro: { events: [], cot: { net: 5000, netPct, reportDate: isoDateDaysAgo(1) } },
  });
  const stale = evaluateStrategy("ai_confluence", candles, 0.5, "intraday", {
    pair: "EURUSD",
    macro: { events: [], cot: { net: 5000, netPct, reportDate: isoDateDaysAgo(10) } },
  });
  assert.ok(fresh);
  assert.ok(stale);
  assert.ok(
    fresh.strength > stale.strength,
    `expected a 1-day-old report (${fresh.strength}) stronger than a 10-day-old one (${stale.strength})`,
  );
  assert.match(fresh.reason, /\d+(\.\d+)?d old/, "the vote reason should mention report age");

  // Past the two-week cutoff -> abstains entirely regardless of netPct.
  const ancient = evaluateStrategy("ai_confluence", candles, 0.5, "intraday", {
    pair: "EURUSD",
    macro: { events: [], cot: { net: 5000, netPct, reportDate: isoDateDaysAgo(20) } },
  });
  assert.equal(ancient, null);
});

// BUG B: the macro confluence nudge used to add +5 confidence, unconditionally
// and direction-agnostically, whenever ANY high-impact event existed anywhere
// in the 24h lookahead. A pending release makes a setup less reliable, not
// more, so every branch here only ever subtracts (or does nothing).
test("macroConfluenceAdjustment (BUG B): proximity-scaled penalty, never a bonus", () => {
  const now = Date.now();
  const pair = "EURUSD";

  assert.deepEqual(macroConfluenceAdjustment([], pair, now), {
    adjustment: 0,
    risk: "none",
    event: null,
  });

  // At the release minute: full -8 penalty.
  const atRelease = macroConfluenceAdjustment(
    [{ impact: "High", currency: "EUR", timestamp: now, title: "CPI" }],
    pair,
    now,
  );
  assert.equal(atRelease.adjustment, -8);
  assert.equal(atRelease.risk, "high");

  // 20 minutes after release: fixed -4 (still whipsawing).
  const afterRelease = macroConfluenceAdjustment(
    [{ impact: "High", currency: "EUR", timestamp: now - 20 * 60_000, title: "CPI" }],
    pair,
    now,
  );
  assert.equal(afterRelease.adjustment, -4);
  assert.equal(afterRelease.risk, "high");

  // 3 hours out: visible but not yet penalised.
  const threeHoursOut = macroConfluenceAdjustment(
    [{ impact: "High", currency: "EUR", timestamp: now + 3 * 60 * 60_000, title: "CPI" }],
    pair,
    now,
  );
  assert.equal(threeHoursOut.adjustment, 0);
  assert.equal(threeHoursOut.risk, "elevated");

  // A High event for an unrelated currency (JPY) is ignored for EURUSD.
  const unrelated = macroConfluenceAdjustment(
    [{ impact: "High", currency: "JPY", timestamp: now, title: "BoJ Rate Decision" }],
    pair,
    now,
  );
  assert.deepEqual(unrelated, { adjustment: 0, risk: "none", event: null });
});

test("walk-forward weights downweight only strategies that fail out-of-sample", () => {
  const candles = trendCandles("long", 200);
  const { weights, report } = computeStrategyWeights(candles, "M5");
  assert.ok(report.entries.length >= 14);
  assert.ok(report.entries.every((entry) => entry.weight >= 0.15 && entry.weight <= 1.15));
  // A strong trend should reward trend-followers on the test window.
  assert.ok(weights["ema_trend"] !== undefined);
  assert.ok(report.entries.every((entry) => entry.accuracy >= 0 && entry.accuracy <= 1));
});

test("path replay: TP1 then a retrace through breakeven is a scratch, not a win (B-single)", () => {
  const created = "2026-07-01T12:00:00.000Z";
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 1.1,
    stop_loss: 1.09,
    take_profit_1: 1.105,
    take_profit_2: 1.11,
    created_at: created,
  };
  const candles = [
    // Entry bar: nothing touched.
    { time: "2026-07-01T12:05:00.000Z", high: 1.1005, low: 1.0995, close: 1.1002 },
    // TP1 touched (high >= 1.105), then price retraces below entry.
    { time: "2026-07-01T12:10:00.000Z", high: 1.1052, low: 1.099, close: 1.0985 },
    // Never touches SL.
    { time: "2026-07-01T12:15:00.000Z", high: 1.099, low: 1.0975, close: 1.098 },
  ];
  const outcome = replaySignalPath(signal, candles);
  assert.equal(outcome.status, "hit_tp1");
  // Reached TP1, the stop moved to breakeven, price came back through it.
  // The trader walks away flat: 0R, not the +1.25R the all-out model booked.
  assert.equal(outcome.r, 0);
  // The legacy policy remains measurable, which is how we know what changed.
  assert.equal(replaySignalPath(signal, candles, { policy: "all_out" }).r, 1.25);
});

test("path replay: a candle touching both target and stop resolves the stop", () => {
  const created = "2026-07-01T12:00:00.000Z";
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 1.1,
    stop_loss: 1.09,
    take_profit_1: 1.105,
    take_profit_2: 1.11,
    created_at: created,
  };
  const outcome = replaySignalPath(signal, [
    { time: "2026-07-01T12:05:00.000Z", high: 1.1102, low: 1.089, close: 1.098 },
  ]);
  assert.equal(outcome.status, "hit_sl");
  assert.equal(outcome.r, -1);
});

test("path replay: TP2 wins when it is the first level touched", () => {
  const created = "2026-07-01T12:00:00.000Z";
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 1.1,
    stop_loss: 1.09,
    take_profit_1: 1.105,
    take_profit_2: 1.11,
    created_at: created,
  };
  const outcome = replaySignalPath(signal, [
    { time: "2026-07-01T12:05:00.000Z", high: 1.1103, low: 1.1001, close: 1.11 },
  ]);
  assert.equal(outcome.status, "hit_tp2");
  assert.equal(outcome.r, 2);
});

function resolvedSignal(
  overrides: Partial<ResolvedSignalForLearning> & {
    status: ResolvedSignalForLearning["status"];
  },
): ResolvedSignalForLearning {
  return {
    id: `sig-${Math.random().toString(36).slice(2, 8)}`,
    pair: "XAUUSD",
    direction: "long",
    mode: "intraday",
    timeframe: "H1",
    confluence: 72,
    contributing_strategies: ["ema_trend"],
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

test("trust multiplier: boosts proven strategies, cools losers, holds without evidence", () => {
  assert.deepEqual(trustMultiplier(0.7, 2), { multiplier: 1, verdict: "insufficient" });
  assert.equal(trustMultiplier(0.75, 5, 4).multiplier, 1.35);
  assert.equal(trustMultiplier(0.62, 4, 3).multiplier, 1.2);
  assert.equal(trustMultiplier(0.3, 3, 1).multiplier, 0.6);
  // A <25% rate is COOLED (0.5) without strong evidence, hard-EXCLUDED (0.3)
  // only once >= 8 resolved outcomes confirm it.
  assert.equal(trustMultiplier(0.2, 6, 1).multiplier, 0.5);
  assert.equal(trustMultiplier(0.2, 6, 1).verdict, "cool");
  assert.equal(trustMultiplier(0.2, 10, 1).multiplier, 0.3);
  assert.equal(trustMultiplier(0.5, 6, 3).multiplier, 1);
  // A glowing weighted rate with fewer than 2 RAW wins is never boosted — the
  // panel shows raw wins/resolved, so "BOOST ×1.35 1/3" would contradict it.
  assert.deepEqual(trustMultiplier(0.9, 3, 1), { multiplier: 1, verdict: "hold" });
});

test("learned multiplier × neutral walk-forward weight lands under the engine floor", () => {
  // 0.3 multiplier on a neutral weight (1.0) -> 0.3 < DOWNWEIGHT_FLOOR (0.35):
  // the strategy stops contributing exactly as the engine excludes it.
  const excluded = computeStrategyLearning(
    Array.from({ length: 9 }, () => resolvedSignal({ status: "hit_sl" })),
    "intraday",
  ).get("ema_trend")!;
  const applied = Math.min(1.15, Math.max(0.15, 1.0 * excluded.multiplier));
  assert.ok(applied < 0.35, `expected applied weight < 0.35, got ${applied}`);
  // And the clamp matches the engine's own 0.15..1.15 walk-forward bounds.
  const boosted = computeStrategyLearning(
    [
      resolvedSignal({ status: "hit_tp2" }),
      resolvedSignal({ status: "hit_tp1" }),
      resolvedSignal({ status: "hit_tp2" }),
      resolvedSignal({ status: "hit_tp1" }),
      resolvedSignal({ status: "hit_tp2" }),
    ],
    "intraday",
  ).get("ema_trend")!;
  assert.equal(boosted.verdict, "boost");
  assert.ok(Math.min(1.15, Math.max(0.15, 1.15 * boosted.multiplier)) <= 1.15);
});

test("a chronically losing strategy is COOLED, and only EXCLUDED with strong evidence", () => {
  // 5 losses: cooled to 0.5x — still contributes at reduced strength.
  const five = computeStrategyLearning(
    Array.from({ length: 5 }, () =>
      resolvedSignal({ status: "hit_sl", contributing_strategies: ["vwap_mean_rev"] }),
    ),
    "intraday",
  ).get("vwap_mean_rev")!;
  assert.ok(five);
  assert.equal(five.verdict, "cool");
  assert.equal(five.losses, 5);
  assert.equal(five.multiplier, 0.5);
  assert.equal(five.excluded, false);
  // 9 losses: overwhelming evidence -> hard-excluded under the engine floor.
  const nine = computeStrategyLearning(
    Array.from({ length: 9 }, () =>
      resolvedSignal({ status: "hit_sl", contributing_strategies: ["vwap_mean_rev"] }),
    ),
    "intraday",
  ).get("vwap_mean_rev")!;
  assert.equal(nine.verdict, "cool");
  assert.equal(nine.excluded, true);
  // A neutral walk-forward weight (1.0) × 0.3 = 0.3 < 0.35 floor -> excluded.
  assert.ok(nine.multiplier < 0.35);
});

test("learning is mode-aware: the same strategy can be boosted in one mode, cooled in the other", () => {
  const signals = [
    resolvedSignal({ mode: "scalper", status: "hit_sl", contributing_strategies: ["stoch_rsi"] }),
    resolvedSignal({ mode: "scalper", status: "hit_sl", contributing_strategies: ["stoch_rsi"] }),
    resolvedSignal({ mode: "scalper", status: "hit_sl", contributing_strategies: ["stoch_rsi"] }),
    // Under B-single only TP2 is a win — `hit_tp1` is the breakeven scratch —
    // so a strategy earning a boost has to actually reach the far target.
    resolvedSignal({ mode: "intraday", status: "hit_tp2", contributing_strategies: ["stoch_rsi"] }),
    resolvedSignal({ mode: "intraday", status: "hit_tp2", contributing_strategies: ["stoch_rsi"] }),
    resolvedSignal({ mode: "intraday", status: "hit_tp2", contributing_strategies: ["stoch_rsi"] }),
  ];
  const scalper = computeStrategyLearning(signals, "scalper");
  const intraday = computeStrategyLearning(signals, "intraday");
  assert.equal(scalper.get("stoch_rsi")!.verdict, "cool");
  assert.equal(intraday.get("stoch_rsi")!.verdict, "boost");
  assert.ok(intraday.get("stoch_rsi")!.totalR > 0);
});

test("recency weighting: a winning streak now outweighs an old losing streak", () => {
  const now = Date.now();
  const old = new Date(now - 12 * 86_400_000).toISOString(); // 12 days ago
  const fresh = new Date(now - 60_000).toISOString();
  const signals = [
    resolvedSignal({ status: "hit_sl", created_at: old }),
    resolvedSignal({ status: "hit_sl", created_at: old }),
    resolvedSignal({ status: "hit_tp2", created_at: fresh }),
    resolvedSignal({ status: "hit_tp2", created_at: fresh }),
    resolvedSignal({ status: "hit_tp2", created_at: fresh }),
  ];
  const learning = computeStrategyLearning(signals, "intraday", now);
  const entry = learning.get("ema_trend")!;
  assert.equal(entry.wins, 3);
  assert.equal(entry.losses, 2);
  // Old losses decay to ~1/16 weight each; fresh wins dominate the rate.
  assert.ok(entry.winRate > 0.6, `expected recency-weighted win rate > 0.6, got ${entry.winRate}`);
  assert.equal(entry.verdict, "boost");
});

test("autopsy: SL loss blames the carrying strategies and points at liquidity", () => {
  const autopsy = buildSignalAutopsy(
    resolvedSignal({
      status: "hit_sl",
      contributing_strategies: ["bos_choch", "ema_trend"],
      confluence: 61,
    }),
  )!;
  assert.ok(autopsy);
  assert.match(autopsy.headline, /Stopped out/);
  assert.match(autopsy.diagnosis, /bos_choch/);
  assert.match(autopsy.lesson, /cooling/);
});

test("learning report aggregates strengths, weaknesses, autopsies and recommendations", () => {
  const now = Date.now();
  const signals: ResolvedSignalForLearning[] = [
    resolvedSignal({
      mode: "intraday",
      status: "hit_tp2",
      contributing_strategies: ["fib_retracement"],
      created_at: new Date(now - 60_000).toISOString(),
    }),
    // TP2, not TP1: under B-single `hit_tp1` is the breakeven scratch, so a
    // strategy has to reach the far target to register as a strength.
    resolvedSignal({
      mode: "intraday",
      status: "hit_tp2",
      contributing_strategies: ["fib_retracement"],
      created_at: new Date(now - 120_000).toISOString(),
    }),
    resolvedSignal({
      mode: "intraday",
      status: "hit_tp2",
      contributing_strategies: ["fib_retracement"],
      created_at: new Date(now - 180_000).toISOString(),
    }),
    resolvedSignal({
      mode: "scalper",
      status: "hit_sl",
      contributing_strategies: ["vwap_mean_rev"],
      created_at: new Date(now - 240_000).toISOString(),
    }),
    resolvedSignal({
      mode: "scalper",
      status: "hit_sl",
      contributing_strategies: ["vwap_mean_rev"],
      created_at: new Date(now - 300_000).toISOString(),
    }),
    resolvedSignal({
      mode: "scalper",
      status: "hit_sl",
      contributing_strategies: ["vwap_mean_rev"],
      created_at: new Date(now - 360_000).toISOString(),
    }),
    resolvedSignal({
      mode: "scalper",
      status: "invalidated",
      contributing_strategies: ["asian_range"],
      created_at: new Date(now - 420_000).toISOString(),
    }),
  ];
  const report = buildLearningReport(signals, now);
  assert.equal(report.resolved, 6);
  assert.equal(report.wins, 3);
  assert.equal(report.losses, 3);
  assert.equal(report.stale, 1);
  assert.equal(report.winRate, 50);
  assert.ok(report.strengths.some((s) => s.strategyId === "fib_retracement"));
  assert.ok(report.weaknesses.some((s) => s.strategyId === "vwap_mean_rev"));
  assert.ok(report.adjustmentsApplied >= 2);
  assert.ok(report.autopsies.length >= 1);
  assert.ok(report.recommendations.length >= 2);
});

test("followability: a signal is too late once price moved past half the risk", () => {
  const signal = { direction: "long" as const, entry: 1.1, stop_loss: 1.09 };
  assert.equal(followabilityForSignal(signal, 1.0995).followable, true);
  // Long: price ABOVE entry is favorable — still followable.
  assert.equal(followabilityForSignal(signal, 1.106).followable, true);
  // Long: price BELOW entry (toward stop, 60% of risk) is too late.
  assert.equal(followabilityForSignal(signal, 1.094).followable, false);
  const short = { direction: "short" as const, entry: 1.1, stop_loss: 1.11 };
  // Short: price a touch below entry (favorable) stays followable.
  assert.equal(followabilityForSignal(short, 1.103).followable, true);
  assert.equal(followabilityForSignal(short, 1.094).followable, true);
  // Short: price ABOVE entry (60% of risk) is too late.
  assert.equal(followabilityForSignal(short, 1.106).followable, false);
  // Short: far adverse move reports its magnitude.
  assert.equal(followabilityForSignal(short, 1.116).followable, false);
  assert.equal(followabilityForSignal(short, 1.116).distancePct, 1.6);
});

// ---------------------------------------------------------------------------
// Multi-timeframe confluence (mtf-engine.ts)
// ---------------------------------------------------------------------------

// The full engine catalog — imported (not hardcoded) so the MTF tests stay in
// sync when strategies are added or renamed.
function engineStrategyIds(): string[] {
  return [...ALL_ENGINE_STRATEGY_IDS];
}

test("MTF plans match the user's spec: 5M entry + 15M/30M/1H/4H/1D tide for intraday, 1M entry + 5M/15M/30M for scalper", () => {
  assert.deepEqual(MTF_PLANS.intraday.entryTf, "M5");
  assert.deepEqual(MTF_PLANS.intraday.directionTfs, ["M15", "M30", "H1", "H4", "D1"]);
  assert.deepEqual(MTF_PLANS.scalper.entryTf, "M1");
  assert.deepEqual(MTF_PLANS.scalper.directionTfs, ["M5", "M15", "M30"]);
});

test("evaluateTfDirection: a strong uptrend resolves to a long bias with real votes", () => {
  const candles = trendCandles("long");
  const bias = evaluateTfDirection({
    pair: "EURUSD",
    tf: "H1",
    mode: "intraday",
    candles,
    enabledStrategyIds: engineStrategyIds(),
  });
  assert.equal(bias.direction, "long");
  assert.ok(bias.votes >= 2, `expected at least 2 agreeing votes, got ${bias.votes}`);
  assert.ok(bias.strength > 0);
  assert.ok(bias.strategies.length > 0);
});

test("evaluateTfDirection: a strong downtrend resolves to a short bias", () => {
  const candles = trendCandles("short");
  const bias = evaluateTfDirection({
    pair: "EURUSD",
    tf: "H1",
    mode: "intraday",
    candles,
    enabledStrategyIds: engineStrategyIds(),
  });
  assert.equal(bias.direction, "short");
  assert.ok(bias.votes >= 2);
});

// BUG D (mirror of the scanCandlesForSignal case above): evaluateTfDirection
// used to pick the side with `longs.length >= shorts.length`, so a tie always
// resolved long. It must now fall back to neutral.
test("evaluateTfDirection (BUG D): a weighted-strength tie resolves to neutral, not a default long", () => {
  const candles = pullbackFromHighCandles(0.7);
  const macro = {
    events: [],
    cot: { net: 5000, netPct: 8, reportDate: cotDateForCandles(candles, 0) },
  };
  const bias = evaluateTfDirection({
    pair: "EURUSD",
    tf: "M15",
    mode: "intraday",
    candles,
    enabledStrategyIds: ["ema_trend", "ai_confluence", "vwap_mean_rev", "trendline_break"],
    macro,
  });
  assert.equal(bias.direction, "neutral");
});

test("computeMtfAgreement: a unanimous long tide confirms LONG with 100% alignment", () => {
  const plan = MTF_PLANS.intraday;
  const candlesByTf: Record<string, SignalEngineCandle[]> = {};
  for (const tf of plan.directionTfs) candlesByTf[tf] = trendCandles("long");
  const agreement = computeMtfAgreement({
    pair: "EURUSD",
    mode: "intraday",
    plan,
    candlesByTf,
    enabledStrategyIds: engineStrategyIds(),
  });
  assert.equal(agreement.confirmed, "long");
  assert.equal(agreement.agreementScore, 100);
  assert.ok(agreement.biases.every((bias) => bias.direction === "long"));
});

test("computeMtfAgreement: a mixed tide confirms the majority side with proportional alignment", () => {
  const plan = MTF_PLANS.intraday;
  const candlesByTf: Record<string, SignalEngineCandle[]> = {};
  plan.directionTfs.forEach((tf, index) => {
    // Three long TFs, then the last two short -> majority LONG, alignment 3/5.
    candlesByTf[tf] = trendCandles(index < 3 ? "long" : "short");
  });
  const agreement = computeMtfAgreement({
    pair: "EURUSD",
    mode: "intraday",
    plan,
    candlesByTf,
    enabledStrategyIds: engineStrategyIds(),
  });
  assert.equal(agreement.confirmed, "long");
  assert.equal(agreement.agreementScore, 60); // 3/5
  const directional = agreement.biases.filter((bias) => bias.direction !== "neutral");
  assert.equal(directional.length, 5);
});

// ---------------------------------------------------------------------------
// W3.4: sharp-reversal strategy pack — rsi_divergence, macd_divergence,
// climax_exhaustion, stop_run_reversal, failed_breakout. The catalog above is
// trend- and breakout-heavy: it can tell you a move is running, not that it
// is ending. These five instead look for a move ENDING — momentum divergence
// at a swing extreme, a climax bar rejecting a fresh extreme, a swept level
// reclaimed, and a breakout that trapped the crowd and failed. Evaluators are
// implemented and independently verified already; this section only adds
// coverage through the public evaluateStrategy(...) entry point, exactly the
// path scanCandlesForSignal uses.
// ---------------------------------------------------------------------------

function reversalBar(
  index: number,
  bar: { open: number; high: number; low: number; close: number; volume?: number },
): SignalEngineCandle {
  return {
    time: new Date(Date.UTC(2026, 6, 1, 0, index * 5)).toISOString(),
    complete: true,
    volume: bar.volume ?? 100,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  };
}

/** A quiet, rangebound base: identical small-range bars around 100, so no
 *  swing, sweep, or breakout can accidentally form inside the "quiet" run
 *  itself — only bars appended after it can fire a vote. */
function flatCandles(count = 60): SignalEngineCandle[] {
  return Array.from({ length: count }, (_, index) =>
    reversalBar(index, { open: 100, high: 100.3, low: 99.7, close: 100 }),
  );
}

/** Appends explicit bars after a flat base, continuing the same time series. */
function afterFlat(
  bars: { open: number; high: number; low: number; close: number; volume?: number }[],
  flatCount = 60,
): SignalEngineCandle[] {
  const base = flatCandles(flatCount);
  return [...base, ...bars.map((bar, offset) => reversalBar(flatCount + offset, bar))];
}

/**
 * 40 bars declining 120 - i*0.8, then 6 bars rising from 88 by 0.9 (swing low
 * A), then 8 bars declining from 93.4 by 0.75 (a LOWER low B), then 4 bars
 * rising from 87.4 by 1.1 (the reclaim). Both rsi_divergence and
 * macd_divergence fire long on this shape: price makes a lower low while
 * RSI14 / the MACD line make a higher low, and the reclaim is already
 * underway. High/low are close +/- a fixed wick, never derived from open —
 * a wick derived from open ties the turning-point bar's low with its
 * neighbor's, which stops findSwingPoints from recognizing the pivot.
 * Verified against the live evaluator: RSI at A is exactly 0 (a 40-bar
 * monotonic decline pins the Wilder average-gain floor at 0 — legitimate,
 * not a bug) and ~20 at B, a genuine higher low.
 */
function divergenceLongCandles(): SignalEngineCandle[] {
  const candles: SignalEngineCandle[] = [];
  let prevClose = 120;
  let index = 0;
  const push = (close: number) => {
    candles.push(
      reversalBar(index, { open: prevClose, high: close + 0.15, low: close - 0.15, close }),
    );
    prevClose = close;
    index += 1;
  };
  for (let i = 0; i < 40; i += 1) push(120 - i * 0.8);
  for (let j = 1; j <= 6; j += 1) push(88 + j * 0.9);
  for (let j = 1; j <= 8; j += 1) push(93.4 - j * 0.75);
  for (let j = 1; j <= 4; j += 1) push(87.4 + j * 1.1);
  return candles;
}

/** Mirror of divergenceLongCandles: price makes a higher high while RSI14 /
 *  the MACD line make a lower high. Both strategies fire short. */
function divergenceShortCandles(): SignalEngineCandle[] {
  const candles: SignalEngineCandle[] = [];
  let prevClose = 80;
  let index = 0;
  const push = (close: number) => {
    candles.push(
      reversalBar(index, { open: prevClose, high: close + 0.15, low: close - 0.15, close }),
    );
    prevClose = close;
    index += 1;
  };
  for (let i = 0; i < 40; i += 1) push(80 + i * 0.8);
  for (let j = 1; j <= 6; j += 1) push(112 - j * 0.9);
  for (let j = 1; j <= 8; j += 1) push(106.6 + j * 0.75);
  for (let j = 1; j <= 4; j += 1) push(112.6 - j * 1.1);
  return candles;
}

/**
 * Near miss for rsi_divergence: price makes a lower low but RSI makes a
 * lower low too — a confirming move, not a divergence. A 14-bar seed
 * (7 bars down, 7 up, each +/-1) gives RSI a genuine mid-range value at
 * pivot A instead of pinning it at the 0 floor; a short 5-bar decline
 * leaves RSI only partly decayed there. After a brief 2-bar bounce (just
 * enough to make A a valid pivot), a much LONGER 20-bar decline to pivot B
 * lets RSI decay further, landing lower than it was at A — even though
 * price, spacing, freshness and the reclaim all satisfy every other clause.
 * Verified against the live evaluator that this isolates the "no
 * divergence" condition specifically.
 */
function rsiNoDivergenceCandles(): SignalEngineCandle[] {
  const candles: SignalEngineCandle[] = [];
  let prevClose = 100;
  let index = 0;
  let close = 100;
  const push = () => {
    candles.push(
      reversalBar(index, { open: prevClose, high: close + 0.15, low: close - 0.15, close }),
    );
    prevClose = close;
    index += 1;
  };
  push(); // seed bar
  for (let i = 0; i < 7; i += 1) {
    close -= 1;
    push();
  }
  for (let i = 0; i < 7; i += 1) {
    close += 1;
    push();
  }
  for (let i = 0; i < 5; i += 1) {
    close -= 1;
    push();
  } // -> pivot A
  for (let i = 0; i < 2; i += 1) {
    close += 1;
    push();
  } // brief bounce, just enough for a pivot
  for (let i = 0; i < 20; i += 1) {
    close -= 1;
    push();
  } // -> pivot B, a lower low
  for (let i = 0; i < 4; i += 1) {
    close += 1;
    push();
  } // reclaim
  return candles;
}

/** Near miss for rsi_divergence: the SAME real bullish divergence as
 *  divergenceLongCandles, but with 20 extra drifting bars appended after the
 *  reclaim so the newer pivot (B) sits ~20 bars behind the latest close —
 *  past the strategy's <=5-bar freshness window. */
function staleDivergenceCandles(): SignalEngineCandle[] {
  const candles = divergenceLongCandles();
  let prevClose = candles.at(-1)!.close;
  let index = candles.length;
  for (let j = 1; j <= 20; j += 1) {
    const close = prevClose + 0.1;
    candles.push(
      reversalBar(index, { open: prevClose, high: close + 0.15, low: close - 0.15, close }),
    );
    prevClose = close;
    index += 1;
  }
  return candles;
}

/**
 * Near miss for macd_divergence: a genuine higher low in the MACD line
 * (price makes a lower low, the MACD line makes a higher low, and spacing /
 * freshness / reclaim all check out) but the MACD value at the newer low
 * never crosses below zero — a shallow pullback inside a strong uptrend,
 * not a real bottom. A big prior uptrend (100 bars) plus a gentle 30-bar
 * pullback to A, an 8-bar bounce, then a sharp 2-bar drop to a marginally
 * lower B keeps momentum positive throughout. Verified against the live
 * evaluator that this isolates the "MACD above zero" condition specifically
 * — every other clause in evaluateMacdDivergence's long branch holds.
 */
function macdAboveZeroCandles(): SignalEngineCandle[] {
  const candles: SignalEngineCandle[] = [];
  let prevClose = 50;
  let index = 0;
  let close = 50;
  const push = () => {
    candles.push(
      reversalBar(index, { open: prevClose, high: close + 0.15, low: close - 0.15, close }),
    );
    prevClose = close;
    index += 1;
  };
  push(); // seed bar
  for (let i = 0; i < 100; i += 1) {
    close += 1.5;
    push();
  } // strong prior uptrend
  for (let i = 0; i < 30; i += 1) {
    close -= 0.25;
    push();
  } // gentle pullback -> pivot A
  for (let i = 0; i < 8; i += 1) {
    close += 1.0;
    push();
  } // bounce
  for (let i = 0; i < 2; i += 1) {
    close -= 5.0;
    push();
  } // sharp drop -> pivot B, a marginal new low
  for (let i = 0; i < 4; i += 1) {
    close += 1.0;
    push();
  } // reclaim
  return candles;
}

test("rsi_divergence: fires long on a lower price low with a higher RSI low (bullish divergence, reclaim underway)", () => {
  const candles = divergenceLongCandles();
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("rsi_divergence", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a bullish RSI divergence vote");
  assert.equal(vote.direction, "long");
  assert.ok(vote.strength >= 60 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /divergence/i);
});

test("rsi_divergence: fires short on a higher price high with a lower RSI high (bearish divergence, rejection underway)", () => {
  const candles = divergenceShortCandles();
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("rsi_divergence", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a bearish RSI divergence vote");
  assert.equal(vote.direction, "short");
  assert.ok(vote.strength >= 60 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /divergence/i);
});

test("rsi_divergence (near miss): price makes a lower low but RSI makes a lower low too — no divergence, no vote", () => {
  const candles = rsiNoDivergenceCandles();
  const atr = latestAtr(candles);
  assert.equal(
    evaluateStrategy("rsi_divergence", candles, atr, "intraday", { pair: "EURUSD" }),
    null,
  );
});

test("rsi_divergence (near miss): real divergence but the newer pivot is ~20 bars old — the <=5-bar freshness rule blocks it", () => {
  const candles = staleDivergenceCandles();
  const atr = latestAtr(candles);
  assert.equal(
    evaluateStrategy("rsi_divergence", candles, atr, "intraday", { pair: "EURUSD" }),
    null,
  );
});

test("macd_divergence: fires long on the same bullish divergence shape (reads the MACD line, not the histogram)", () => {
  const candles = divergenceLongCandles();
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("macd_divergence", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a bullish MACD-line divergence vote");
  assert.equal(vote.direction, "long");
  assert.ok(vote.strength >= 60 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /divergence/i);
});

test("macd_divergence: fires short on the mirrored bearish divergence shape", () => {
  const candles = divergenceShortCandles();
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("macd_divergence", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a bearish MACD-line divergence vote");
  assert.equal(vote.direction, "short");
  assert.ok(vote.strength >= 60 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /divergence/i);
});

test("macd_divergence (near miss): divergence present but the MACD value at the newer low is above zero — not a real bottom", () => {
  const candles = macdAboveZeroCandles();
  const atr = latestAtr(candles);
  assert.equal(
    evaluateStrategy("macd_divergence", candles, atr, "intraday", { pair: "EURUSD" }),
    null,
  );
});

test("climax_exhaustion: fires short on a top-decile range bar making a new high and closing in the lower third", () => {
  const candles = afterFlat([{ open: 100, high: 112, low: 99, close: 100.5, volume: 5000 }]);
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("climax_exhaustion", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a short climax vote");
  assert.equal(vote.direction, "short");
  assert.ok(vote.strength >= 58 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /climax/i);
});

test("climax_exhaustion: fires long on the mirrored bar making a new low and closing in the upper third", () => {
  const candles = afterFlat([{ open: 100, high: 101, low: 88, close: 99.5, volume: 5000 }]);
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("climax_exhaustion", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a long climax vote");
  assert.equal(vote.direction, "long");
  assert.ok(vote.strength >= 58 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /climax/i);
});

test("climax_exhaustion (near miss): top-decile range bar makes a new high but closes in the middle third — no vote", () => {
  const candles = afterFlat([{ open: 100, high: 112, low: 99, close: 105, volume: 5000 }]);
  const atr = latestAtr(candles);
  assert.equal(
    evaluateStrategy("climax_exhaustion", candles, atr, "intraday", { pair: "EURUSD" }),
    null,
  );
});

test("stop_run_reversal: fires short when the prior high is swept and the next bar reclaims it on a real body", () => {
  const candles = afterFlat([
    { open: 100, high: 106, low: 99.8, close: 105 },
    { open: 105, high: 105.2, low: 99, close: 99.3 },
  ]);
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("stop_run_reversal", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a short stop-run-reversal vote");
  assert.equal(vote.direction, "short");
  assert.ok(vote.strength >= 60 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /stop run/i);
});

test("stop_run_reversal: fires long when the prior low is swept and the next bar reclaims it on a real body", () => {
  const candles = afterFlat([
    { open: 100, high: 100.2, low: 94, close: 95 },
    { open: 95, high: 101, low: 94.8, close: 100.7 },
  ]);
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("stop_run_reversal", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a long stop-run-reversal vote");
  assert.equal(vote.direction, "long");
  assert.ok(vote.strength >= 60 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /stop run/i);
});

test("stop_run_reversal (near miss): the extreme is swept but the confirm bar's body is below the 0.25 ATR minimum (a doji) — no vote", () => {
  const candles = afterFlat([
    { open: 100, high: 106, low: 99.8, close: 105 },
    { open: 100.5, high: 100.6, low: 100.4, close: 100.52 },
  ]);
  const atr = latestAtr(candles);
  assert.equal(
    evaluateStrategy("stop_run_reversal", candles, atr, "intraday", { pair: "EURUSD" }),
    null,
  );
});

test("failed_breakout: fires short when a break above the 20-bar high closes back inside by >= 0.25 ATR", () => {
  const candles = afterFlat([
    { open: 100, high: 108, low: 100, close: 107 },
    { open: 107, high: 107, low: 96, close: 96.5 },
  ]);
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("failed_breakout", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a short failed-breakout vote");
  assert.equal(vote.direction, "short");
  assert.ok(vote.strength >= 58 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /breakout/i);
});

test("failed_breakout: fires long when a break below the 20-bar low closes back inside by >= 0.25 ATR", () => {
  const candles = afterFlat([
    { open: 100, high: 100, low: 92, close: 93 },
    { open: 93, high: 104, low: 93, close: 103.5 },
  ]);
  const atr = latestAtr(candles);
  const vote = evaluateStrategy("failed_breakout", candles, atr, "intraday", { pair: "EURUSD" });
  assert.ok(vote, "expected a long failed-breakout vote");
  assert.equal(vote.direction, "long");
  assert.ok(vote.strength >= 58 && vote.strength <= 80, `strength out of range: ${vote.strength}`);
  assert.match(vote.reason, /breakdown|breakout/i);
});

test("failed_breakout (near miss): breakout happened but price is still outside the range — no vote", () => {
  const candles = afterFlat([
    { open: 100, high: 108, low: 100, close: 107 },
    { open: 107, high: 107.5, low: 106.5, close: 107.2 },
  ]);
  const atr = latestAtr(candles);
  assert.equal(
    evaluateStrategy("failed_breakout", candles, atr, "intraday", { pair: "EURUSD" }),
    null,
  );
});

test("sharp-reversal strategies are registered in the capability map AND the walk-forward catalog (not just one of the two)", () => {
  for (const id of [
    "rsi_divergence",
    "macd_divergence",
    "climax_exhaustion",
    "stop_run_reversal",
    "failed_breakout",
  ]) {
    assert.equal(getEngineStrategyCapability(id).implemented, true, `${id} should be engine-ready`);
    assert.ok(
      ALL_ENGINE_STRATEGY_IDS.includes(id),
      `${id} should be listed in ALL_ENGINE_STRATEGY_IDS`,
    );
  }
});

test("sharp-reversal strategies stay silent on a flat, rangebound series (no noise votes)", () => {
  const candles = flatCandles(80);
  const atr = latestAtr(candles);
  for (const id of [
    "rsi_divergence",
    "macd_divergence",
    "climax_exhaustion",
    "stop_run_reversal",
    "failed_breakout",
  ]) {
    assert.equal(
      evaluateStrategy(id, candles, atr, "intraday", { pair: "EURUSD" }),
      null,
      `${id} should not fire on a flat series`,
    );
  }
});

// ---------------------------------------------------------------------------
// W3.3: location scoring wired into scanCandlesForSignal. confluence is now
// baseConfluence * location.multiplier — a continuous discount/premium on
// the same vote set, never a gate (every existing gate above — vote count,
// categories, DIRECTION_MARGIN, stop width — is untouched by this section).
// No prior test in this file asserted an exact confluence number out of
// scanCandlesForSignal, so nothing above needed updating for the multiplier;
// the `confluence: 72` / `confluence: 61` fixtures elsewhere in this file are
// hand-built inputs for signal-learning.ts, not scanCandlesForSignal output.
// ---------------------------------------------------------------------------

/**
 * A false top (10 bars), a real decline to a fresh low (45 bars), then a
 * MODEST recovery (8 bars) that ends on the exact same extension-bar shape
 * trendCandles("long") uses to trigger atr_expansion. The recovery is short
 * enough that the entry lands in the bottom third of its own 60-bar range —
 * the false top plants a range high that survives outside the recovery's
 * reach, the way an older but still-relevant swing high does on a real
 * chart.
 */
function discountEntryCandles(): SignalEngineCandle[] {
  const rows: SignalEngineCandle[] = [];
  const push = (close: number) => {
    const index = rows.length;
    rows.push({
      time: new Date(Date.UTC(2026, 6, 1, 0, index * 5)).toISOString(),
      open: rows.length ? rows[rows.length - 1].close : close,
      high: close + 0.25,
      low: close - 0.25,
      close,
      complete: true,
      volume: 100 + index,
    });
  };
  for (let i = 0; i < 10; i += 1) push(104.5 + Math.sin(i) * 0.05); // plants the range high
  for (let i = 1; i <= 45; i += 1) push(104.5 - i * 0.1); // decline to the range low
  const base = rows[rows.length - 1].close;
  for (let i = 0; i < 8; i += 1) push(base + i * 0.02); // modest recovery — stays low in the range
  const previous = rows[rows.length - 1];
  rows[rows.length - 1] = {
    ...previous,
    open: previous.close,
    low: previous.close - 0.2,
    high: previous.close + 1.8,
    close: previous.close + 1.5,
  }; // same extension-bar shape trendCandles("long") uses to trigger atr_expansion
  return rows;
}

test("W3.3: the same breakout trigger scores lower confluence entered at a premium than at a discount", () => {
  // Same engine configuration for both calls (pair, mode, enabled catalog) —
  // only the price history each trigger sits inside differs.
  const strategyIds = [
    "ema_trend",
    "atr_expansion",
    "donchian_break",
    "bos_choch",
    "liquidity_sweep",
    "climax_exhaustion",
    "stop_run_reversal",
  ];

  const premiumCandles = trendCandles("long"); // a 119-bar uptrend that just extended further
  const premiumLatest = premiumCandles.at(-1)!;
  const premium = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "scalper",
    quote: {
      bid: premiumLatest.close - 0.0001,
      ask: premiumLatest.close + 0.0001,
      mid: premiumLatest.close,
    },
    candles: premiumCandles,
    enabledStrategyIds: strategyIds,
  });

  const discountCandles = discountEntryCandles();
  const discountLatest = discountCandles.at(-1)!;
  const discount = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "scalper",
    quote: {
      bid: discountLatest.close - 0.0001,
      ask: discountLatest.close + 0.0001,
      mid: discountLatest.close,
    },
    candles: discountCandles,
    enabledStrategyIds: strategyIds,
  });

  assert.ok(premium.signal, `expected a premium signal: ${premium.diagnostics.reason}`);
  assert.ok(discount.signal, `expected a discount signal: ${discount.diagnostics.reason}`);
  assert.equal(premium.signal!.direction, "long");
  assert.equal(discount.signal!.direction, "long");

  // Both fire from the SAME core trigger (atr_expansion + donchian_break +
  // bos_choch). The uptrend additionally earns a lagging ema_trend
  // confirmation an established trend has had time to earn and a fresh
  // reversal has not — if anything that gives premium the STRONGER raw vote
  // set. Location still drags its confluence below discount's smaller one.
  for (const id of ["atr_expansion", "donchian_break", "bos_choch"]) {
    assert.ok(premium.signal!.contributingStrategies.includes(id), `premium should include ${id}`);
    assert.ok(
      discount.signal!.contributingStrategies.includes(id),
      `discount should include ${id}`,
    );
  }
  assert.ok(
    premium.signal!.contributingStrategies.length >= discount.signal!.contributingStrategies.length,
    "premium's raw vote set should be at least as strong as discount's",
  );

  assert.ok(premium.signal!.location, "expected a location read on the premium signal");
  assert.ok(discount.signal!.location, "expected a location read on the discount signal");
  assert.equal(premium.signal!.location!.label, "extended premium");
  assert.equal(discount.signal!.location!.label, "discount");
  assert.equal(premium.signal!.location!.chasing, true);
  assert.equal(discount.signal!.location!.chasing, false);
  assert.equal(premium.signal!.location!.swingPosition, 0.931);
  assert.equal(discount.signal!.location!.swingPosition, 0.374);
  assert.equal(premium.signal!.location!.multiplier, 0.698);
  assert.equal(discount.signal!.location!.multiplier, 1.027);

  // Regime shift (documented, not a regression): premium's raw vote set
  // (ema_trend/atr_expansion/donchian_break/bos_choch) sits in a strong_trend
  // (readRegime: ADX 100, efficiency 1.00 — trendCandles is a clean,
  // near-monotonic uptrend). Its baseConfluence saturates at the 95 cap both
  // before and after regime weighting (94 -> 95 and 99.1 -> 95 both clamp the
  // same), so premium's final confluence is unchanged at 66. discountEntryCandles
  // reads as "expansion" instead — its 20-bar efficiencyRatio is only ~0.15
  // (a decline then a partial recovery, not a clean run) despite a high ADX
  // (~88 from the huge final displacement bar), so it fails both trend
  // thresholds and falls to the atrPercentile>=0.85 rule. expansion boosts
  // its all-volatility/breakout/orderflow vote set (atr_expansion x1.15,
  // donchian_break x1.20, bos_choch x1.05), raising baseConfluence from 83 to
  // 89 and, through the SAME location.multiplier (1.027) as before, the
  // final confluence from 85 to 91. The feature under test — premium scores
  // lower than discount purely from location, on an equal-or-stronger raw
  // vote set — still holds; only the absolute discount number moved.
  assert.equal(premium.signal!.regime?.regime, "strong_trend");
  assert.equal(discount.signal!.regime?.regime, "expansion");
  assert.equal(premium.signal!.confluence, 66);
  assert.equal(discount.signal!.confluence, 91);
  assert.ok(
    premium.signal!.confluence < discount.signal!.confluence,
    `expected premium (${premium.signal!.confluence}) < discount (${discount.signal!.confluence})`,
  );
  assert.match(premium.signal!.rationale, /chasing/);
});

// ---------------------------------------------------------------------------
// W3.2: regime classifier wired into scanCandlesForSignal. Vote strength is
// now trustWeight * regimeWeightFor(category, regime) — a second,
// independent re-weighting stacked on top of trust (see regime.test.ts for
// the classifier itself). This section proves the wiring with a single,
// exact, hand-checkable case rather than re-testing the classifier.
// ---------------------------------------------------------------------------

/**
 * A tight, choppy range with a slow (period ~105-bar) undertow superimposed
 * on a fast (period ~7-bar) chop: the fast component keeps ADX/efficiency
 * low (nothing looks like a persistent trend on any 20-bar window) while the
 * slow component drifts the series far enough from its own ~96-bar VWAP that
 * the final bar — a reversion candle back toward the mean — clears
 * vwap_mean_rev's 1.5-ATR extension threshold. readRegime classifies this
 * "range" (adx ~18.7, efficiency ~0.09, atrPercentile ~0.69 — comfortably
 * inside every threshold, not just past one).
 */
function rangeWithExtensionCandles(
  bars = 85,
  slowAmp = 0.8,
  slowFreq = 0.06,
): SignalEngineCandle[] {
  const closes: number[] = [];
  for (let i = 0; i < bars; i += 1) {
    closes.push(
      100 + slowAmp * Math.sin(i * slowFreq) + 0.4 * Math.sin(i * 0.9) + 0.15 * Math.sin(i * 0.37),
    );
  }
  return closes.map((close, index) => {
    const prevClose = index > 0 ? closes[index - 1] : close;
    return {
      time: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
      open: prevClose,
      close,
      high: Math.max(prevClose, close) + 0.1,
      low: Math.min(prevClose, close) - 0.1,
      complete: true,
      volume: 100,
    };
  });
}

test("W3.2: a mean_reversion vote's contribution is damped in a strong trend and boosted in a range, for the identical raw vote", () => {
  // vwap_mean_rev's strength formula is `min(75, 55 + distance * 12)` — both
  // fixtures below push `distance` well past the point where it saturates at
  // the 75 cap, so the RAW (regime-independent) vote is exactly 75 in both
  // cases. This isolates regime as the only thing that can make the
  // CONTRIBUTED strength differ between them.
  const trendCandlesFixture = pullbackFromHighCandles(0.7); // strong_trend/long (same fixture as the BUG D/regime tests above)
  const rangeCandlesFixture = rangeWithExtensionCandles();

  const trendLatest = trendCandlesFixture.at(-1)!;
  const trendAtr = latestAtr(trendCandlesFixture);
  const trendRawVote = evaluateStrategy(
    "vwap_mean_rev",
    trendCandlesFixture,
    trendAtr,
    "intraday",
    { pair: "EURUSD" },
  );
  const trendResult = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "intraday",
    timeframe: "M15",
    quote: {
      bid: trendLatest.close - 0.0001,
      ask: trendLatest.close + 0.0001,
      mid: trendLatest.close,
    },
    candles: trendCandlesFixture,
    enabledStrategyIds: ["vwap_mean_rev"],
  });

  const rangeLatest = rangeCandlesFixture.at(-1)!;
  const rangeAtr = latestAtr(rangeCandlesFixture);
  const rangeRawVote = evaluateStrategy(
    "vwap_mean_rev",
    rangeCandlesFixture,
    rangeAtr,
    "intraday",
    { pair: "EURUSD" },
  );
  const rangeResult = scanCandlesForSignal({
    pair: "EURUSD",
    mode: "intraday",
    timeframe: "M15",
    quote: {
      bid: rangeLatest.close - 0.0001,
      ask: rangeLatest.close + 0.0001,
      mid: rangeLatest.close,
    },
    candles: rangeCandlesFixture,
    enabledStrategyIds: ["vwap_mean_rev"],
  });

  // Same raw vote magnitude in both cases — the only free variable is regime.
  assert.ok(trendRawVote && rangeRawVote, "expected vwap_mean_rev to fire on both fixtures");
  assert.equal(trendRawVote!.strength, 75);
  assert.equal(rangeRawVote!.strength, 75);
  assert.equal(trendRawVote!.category, "mean_reversion");
  assert.equal(rangeRawVote!.category, "mean_reversion");

  const trendContribution = trendResult.diagnostics.votes.find(
    (v) => v.strategyId === "vwap_mean_rev",
  )!;
  const rangeContribution = rangeResult.diagnostics.votes.find(
    (v) => v.strategyId === "vwap_mean_rev",
  )!;
  assert.ok(
    trendContribution,
    "expected a vwap_mean_rev entry in the strong-trend scan diagnostics",
  );
  assert.ok(rangeContribution, "expected a vwap_mean_rev entry in the range scan diagnostics");

  // The observable outcome: identical raw strength, damped in a strong trend
  // (x0.65), boosted in a range (x1.25) — mean_reversion's exact table values.
  assert.equal(trendContribution.strength, 48.75);
  assert.equal(rangeContribution.strength, 93.75);
  assert.ok(
    trendContribution.strength < trendRawVote!.strength,
    "a mean_reversion vote in a strong trend should contribute LESS than its raw strength",
  );
  assert.ok(
    rangeContribution.strength > rangeRawVote!.strength,
    "a mean_reversion vote in a range should contribute MORE than its raw strength",
  );
  assert.ok(
    trendContribution.strength < rangeContribution.strength,
    `expected the strong-trend contribution (${trendContribution.strength}) to be damped relative to the same vote's contribution in a range (${rangeContribution.strength})`,
  );
});

// ---------------------------------------------------------------------------
// W3.1 — correlated-vote clustering, asserted through the ENGINE path.
//
// strategy-clusters.test.ts covers the rollup maths in isolation. This one
// exists because that is not enough: a cluster map can be perfectly correct and
// still be wired in inertly, and the suite would stay green while confluence
// went on double-counting. Passing an identity map (every strategy its own
// cluster) reproduces the pre-W3.1 arithmetic, so the delta is the feature.
// ---------------------------------------------------------------------------

function clusterFixtureCandles() {
  const bar = (t: number, price: number, wick: number) => ({
    time: new Date(Date.UTC(2026, 0, 1, 0, t)).toISOString(),
    open: price,
    high: price + wick,
    low: price - wick,
    close: price,
    complete: true,
    volume: 1000,
  });
  const candles = [];
  let t = 0;
  let price = 100;
  for (let i = 0; i < 160; i += 1) candles.push(bar(t++, (price += 0.3), 0.18));
  for (let i = 0; i < 20; i += 1) candles.push(bar(t++, (price -= 0.06), 0.1));
  for (let i = 0; i < 14; i += 1) candles.push(bar(t++, (price += 0.05), 0.08));
  return candles;
}

test("W3.1: clustering is actually wired into confluence, not merely available", () => {
  const candles = clusterFixtureCandles();
  const latest = candles.at(-1)!;
  const enabledStrategyIds = [...ALL_ENGINE_STRATEGY_IDS];
  const base = {
    pair: "EURUSD",
    mode: "intraday" as const,
    timeframe: "M15" as const,
    quote: { bid: latest.close - 0.01, ask: latest.close + 0.01, mid: latest.close },
    candles,
    enabledStrategyIds,
    // Regime off so the only difference between the two runs is the cluster map.
    regimeOverride: "none" as const,
  };

  const clustered = scanCandlesForSignal(base);
  const unclustered = scanCandlesForSignal({
    ...base,
    clusterMap: Object.fromEntries(enabledStrategyIds.map((id) => [id, id])),
  });

  assert.ok(clustered.signal, `expected a signal: ${clustered.diagnostics.reason}`);
  assert.ok(unclustered.signal, `expected a signal: ${unclustered.diagnostics.reason}`);

  // This fixture fires ema_trend + heiken_ashi_scalp (both ma_trend) alongside
  // rsi_momo, so three votes collapse to two clusters.
  assert.ok(
    unclustered.signal!.confluence > clustered.signal!.confluence,
    `clustering must discount the duplicated read: ${unclustered.signal!.confluence} vs ${clustered.signal!.confluence}`,
  );
  assert.equal(
    clustered.signal!.direction,
    unclustered.signal!.direction,
    "clustering prices confidence, it must not flip the direction",
  );
});

test("W3.1: a signal carried by genuinely independent reads is unaffected by clustering", () => {
  const candles = clusterFixtureCandles();
  const latest = candles.at(-1)!;
  // One strategy per cluster: nothing to pool, so both paths must agree exactly.
  const enabledStrategyIds = ["ema_trend", "rsi_momo", "donchian_break"];
  const base = {
    pair: "EURUSD",
    mode: "intraday" as const,
    timeframe: "M15" as const,
    quote: { bid: latest.close - 0.01, ask: latest.close + 0.01, mid: latest.close },
    candles,
    enabledStrategyIds,
    regimeOverride: "none" as const,
  };
  const clustered = scanCandlesForSignal(base);
  const unclustered = scanCandlesForSignal({
    ...base,
    clusterMap: Object.fromEntries(enabledStrategyIds.map((id) => [id, id])),
  });
  assert.equal(
    clustered.signal?.confluence ?? null,
    unclustered.signal?.confluence ?? null,
    "distinct reads must score identically either way",
  );
});

// ---------------------------------------------------------------------------
// Injectable clock — a replay correctness fix, not just a testability one.
//
// evaluateNewsReactive and evaluateAiConfluence judge "is a release imminent"
// and "how stale is this COT report" against a reference time. Reading
// Date.now() internally meant a BACKTEST walking bars from two years ago was
// asking whether a release is imminent TODAY, and aging a COT report against
// today rather than against the bar. Both answers were wrong for every
// replayed bar, silently.
// ---------------------------------------------------------------------------

test("clock injection: news_reactive judges imminence against the supplied time, not the wall clock", () => {
  const candles = trendCandles("long");
  const atr = latestAtr(candles);
  // A release 30 minutes after the fixture's last bar — imminent for that bar,
  // and long past (or far future) relative to whenever this suite runs.
  const barMs = Date.parse(candles.at(-1)!.time);
  const macro = {
    events: [
      {
        currency: "USD",
        title: "CPI",
        impact: "High",
        time: "12:30",
        timestamp: barMs + 30 * 60 * 1000,
      },
    ],
    cot: null,
  };

  const atBar = evaluateStrategy("news_reactive", candles, atr, "intraday", {
    pair: "EURUSD",
    macro,
    now: barMs,
  });
  const atWallClock = evaluateStrategy("news_reactive", candles, atr, "intraday", {
    pair: "EURUSD",
    macro,
    now: barMs + 400 * 24 * 60 * 60 * 1000, // more than a year later
  });

  assert.ok(atBar, "the release is 30 minutes ahead of the bar being scanned");
  assert.equal(atWallClock, null, "the same event is ancient history a year later");
});

test("clock injection: COT age is measured from the supplied time", () => {
  const candles = trendCandles("long");
  const atr = latestAtr(candles);
  const barMs = Date.parse(candles.at(-1)!.time);
  const reportDate = new Date(barMs - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const macro = { events: [], cot: { net: 5000, netPct: 32, reportDate } };

  const fresh = evaluateStrategy("ai_confluence", candles, atr, "intraday", {
    pair: "EURUSD",
    macro,
    now: barMs,
  });
  const stale = evaluateStrategy("ai_confluence", candles, atr, "intraday", {
    pair: "EURUSD",
    macro,
    now: barMs + 30 * 24 * 60 * 60 * 1000,
  });

  assert.ok(fresh, "two days old relative to the bar is well inside the 14-day cutoff");
  assert.equal(stale, null, "32 days old must abstain, however recent the wall clock is");
});

test("clock injection: the scan derives its clock from the last complete bar", () => {
  // A clean advance, so news_reactive's 3-bar impulse gate is clearly cleared —
  // trendCandles ends on a red pullback bar by design, which suppresses it.
  const candles = Array.from({ length: 120 }, (_, index) => {
    const price = 1.1 + index * 0.0004;
    return {
      time: new Date(Date.UTC(2026, 6, 1, 0, index * 5)).toISOString(),
      open: price,
      high: price + 0.0003,
      low: price - 0.0003,
      close: price,
      complete: true,
      volume: 1000,
    };
  });
  const latest = candles.at(-1)!;
  const barMs = Date.parse(latest.time);
  const macro = {
    events: [
      {
        currency: "USD",
        title: "CPI",
        impact: "High" as const,
        time: "12:30",
        timestamp: barMs + 20 * 60 * 1000,
      },
    ],
    cot: null,
  };
  const run = () =>
    scanCandlesForSignal({
      pair: "EURUSD",
      mode: "intraday",
      // M15: news_reactive is declared on ["M15","H1","H4"], so M5 would be
      // filtered as incompatible before the clock ever mattered.
      timeframe: "M15",
      quote: { bid: latest.close - 0.0001, ask: latest.close + 0.0001, mid: latest.close },
      candles,
      enabledStrategyIds: ["ema_trend", "rsi_momo", "news_reactive"],
      macro,
      regimeOverride: "none",
    });
  assert.deepEqual(
    run()
      .diagnostics.votes.map((v) => v.strategyId)
      .sort(),
    run()
      .diagnostics.votes.map((v) => v.strategyId)
      .sort(),
    "a scan must be a pure function of its candles and macro, not of when it ran",
  );
  assert.ok(
    run().diagnostics.votes.some((v) => v.strategyId === "news_reactive"),
    "news_reactive should fire: the event is 20 minutes after the bar being scanned",
  );
});
