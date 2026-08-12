// Keyless XAUUSD market-data provider for the auto-paper worker.
//
// Serves the same free, account-free feeds the dashboard quote strip and Live
// Chart use:
//   - quotes  -> TradingView scanner REST API (scanner.tradingview.com), which
//                serves OANDA's own retail XAUUSD feed (real bid/ask, no key)
//   - candles -> Yahoo Finance chart API (GC=F, COMEX gold futures) rebased
//                onto the live OANDA spot level, exactly like
//                market-data.server.ts
//
// The worker contract demands TWO-SIDED candles (bid AND ask OHLC) so the
// side-aware fills stay honest. The keyless feeds only expose mid/futures
// OHLC plus a live spread, so this provider synthesizes the sides:
//   bid = mid - spread/2, ask = mid + spread/2
// using the spread observed on the live TradingView quote. Ordering
// invariants (high >= max(open, close), low <= min(open, close)) are
// preserved because a constant shift is applied to all four OHLC values.
//
// Every failure throws a stable KeylessFeedError code so the worker records a
// machine-readable degraded state and fails closed.

import type {
  NativeXauusdQuote,
  PaperTimeframe,
  TwoSidedCandle,
  XauusdMarketDataProvider,
} from "./xauusd-market-data.ts";

const TV_CFD_SCAN = "https://scanner.tradingview.com/cfd/scan";
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const YAHOO_SYMBOL = "GC=F";
const TV_SYMBOL = "OANDA:XAUUSD";
const INSTRUMENT = "XAU_USD";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type KeylessFeedErrorCode =
  | "feed_unavailable"
  | "quote_unavailable"
  | "candles_unavailable"
  | "malformed_response";

export class KeylessFeedError extends Error {
  readonly code: KeylessFeedErrorCode;

  constructor(code: KeylessFeedErrorCode, message: string) {
    super(message);
    this.name = "KeylessFeedError";
    this.code = code;
  }
}

// Nominal candle interval per paper timeframe, and the Yahoo request that
// yields enough completed bars to survive a weekend gap (M1/M5 use 5d ranges;
// the worker needs ~400 completed bars for a scan).
const TF_SECONDS: Record<PaperTimeframe, number> = {
  M1: 60,
  M5: 5 * 60,
  M15: 15 * 60,
  M30: 30 * 60,
  H1: 60 * 60,
  H4: 4 * 60 * 60,
  D1: 24 * 60 * 60,
};

const TF_YAHOO: Record<PaperTimeframe, { interval: string; range: string; seconds: number }> = {
  M1: { interval: "1m", range: "5d", seconds: 60 },
  M5: { interval: "5m", range: "5d", seconds: 300 },
  M15: { interval: "15m", range: "1mo", seconds: 900 },
  M30: { interval: "30m", range: "1mo", seconds: 1800 },
  H1: { interval: "1h", range: "1mo", seconds: 3600 },
  H4: { interval: "1h", range: "3mo", seconds: 14_400 },
  D1: { interval: "1d", range: "1y", seconds: 86_400 },
};

type TvScanRow = { s: string; d: (string | number | null)[] };

const TV_COLUMNS = [
  "name",
  "close",
  "bid",
  "ask",
  "high",
  "low",
  "open",
  "change",
  "volume",
  "pricescale",
  "update_mode",
  "description",
];

function parseNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new KeylessFeedError(
      "malformed_response",
      `malformed numeric ${field}: ${JSON.stringify(value)}`,
    );
  }
  return n;
}

