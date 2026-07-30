import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const StrategyEnum = z.enum([
  "ema_trend", "macd_hist", "rsi_meanrev", "bollinger_squeeze",
  "donchian_breakout", "supertrend", "ichimoku",
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
    const mc = data.monteCarloSims > 0 && result.trades.length > 5
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
