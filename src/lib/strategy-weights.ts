// Walk-forward strategy trust scoring.
//
// For each implemented engine strategy we replay it bar-by-bar over the last
// portion of the real candle series (the "test" window; the earlier bars are
// the "train" window that warms the indicators). A vote is correct when price
// moved in the voted direction over the next N bars. The observed accuracy
// becomes a trust weight (0.15 .. 1.15) that the engine multiplies into that
// strategy's vote strength, and strategies that demonstrably fail on recent
// data (weight < 0.4) stop contributing to signals — the auto-downweight the
// user asked for. No extra fetches: it runs on the same candles a scan uses.

import {
  DOWNWEIGHT_FLOOR,
  evaluateStrategy,
  latestAtr,
  type SignalEngineCandle,
  type SignalMode,
  type SignalTimeframe,
} from "./signal-engine.ts";

export type StrategyWeightReport = {
  generatedFor: { bars: number; testBars: number; horizon: number };
  entries: {
    strategyId: string;
    votes: number;
    wins: number;
    accuracy: number;
    weight: number;
    downweighted: boolean;
  }[];
};

/** Maps a directional accuracy (0..1) onto a vote-strength multiplier. */
export function accuracyToWeight(accuracy: number): number {
  const raw = accuracy * 2 - 0.4; // 0.50 -> 0.60, 0.70 -> 1.00, 0.80 -> 1.20
  return Math.min(1.15, Math.max(0.15, raw));
}

const STRATEGY_ORDER = [
  "ema_trend",
  "supertrend",
  "ma_ribbon",
  "ichimoku",
  "rsi_momo",
  "macd_hist",
  "stoch_rsi",
  "cci_extreme",
  "bollinger_squeeze",
  "keltner_break",
  "donchian_break",
  "atr_expansion",
  "liquidity_sweep",
  "fvg",
  "order_block",
  "bos_choch",
  "vwap_mean_rev",
  "sr_confluence",
  "london_killzone",
  "opening_range_breakout",
  "heiken_ashi_scalp",
  "qullamaggie_breakout",
  "trendline_break",
  "fib_retracement",
  "ny_killzone",
  "asian_range",
  "gartley",
  "bat_pattern",
  "butterfly_pattern",
  "news_reactive",
  "ai_confluence",
  "rsi_divergence",
  "macd_divergence",
  "climax_exhaustion",
  "stop_run_reversal",
  "failed_breakout",
];

// Lookahead horizon scales with the timeframe: ~30 minutes of forward price
// on scalps, ~3-6 bars on swings.
const HORIZON_BARS: Record<SignalTimeframe, number> = {
  M1: 12,
  M5: 6,
  M15: 4,
  M30: 3,
  H1: 3,
  H4: 2,
  D1: 2,
};

export function computeStrategyWeights(
  candles: SignalEngineCandle[],
  timeframe: SignalTimeframe,
  mode: SignalMode = "intraday",
): { weights: Record<string, number>; report: StrategyWeightReport } {
  const complete = candles.filter((candle) => candle.complete);
  const weights: Record<string, number> = {};
  const horizon = HORIZON_BARS[timeframe] ?? 3;

  // Train window: enough bars to warm every indicator (~60). Test window: the
  // remainder, but we need lookahead room so cap it.
  const trainSize = Math.min(complete.length - 1, Math.floor(complete.length * 0.6));
  const entries: StrategyWeightReport["entries"] = [];

  if (trainSize < 60) {
    for (const strategyId of STRATEGY_ORDER) weights[strategyId] = 1;
    return { weights, report: { generatedFor: { bars: complete.length, testBars: 0, horizon }, entries } };
  }

  for (const strategyId of STRATEGY_ORDER) {
    let votes = 0;
    let wins = 0;
    // Start past the indicator warmup (55 bars covers EMA55/ichimoku 52).
    for (let index = Math.max(trainSize, 55); index < complete.length - horizon; index += 1) {
      const window = complete.slice(0, index + 1);
      let atr: number;
      try {
        atr = latestAtr(window, 14);
      } catch {
        continue;
      }
      const vote = evaluateStrategy(strategyId, window, atr, mode);
      if (!vote) continue;
      const future = complete[index + horizon];
      const movedUp = future.close > complete[index].close;
      const movedDown = future.close < complete[index].close;
      votes += 1;
      if (vote.direction === "long" && movedUp) wins += 1;
      if (vote.direction === "short" && movedDown) wins += 1;
    }

    const accuracy = votes > 0 ? wins / votes : 0.5;
    // A strategy that never voted on the test window is NEUTRAL (1.0), not a
    // 0.5-accuracy coin flip (0.6) — abstention is not failure. This matters
    // for macro-only strategies (news_reactive, ai_confluence) and rare
    // patterns (harmonics), which abstain without the macro overlay.
    const weight = votes > 0 ? accuracyToWeight(accuracy) : 1;
    weights[strategyId] = weight;
    entries.push({
      strategyId,
      votes,
      wins,
      accuracy: +accuracy.toFixed(3),
      weight: +weight.toFixed(2),
      // Must match the engine's exclusion exactly (scanCandlesForSignal uses
      // weight < DOWNWEIGHT_FLOOR with no vote minimum), so the league table
      // never shows a strategy as active while the engine silently drops it.
      // An 8-vote minimum on the report side made the two disagree.
      downweighted: weight < DOWNWEIGHT_FLOOR,
    });
  }

  return {
    weights,
    report: {
      generatedFor: {
        bars: complete.length,
        testBars: Math.max(0, complete.length - trainSize),
        horizon,
      },
      entries,
    },
  };
}

/** All engine-implemented strategy ids in walk-forward evaluation order. */
export const ALL_ENGINE_STRATEGY_IDS: readonly string[] = STRATEGY_ORDER;
