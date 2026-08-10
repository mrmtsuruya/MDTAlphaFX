import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const StrategyEnum = z.enum([
  "ema_trend",
  "macd_hist",
  "rsi_meanrev",
  "bollinger_squeeze",
  "donchian_breakout",
  "supertrend",
  "ichimoku",
]);

const RunInput = z.object({
  pair: z.string().min(3).max(10),
  strategy: StrategyEnum,
  bars: z.number().int().min(200).max(20000).default(2000),
  params: z.record(z.string(), z.number()).optional(),
  monteCarloSims: z.number().int().min(0).max(2000).default(500),
  ruinR: z.number().min(1).max(100).default(10),
});

export const runBacktestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RunInput.parse(input))
  .handler(async ({ data }) => {
    const { runBacktest, monteCarlo } = await import("@/lib/backtest-engine.server");
    const result = runBacktest(data.pair, data.strategy, data.bars, data.params ?? {});
    const mc =
      data.monteCarloSims > 0 && result.trades.length > 5
        ? monteCarlo(result.trades, data.monteCarloSims, data.ruinR)
        : null;
    return {
      ...result,
      trades: result.trades.slice(-200),
      monteCarlo: mc,
    };
  });

const OptimizeInput = z.object({
  pair: z.string().min(3).max(10),
  strategy: StrategyEnum,
  bars: z.number().int().min(200).max(20000).default(2000),
});

export const optimizeStrategyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => OptimizeInput.parse(input))
  .handler(async ({ data }) => {
    const { optimize } = await import("@/lib/backtest-engine.server");
    return optimize(data.pair, data.strategy, data.bars);
  });

// Walk-forward league table: scores every engine-implemented strategy
// out-of-sample on REAL candles from the live feed for a pair, producing the
// trust weights the scanner auto-applies (strategies below the floor are
// excluded from signals).
const WalkForwardInput = z.object({
  pair: z.string().min(3).max(10),
  timeframe: z.enum(["M5", "H1"]).default("H1"),
});

export const walkForwardScoreFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => WalkForwardInput.parse(input))
  .handler(async ({ data }) => {
    const { fetchMarketCandles } = await import("@/lib/market-data.server");
    const { computeStrategyWeights } = await import("@/lib/strategy-weights");
    const candles = await fetchMarketCandles(data.pair, data.timeframe, 500);
    // M5 scores the scalper-tuned engine, H1 the intraday-tuned engine — the
    // league table then mirrors exactly how live signals run per mode.
    const mode = data.timeframe === "M5" ? "scalper" : "intraday";
    const { weights, report } = computeStrategyWeights(candles, data.timeframe, mode);
    return {
      pair: data.pair,
      timeframe: data.timeframe,
      mode,
      weights,
      report,
    };
  });

// Honest, real-candle backtest of the LIVE signal engine (scanCandlesForSignal,
// all 31 strategies) — see src/lib/real-backtest.ts for the full methodology.
// Unlike runBacktestFn above, this fetches REAL candles once and replays the
// actual scanner bar-by-bar, reporting in-sample vs. out-of-sample separately.
const RealBacktestInput = z.object({
  pair: z.string().min(3).max(10),
  timeframe: z.enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1"]).default("H1"),
  bars: z.number().int().min(120).max(2000).default(720),
});

export const runRealBacktestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => RealBacktestInput.parse(input))
  .handler(async ({ data }) => {
    const { runRealBacktestForPair } = await import("@/lib/real-backtest.server");
    return runRealBacktestForPair(data.pair, data.timeframe, data.bars);
  });
