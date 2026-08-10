// Server-only entry point for the real-data backtest harness (real-backtest.ts).
//
// Fetches candles ONCE from the live feed (market-data.server.ts, shared
// token bucket: 30 capacity, 1/sec refill) and hands the single array to the
// pure harness. The harness itself never calls fetchMarketCandles — every
// strategy and every walk-forward step replays the SAME in-memory array.

import { fetchMarketCandles, type MarketTimeframe } from "./market-data.server.ts";
import { runRealBacktest, type RealBacktestReport } from "./real-backtest.ts";
import { ALL_ENGINE_STRATEGY_IDS } from "./strategy-weights.ts";
import type { SignalEngineCandle, SignalMode } from "./signal-engine.ts";

const SCALP_TIMEFRAMES = new Set<MarketTimeframe>(["M1", "M5", "M15", "M30"]);

function modeForTimeframe(timeframe: MarketTimeframe): SignalMode {
  return SCALP_TIMEFRAMES.has(timeframe) ? "scalper" : "intraday";
}

export async function runRealBacktestForPair(
  pair: string,
  timeframe: MarketTimeframe,
  count = 720,
  trainFraction = 0.6,
): Promise<RealBacktestReport> {
  const marketCandles = await fetchMarketCandles(pair, timeframe, count);
  const candles: SignalEngineCandle[] = marketCandles.map((candle) => ({
    time: candle.time,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    complete: candle.complete,
    volume: candle.volume,
  }));
  const mode = modeForTimeframe(timeframe);
  return runRealBacktest({
    pair,
    mode,
    timeframe,
    candles,
    strategyIds: [...ALL_ENGINE_STRATEGY_IDS],
    trainFraction,
  });
}
