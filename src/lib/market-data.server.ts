// Free, keyless, retail-grade real-time market data provider.
//
// Quotes  -> TradingView scanner REST API (scanner.tradingview.com). TradingView
//            serves OANDA's own retail feed for these symbols (the same feed the
//            Live Chart widget uses), so bid/ask prices track retail brokers
//            (Vantage, XM, JustMarkets, …) within a couple of pips — far closer
//            than exchange-derived proxies. Real bid/ask, `update_mode: streaming`.
// Candles -> Yahoo Finance chart API (query1.finance.yahoo.com) — real OHLC
//            candles for every pair. Gold uses COMEX futures (GC=F) rebased onto
//            the live OANDA spot level so structure stops stay coherent with the
//            spot quote (the strategies are shift-invariant, so a constant rebase
//            preserves every computation).
//
// No API key required, same exported signatures as the previous providers.

export const MARKET_PAIRS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "USDCHF",
  "EURGBP",
  "EURJPY",
  "GBPJPY",
  "AUDJPY",
  "XAUUSD",
  "BTCUSD",
  "ETHUSD",
] as const;

export type MarketPair = (typeof MARKET_PAIRS)[number];

/** Every chartable timeframe, from 1-minute scalps to daily swings. */
export const MARKET_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
export type MarketTimeframe = (typeof MARKET_TIMEFRAMES)[number];

export type MarketQuote = {
  pair: string;
  bid: number;
  ask: number;
  mid: number;
  timestamp: string;
  tradeable: boolean;
  source: "OANDA" | "COINBASE";
  /** Actual feed symbol when it differs from the app pair (e.g. GC=F for XAUUSD candles). */
  instrument?: string;
  /** Human note about the feed, stamped onto stored signals. */
  source_note?: string;
};

export type MarketCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  complete: boolean;
  volume: number;
};

// App pair -> TradingView scanner symbol. FX/gold use OANDA's retail feed;
// crypto uses Coinbase (real exchange bid/ask, also keyless).
//
// Exported because the ANALYSIS view embeds TradingView's own chart widget and
// has to point it at the SAME symbol the quotes come from. A second hand-kept
// map would eventually drift, and the failure mode is silent: a chart quoting a
// different venue than the scanner beside it.
export const TV_SYMBOLS: Record<string, string> = {
  EURUSD: "OANDA:EURUSD",
  GBPUSD: "OANDA:GBPUSD",
  USDJPY: "OANDA:USDJPY",
  AUDUSD: "OANDA:AUDUSD",
  USDCAD: "OANDA:USDCAD",
  NZDUSD: "OANDA:NZDUSD",
  USDCHF: "OANDA:USDCHF",
  EURGBP: "OANDA:EURGBP",
  EURJPY: "OANDA:EURJPY",
  GBPJPY: "OANDA:GBPJPY",
  AUDJPY: "OANDA:AUDJPY",
  XAUUSD: "OANDA:XAUUSD",
  BTCUSD: "COINBASE:BTCUSD",
  ETHUSD: "COINBASE:ETHUSD",
};

// App pair -> Yahoo Finance chart symbol (spot FX; GC=F for gold futures).
const YAHOO_SYMBOLS: Record<string, string> = {
  EURUSD: "EURUSD=X",
  GBPUSD: "GBPUSD=X",
  USDJPY: "USDJPY=X",
  AUDUSD: "AUDUSD=X",
  USDCAD: "USDCAD=X",
  NZDUSD: "NZDUSD=X",
  USDCHF: "USDCHF=X",
  EURGBP: "EURGBP=X",
  EURJPY: "EURJPY=X",
  GBPJPY: "GBPJPY=X",
  AUDJPY: "AUDJPY=X",
  XAUUSD: "GC=F",
  BTCUSD: "BTC-USD",
  ETHUSD: "ETH-USD",
};

const TV_FOREX_SCAN = "https://scanner.tradingview.com/forex/scan";
const TV_CFD_SCAN = "https://scanner.tradingview.com/cfd/scan";
const TV_CRYPTO_SCAN = "https://scanner.tradingview.com/crypto/scan";
const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart";

const CRYPTO_PAIRS = new Set(["BTCUSD", "ETHUSD"]);

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// --- Shared token bucket ----------------------------------------------------
// Both feeds are unofficial-but-public; a conservative shared bucket keeps
// ticker polls and RUN_SCAN bursts well under any cap. Requests queue
// server-side until a token frees, and getMarketProviderStatus() exposes the
// state so the UI can show a "rate limited, retrying" state.
//
// NOTE: the bucket is module-scoped = per-process. It fully protects a single
// dev/preview instance but does NOT enforce a global cap across multiple
// serverless/worker instances in production.
const BUCKET_CAPACITY = 30;
const BUCKET_REFILL_PER_SEC = 1;
const MAX_QUEUE_WAIT_MS = 45_000;
const LIMITED_BELOW_TOKENS = 4;

