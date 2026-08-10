import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  fetchMarketCandles,
  fetchMarketQuotes,
  getMarketProviderStatus,
  MARKET_PAIRS,
  MARKET_TIMEFRAMES,
} from "@/lib/market-data.server";

const QuotesInput = z.object({
  pairs: z.array(z.enum(MARKET_PAIRS)).min(1).max(MARKET_PAIRS.length),
});

export const getMarketDataStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => getMarketProviderStatus());

export const getMarketQuotes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => QuotesInput.parse(input))
  .handler(async ({ data }) => ({
    status: getMarketProviderStatus(),
    quotes: await fetchMarketQuotes(data.pairs),
  }));

const CandlesInput = z.object({
  pair: z.enum(MARKET_PAIRS),
  granularity: z.enum(MARKET_TIMEFRAMES),
  count: z.number().int().min(10).max(500).optional(),
});

export const getMarketCandles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => CandlesInput.parse(input))
  .handler(async ({ data }) => ({
    candles: await fetchMarketCandles(data.pair, data.granularity, data.count ?? 300),
  }));