export function createTvKeylessXauusdProvider(
  config: { now?: () => Date } = {},
  fetchImpl: typeof fetch = fetch,
): XauusdMarketDataProvider {
  const now = config.now ?? (() => new Date());

  // Cache the live quote for up to 30s so the per-minute cycle does not pound
  // the scanner with one request per candle fetch.
  let cachedQuote: { at: number; quote: NativeXauusdQuote } | null = null;
  const QUOTE_CACHE_MS = 30_000;

  async function tvQuote(): Promise<NativeXauusdQuote> {
    const receivedAt = now().toISOString();
    let response: Response;
    try {
      response = await fetchImpl(TV_CFD_SCAN, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://www.tradingview.com",
          "User-Agent": BROWSER_UA,
        },
        body: JSON.stringify({ symbols: { tickers: [TV_SYMBOL] }, columns: TV_COLUMNS }),
      });
    } catch {
      throw new KeylessFeedError("feed_unavailable", "TradingView feed request failed");
    }
    if (!response.ok) {
      throw new KeylessFeedError(
        "feed_unavailable",
        `TradingView feed returned HTTP ${response.status}`,
      );
    }
    let payload: { data?: TvScanRow[] };
    try {
      payload = (await response.json()) as { data?: TvScanRow[] };
    } catch {
      throw new KeylessFeedError("malformed_response", "non-JSON TradingView response");
    }
    const row = payload.data?.find((r) => r.s === TV_SYMBOL);
    if (!row) {
      throw new KeylessFeedError("quote_unavailable", `no TradingView row for ${TV_SYMBOL}`);
    }
    const close = row.d[1] == null ? Number.NaN : Number(row.d[1]);
    const bid = row.d[2] == null ? close : Number(row.d[2]);
    const ask = row.d[3] == null ? close : Number(row.d[3]);
    if (!Number.isFinite(close) || !Number.isFinite(bid) || !Number.isFinite(ask)) {
      throw new KeylessFeedError("quote_unavailable", "TradingView row has no usable price");
    }
    if (ask <= bid) {
      throw new KeylessFeedError("quote_unavailable", `ask ${ask} is not above bid ${bid}`);
    }
    return {
      provider: "TV_OANDA_FEED",
      instrument: INSTRUMENT,
      bid,
      ask,
      providerTime: receivedAt,
      receivedAt,
      tradeable: true,
    };
  }

  async function quote(): Promise<NativeXauusdQuote> {
    if (cachedQuote && now().getTime() - cachedQuote.at < QUOTE_CACHE_MS) {
      return cachedQuote.quote;
    }
    const fetched = await tvQuote();
    cachedQuote = { at: now().getTime(), quote: fetched };
    return fetched;
  }

  function parseYahooChart(
    payload: unknown,
    timeframe: PaperTimeframe,
  ): { time: string; open: number; high: number; low: number; close: number }[] {
    const result = (
      payload as {
        chart?: {
          result?: {
            timestamp?: number[];
            indicators?: {
              quote?: {
                open?: (number | null)[];
                high?: (number | null)[];
                low?: (number | null)[];
                close?: (number | null)[];
              }[];
            };
          }[];
        };
      }
    )?.chart?.result?.[0];
    const timestamps = result?.timestamp;
    const quote = result?.indicators?.quote?.[0];
    if (!timestamps || !quote) {
      throw new KeylessFeedError("candles_unavailable", `no Yahoo candle data for ${timeframe}`);
    }
    const bars: { time: string; open: number; high: number; low: number; close: number }[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const close = quote.close?.[i];
      if (close == null) continue; // Yahoo emits nulls for market gaps
      bars.push({
        time: new Date(timestamps[i] * 1000).toISOString(),
        open: Number(quote.open?.[i] ?? close),
        high: Number(quote.high?.[i] ?? close),
        low: Number(quote.low?.[i] ?? close),
        close: Number(close),
      });
    }
    if (bars.length === 0) {
      throw new KeylessFeedError(
        "candles_unavailable",
        `no completed Yahoo candles for ${timeframe}`,
      );
    }
    return bars;
  }

  // H4 has no native Yahoo interval; bucket 1h bars into UTC-aligned 4-hour
  // windows (the same way MT5/TradingView build an H4 series).
  function bucketCandles(
    candles: { time: string; open: number; high: number; low: number; close: number }[],
    bucketSeconds: number,
  ): { time: string; open: number; high: number; low: number; close: number }[] {
    const buckets = new Map<
      number,
      { time: string; open: number; high: number; low: number; close: number }
    >();
    for (const candle of candles) {
      const timeSec = Math.floor(Date.parse(candle.time) / 1000);
      const bucketStart = Math.floor(timeSec / bucketSeconds) * bucketSeconds;
      const existing = buckets.get(bucketStart);
      if (!existing) {
        buckets.set(bucketStart, {
          ...candle,
          time: new Date(bucketStart * 1000).toISOString(),
        });
      } else {
        existing.high = Math.max(existing.high, candle.high);
        existing.low = Math.min(existing.low, candle.low);
        existing.close = candle.close;
      }
    }
    return [...buckets.values()].sort((a, b) => a.time.localeCompare(b.time));
  }

  // Range-based fetch (survives weekend gaps): used for full candle sets.
  async function fetchYahooRange(
    timeframe: PaperTimeframe,
  ): Promise<{ time: string; open: number; high: number; low: number; close: number }[]> {
    const { interval, range } = TF_YAHOO[timeframe];
    const url = `${YAHOO_CHART}/${YAHOO_SYMBOL}?interval=${interval}&range=${range}`;
    const payload = await yahooFetch(url, timeframe);
    let bars = parseYahooChart(payload, timeframe);
    if (timeframe === "H4") {
      bars = bucketCandles(bars, TF_SECONDS.H4);
    }
    return bars;
  }

  // Span-based fetch (period1/period2): light, used only to discover the last
  // completed candle time per timeframe.
  async function fetchYahooSpan(
    timeframe: PaperTimeframe,
    spanSeconds: number,
  ): Promise<{ time: string; open: number; high: number; low: number; close: number }[]> {
    const interval = TF_YAHOO[timeframe].interval;
    const nowSec = Math.floor(now().getTime() / 1000);
    const period2 = Math.floor(nowSec / TF_SECONDS[timeframe]) * TF_SECONDS[timeframe];
    const period1 = period2 - spanSeconds;
    const url = `${YAHOO_CHART}/${YAHOO_SYMBOL}?interval=${interval}&period1=${period1}&period2=${period2}`;
    const payload = await yahooFetch(url, timeframe);
    let bars = parseYahooChart(payload, timeframe);
    if (timeframe === "H4") {
      bars = bucketCandles(bars, TF_SECONDS.H4);
    }
    return bars;
  }

  async function yahooFetch(url: string, timeframe: PaperTimeframe): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      });
    } catch {
      throw new KeylessFeedError("feed_unavailable", `Yahoo feed request failed for ${timeframe}`);
    }
    if (!response.ok) {
      throw new KeylessFeedError(
        "feed_unavailable",
        `Yahoo feed returned HTTP ${response.status} for ${timeframe}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new KeylessFeedError("malformed_response", `non-JSON Yahoo response for ${timeframe}`);
    }
  }

  async function completedCandles(
    timeframe: PaperTimeframe,
    count: number,
  ): Promise<TwoSidedCandle[]> {
    const bars = await fetchYahooRange(timeframe);
    const liveQuote = await quote();
    const spread = liveQuote.ask - liveQuote.bid;
    const half = spread / 2;

    // Rebase COMEX futures onto the live OANDA spot level so the engine's
    // structure stop is computed in the same space as the entry quote.
    const spotMid = (liveQuote.bid + liveQuote.ask) / 2;
    const lastClose = bars[bars.length - 1].close;
    const delta = Number.isFinite(spotMid) && Number.isFinite(lastClose) ? spotMid - lastClose : 0;

    const seconds = TF_SECONDS[timeframe];
    const nowSec = now().getTime() / 1000;
    const complete: TwoSidedCandle[] = bars
      .filter((bar) => Math.floor(Date.parse(bar.time) / 1000) + seconds <= nowSec)
      .map((bar) => ({
        instrument: "XAU_USD",
        timeframe,
        time: bar.time,
        bid: {
          open: bar.open + delta - half,
          high: bar.high + delta - half,
          low: bar.low + delta - half,
          close: bar.close + delta - half,
        },
        ask: {
          open: bar.open + delta + half,
          high: bar.high + delta + half,
          low: bar.low + delta + half,
          close: bar.close + delta + half,
        },
        volume: 0,
        complete: true,
      }));
    if (complete.length === 0) {
      throw new KeylessFeedError(
        "candles_unavailable",
        `no completed ${timeframe} candles from the keyless feed`,
      );
    }
    return complete.slice(-count);
  }

  async function latestCompleted(
    timeframes: PaperTimeframe[],
  ): Promise<Record<PaperTimeframe, string | null>> {
    const result = Object.fromEntries(timeframes.map((tf) => [tf, null])) as Record<
      PaperTimeframe,
      string | null
    >;
    await Promise.all(
      timeframes.map(async (timeframe) => {
        try {
          const bars = await fetchYahooSpan(timeframe, Math.max(TF_SECONDS[timeframe] * 5, 300));
          const seconds = TF_SECONDS[timeframe];
          const nowSec = now().getTime() / 1000;
          let lastComplete: string | null = null;
          for (let i = bars.length - 1; i >= 0; i--) {
            if (Math.floor(Date.parse(bars[i].time) / 1000) + seconds <= nowSec) {
              lastComplete = bars[i].time;
              break;
            }
          }
          if (lastComplete) result[timeframe] = lastComplete;
        } catch {
          // A single timeframe failing must not sink the whole pass; the
          // worker simply skips that timeframe this cycle.
        }
      }),
    );
    return result;
  }

  async function health(): Promise<{ ok: boolean; code: string; checkedAt: string }> {
    const checkedAt = now().toISOString();
    try {
      await quote();
      return { ok: true, code: "ok", checkedAt };
    } catch (err) {
      return {
        ok: false,
        code: err instanceof KeylessFeedError ? err.code : "malformed_response",
        checkedAt,
      };
    }
  }

  return { health, quote, latestCompleted, completedCandles };
}