let bucketTokens = BUCKET_CAPACITY;
let bucketLastRefill = Date.now();
let bucketQueued = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refillBucket(now = Date.now()) {
  bucketTokens = Math.min(
    BUCKET_CAPACITY,
    bucketTokens + ((now - bucketLastRefill) / 1000) * BUCKET_REFILL_PER_SEC,
  );
  bucketLastRefill = now;
}

async function acquireToken() {
  bucketQueued += 1;
  const deadline = Date.now() + MAX_QUEUE_WAIT_MS;
  try {
    for (;;) {
      refillBucket();
      if (bucketTokens >= 1) {
        bucketTokens -= 1;
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error("Market data rate limit reached. Try again in a moment.");
      }
      await sleep(200);
    }
  } finally {
    bucketQueued -= 1;
  }
}

export function getMarketProviderStatus() {
  refillBucket();
  const available = Math.floor(bucketTokens);
  const limited = bucketQueued > 0 || available < LIMITED_BELOW_TOKENS;
  const retryInMs = Math.max(
    0,
    Math.ceil(((LIMITED_BELOW_TOKENS - bucketTokens) / BUCKET_REFILL_PER_SEC) * 1000),
  );
  return {
    provider: "OANDA" as const,
    environment: "public" as const,
    configured: true,
    missing: [] as string[],
    rate_limit: {
      limited,
      queued: bucketQueued,
      available,
      capacity: BUCKET_CAPACITY,
      retryInMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Quotes — TradingView scanner (OANDA retail feed)
// ---------------------------------------------------------------------------

type TvScanPayload = {
  totalCount?: number;
  data?: { s: string; d: (string | number | null)[] }[];
};

// Column order for the scanner request below.
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

async function tvScan(scanner: string, tickers: string[]): Promise<TvScanPayload> {
  await acquireToken();
  const response = await fetch(scanner, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://www.tradingview.com",
      "User-Agent": BROWSER_UA,
    },
    body: JSON.stringify({ symbols: { tickers }, columns: TV_COLUMNS }),
  });
  if (!response.ok) {
    throw new Error(`TradingView feed request failed (${response.status}): ${response.statusText}`);
  }
  return (await response.json()) as TvScanPayload;
}

export async function fetchMarketQuotes(pairs: string[]): Promise<MarketQuote[]> {
  if (pairs.length === 0) return [];
  const timestamp = new Date().toISOString();

  const forex = pairs.filter((p) => p !== "XAUUSD" && !CRYPTO_PAIRS.has(p));
  const cfd = pairs.filter((p) => p === "XAUUSD");
  const crypto = pairs.filter((p) => CRYPTO_PAIRS.has(p));

  const [forexPayload, cfdPayload, cryptoPayload] = await Promise.all([
    forex.length > 0 ? tvScan(TV_FOREX_SCAN, forex.map((p) => TV_SYMBOLS[p])) : { data: [] },
    cfd.length > 0 ? tvScan(TV_CFD_SCAN, cfd.map((p) => TV_SYMBOLS[p])) : { data: [] },
    crypto.length > 0 ? tvScan(TV_CRYPTO_SCAN, crypto.map((p) => TV_SYMBOLS[p])) : { data: [] },
  ]);

  const bySymbol = new Map<string, (string | number | null)[]>();
  for (const row of [
    ...(forexPayload.data ?? []),
    ...(cfdPayload.data ?? []),
    ...(cryptoPayload.data ?? []),
  ]) {
    bySymbol.set(row.s, row.d);
  }

  const quotes: MarketQuote[] = [];
  for (const pair of pairs) {
    const d = bySymbol.get(TV_SYMBOLS[pair]);
    if (!d) continue;
    // Explicit null checks: Number(null) would coerce to 0 and pass isFinite.
    const close = d[1] == null ? Number.NaN : Number(d[1]);
    const bid = d[2] == null ? close : Number(d[2]);
    const ask = d[3] == null ? close : Number(d[3]);
    if (!Number.isFinite(close) && !Number.isFinite(bid)) continue;
    const gold = pair === "XAUUSD";
    const cryptoPair = CRYPTO_PAIRS.has(pair);
    quotes.push({
      pair,
      bid,
      ask,
      mid: (bid + ask) / 2,
      timestamp,
      tradeable: true,
      source: cryptoPair ? "COINBASE" : "OANDA",
      instrument: gold ? "OANDA:XAUUSD (spot)" : TV_SYMBOLS[pair],
      source_note: gold
        ? "OANDA spot gold via TradingView feed"
        : cryptoPair
          ? "Coinbase exchange feed via TradingView"
          : undefined,
    });
  }

  if (quotes.length === 0) {
    throw new Error("Market data feed returned no usable quotes.");
  }
  return quotes;
}

// ---------------------------------------------------------------------------
// Candles — Yahoo Finance chart API (GC=F rebased to OANDA spot for gold)
// ---------------------------------------------------------------------------

type YahooChartPayload = {
  chart?: {
    result?: {
      timestamp?: number[];
      meta?: { regularMarketPrice?: number };
      indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
    }[];
    error?: { description?: string };
  };
};

async function yahooChart(symbol: string, interval: string, range: string): Promise<YahooChartPayload> {
  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  // Yahoo's unofficial chart API rate-limits aggressively on bursts; retry once
  // on 429 after a short backoff so a single scan isn't lost to throttling.
  for (let attempt = 0; attempt < 2; attempt++) {
    await acquireToken();
    const response = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json",
      },
    });
    if (response.status === 429 && attempt === 0) {
      await sleep(1_000);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Candle feed request failed for ${symbol} (${response.status}).`);
    }
    const payload = (await response.json()) as YahooChartPayload;
    if (payload.chart?.error?.description) {
      throw new Error(`Candle feed error for ${symbol}: ${payload.chart.error.description}`);
    }
    return payload;
  }
  throw new Error(`Candle feed request failed for ${symbol} (429).`);
}

// H4 has no native Yahoo interval; fetch 1h bars and bucket them into 4-hour
// windows aligned to UTC (the same way MT5/TradingView build an H4 series).
const GRANULARITY_TO_YAHOO: Record<MarketTimeframe, { interval: string; range: string; seconds: number }> = {
  M1: { interval: "1m", range: "1d", seconds: 60 },
  M5: { interval: "5m", range: "5d", seconds: 300 },
  M15: { interval: "15m", range: "1mo", seconds: 900 },
  M30: { interval: "30m", range: "1mo", seconds: 1800 },
  H1: { interval: "1h", range: "1mo", seconds: 3600 },
  H4: { interval: "1h", range: "3mo", seconds: 14_400 },
  D1: { interval: "1d", range: "1y", seconds: 86_400 },
};

function bucketCandles(candles: MarketCandle[], bucketSeconds: number): MarketCandle[] {
  const buckets = new Map<number, MarketCandle>();
  for (const candle of candles) {
    const timeSec = Math.floor(Date.parse(candle.time) / 1000);
    const bucketStart = Math.floor(timeSec / bucketSeconds) * bucketSeconds;
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, { ...candle, complete: timeSec + bucketSeconds <= Date.now() / 1000 });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume;
      existing.complete = existing.complete && timeSec + bucketSeconds <= Date.now() / 1000;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time.localeCompare(b.time));
}

export async function fetchMarketCandles(
  pair: string,
  granularity: MarketTimeframe,
  count = 60,
): Promise<MarketCandle[]> {
  const { interval, range, seconds } = GRANULARITY_TO_YAHOO[granularity];
  const symbol = YAHOO_SYMBOLS[pair];
  if (!symbol) throw new Error(`No candle feed for ${pair}.`);

  const payload = await yahooChart(symbol, interval, range);
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!timestamps || !quote) throw new Error(`No candle data returned for ${pair}.`);

  const nowSec = Date.now() / 1000;
  let candles: MarketCandle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const time = timestamps[i];
    const close = quote.close?.[i];
    if (close == null) continue; // Yahoo emits nulls for market gaps
    candles.push({
      time: new Date(time * 1000).toISOString(),
      open: Number(quote.open?.[i] ?? close),
      high: Number(quote.high?.[i] ?? close),
      low: Number(quote.low?.[i] ?? close),
      close: Number(close),
      complete: time + seconds <= nowSec,
      volume: Number(quote.volume?.[i] ?? 0) || 0,
    });
  }

  // H4: resample 1h bars into 4-hour buckets.
  if (granularity === "H4") {
    candles = bucketCandles(candles, 14_400);
  }

  // Gold: GC=F (COMEX futures) carries a futures basis vs OANDA spot. Rebase the
  // candle levels onto the live spot level so the engine's structure stop is
  // computed in the same space as the entry quote. Strategies are
  // shift-invariant, so a constant rebase preserves every computation.
  if (pair === "XAUUSD" && candles.length > 0) {
    try {
      const spot = await fetchMarketQuotes(["XAUUSD"]);
      const spotMid = spot[0]?.mid;
      const lastClose = candles[candles.length - 1].close;
      if (spotMid && Number.isFinite(spotMid) && Number.isFinite(lastClose)) {
        const delta = spotMid - lastClose;
        if (Math.abs(delta) > 1e-6) {
          candles = candles.map((c) => ({
            ...c,
            open: c.open + delta,
            high: c.high + delta,
            low: c.low + delta,
            close: c.close + delta,
          }));
        }
      }
    } catch {
      // Spot quote hiccup — return raw futures candles; the constant basis
      // leaves strategy math coherent, so gold still participates in scans.
    }
  }

  return candles.slice(-count);
}
