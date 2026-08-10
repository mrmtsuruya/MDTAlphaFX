import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery } from "@tanstack/react-query";
import { generateSignals, listSignals, scoreSignalPerformance } from "@/lib/signals.functions";
import {
  getMarketCandles,
  getMarketDataStatus,
  getMarketQuotes,
} from "@/lib/market-data.functions";
import { MARKET_TIMEFRAMES } from "@/lib/market-data.server";
import { classifyOrder, rForStatus, summarizeSignal, type OrderTicket } from "@/lib/order-ticket";
import {
  buildLocationOverlay,
  buildOverlays,
  type ChartOverlays,
  type OverlayCandle,
  type OverlayMarker,
} from "@/lib/chart-overlays";
import { Star, Radio, Zap, CircleAlert } from "lucide-react";
import { TradingViewChart } from "@/components/tradingview-chart";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  type Time,
  type SeriesMarker,
} from "lightweight-charts";

export const Route = createFileRoute("/_authenticated/chart")({
  head: () => ({
    meta: [
      { title: "Live Chart — MDTAlphaFX" },
      {
        name: "description",
        content:
          "Real-time OANDA chart with per-pair 28-strategy scanning and trade-level overlays.",
      },
      { property: "og:title", content: "Live Chart — MDTAlphaFX" },
      {
        property: "og:description",
        content:
          "Real-time OANDA chart with per-pair 28-strategy scanning and trade-level overlays.",
      },
    ],
  }),
  component: Chart,
});

// Searchable universe (FX + metals + crypto). Only starred symbols render as
// quick shortcuts — the rest appear via the search box.
const PAIRS = [
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
];

const TIMEFRAMES: { id: (typeof MARKET_TIMEFRAMES)[number]; label: string }[] = [
  { id: "M1", label: "M1" },
  { id: "M5", label: "M5" },
  { id: "M15", label: "M15" },
  { id: "M30", label: "M30" },
  { id: "H1", label: "H1" },
  { id: "H4", label: "H4" },
  { id: "D1", label: "D1" },
];

type ChartView = "signal" | "analysis";

const VIEWS: { id: ChartView; label: string; hint: string }[] = [
  {
    id: "signal",
    label: "signal",
    hint: "The terminal's chart: engine entry/SL/TP levels, strategy markup, live tick engine.",
  },
  {
    id: "analysis",
    label: "analysis",
    hint: "TradingView's widget: drawing tools and their indicator library. Cannot show signal overlays.",
  },
];

const FAVORITES_KEY = "mdtalpha-chart-favorites";
const DEFAULT_FAVORITES = ["XAUUSD"];

function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [...DEFAULT_FAVORITES];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_FAVORITES];
    const valid = parsed.filter((p): p is string => typeof p === "string" && PAIRS.includes(p));
    // XAUUSD is always a favorite shortcut (pinned, cannot be removed).
    return [...new Set([...DEFAULT_FAVORITES, ...valid])];
  } catch {
    return [...DEFAULT_FAVORITES];
  }
}

function saveFavorites(favorites: string[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    // storage unavailable — favorites just won't persist across reloads
  }
}

type ScanSignal = {
  pair: string;
  direction: "long" | "short";
  mode?: string;
  timeframe: string;
  entry: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  atr: number;
  confluence: number;
  contributing_strategies: string[];
  rationale: string | null;
  news_context: unknown;
};

type Granularity = (typeof MARKET_TIMEFRAMES)[number];

/** The live quote, owned by the Chart route and passed down — see the note
 *  where it is fetched. */
type LiveQuote = { bid: number; ask: number } | null;

// Bar length per timeframe — used to roll the forming candle over when the
// bucket advances, so M1 keeps printing new bars between candle refetches.
const TF_SECONDS: Record<Granularity, number> = {
  M1: 60,
  M5: 300,
  M15: 900,
  M30: 1_800,
  H1: 3_600,
  H4: 14_400,
  D1: 86_400,
};

// Quote cadence. Deliberately FLAT across timeframes: the quote is the live
// tape, and the tape does not slow down because you are looking at a daily
// chart. Scaling this per timeframe (2s on M1 up to 15s on D1) made BID/ASK and
// the legend visibly stall on the higher timeframes while the chart itself kept
// easing — the numbers and the candles disagreed about how live the feed was.
//
// Cost check against the token bucket in market-data.server.ts (30 capacity,
// 1 token/sec refill): quotes are 1 token / 2s = 0.5/s, candles at worst
// 1 token / 30s = 0.033/s. Total ~0.53/s against a 1/s refill — identical to
// the M1 steady state the bucket was already sized for, now applied on every
// timeframe rather than only the fast ones.
const QUOTE_POLL_MS = 2_000;

// Candle refetch cadence. M1 bars close every 60s, so a 60s poll always
// trailed a full bar behind.
const CANDLE_POLL_MS: Record<Granularity, number> = {
  M1: 30_000,
  M5: 30_000,
  M15: 60_000,
  M30: 60_000,
  H1: 120_000,
  H4: 300_000,
  D1: 300_000,
};

// No tick for this long => the feed is stale (weekend / session close), and the
// chart is honestly reporting that rather than pretending to be live.
const STALE_TICK_MS = 90_000;

type ScanMode = "auto" | "intraday" | "scalper";
type ScanScope = "sweep" | "mtf";

const SCAN_MODES: ScanMode[] = ["auto", "intraday", "scalper"];

const SCAN_SCOPES: { id: ScanScope; label: string; hint: string }[] = [
  {
    id: "sweep",
    label: "sweep_tf",
    hint: "Scan every timeframe the enabled strategies cover and keep the strongest setup.",
  },
  {
    id: "mtf",
    label: "mtf_tide",
    hint: "Single entry timeframe, gated by the higher-timeframe tide.",
  },
];

// Which timeframes a sweep covers per risk mode. AUTO is every chartable
// timeframe, with the risk profile resolved per timeframe on the server.
const SWEEP_SETS: Record<ScanMode, Granularity[]> = {
  auto: ["M1", "M5", "M15", "M30", "H1", "H4", "D1"],
  scalper: ["M1", "M5", "M15", "M30"],
  intraday: ["M15", "M30", "H1", "H4", "D1"],
};

function modeForTimeframe(tf: Granularity): "intraday" | "scalper" {
  return tf === "M1" || tf === "M5" || tf === "M15" || tf === "M30" ? "scalper" : "intraday";
}

type SweepAttempt = {
  timeframe: string;
  mode: string;
  direction: "long" | "short" | null;
  confluence: number;
  strategies: number;
  reason?: string;
  /**
   * Present when this timeframe declined but had a setup forming. Typed as
   * unknown-ish here for the same reason the rest of this block is a local
   * mirror: it arrives as jsonb and nothing guarantees its shape client-side.
   */
  armed?: ArmedSetupView | null;
  modeVerdict?: string;
};

function Chart() {
  // Gold-first: the user primarily trades XAUUSD and it is a pinned favorite.
  const [symbol, setSymbol] = useState("XAUUSD");
  const [pairQuery, setPairQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [timeframe, setTimeframe] = useState<Granularity>("H1");
  const [result, setResult] = useState<ScanSignal | null>(null);
  const [view, setView] = useState<ChartView>("signal");

  // ONE owner for the live quote, deliberately hoisted here.
  //
  // MarketChart and PairScanner each used to mount their own
  // useQuery(["market-quotes", pair]). Identical key, so the CACHE is shared —
  // but each observer keeps its own refetchInterval timer, and React Query
  // refetches per observer. Two staggered 2s timers measured at 22 requests in
  // 20s against a bucket that refills at 1/s, which pinned the feed at
  // RATE_LIMITED permanently. At the old 10-15s cadence the same duplication
  // was there and simply too small to notice.
  //
  // One query here, passed down as a prop: one timer, one request per interval.
  const chartQuotesFn = useServerFn(getMarketQuotes);
  const chartQuotes = useQuery({
    queryKey: ["market-quotes", symbol],
    queryFn: () => chartQuotesFn({ data: { pairs: [symbol] } }),
    refetchInterval: QUOTE_POLL_MS,
    retry: false,
  });
  const liveQuote = chartQuotes.data?.quotes?.[0] ?? null;
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const filteredPairs = PAIRS.filter((p) =>
    p.toLowerCase().includes(pairQuery.trim().toLowerCase()),
  );
  const selectPair = (p: string) => {
    setSymbol(p);
    setPairQuery("");
  };
  const toggleFavorite = (p: string) => {
    setFavorites((current) => {
      const next = current.includes(p) ? current.filter((item) => item !== p) : [...current, p];
      saveFavorites(next);
      return next;
    });
  };
  const isFavorite = (p: string) => favorites.includes(p);

  // Clear stale results when the chart symbol changes.
  useEffect(() => {
    setResult(null);
    setScanMessage(null);
  }, [symbol]);

  return (
    <div className="p-6 space-y-4 h-[calc(100vh-3.5rem)] flex flex-col">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Live Chart</h1>
        </div>
        <div className="flex flex-col gap-1.5 items-end">
          <div className="flex gap-1 flex-wrap items-center">
            {/* SIGNAL is the terminal's own chart: engine levels, strategy
                markup, live tick engine. ANALYSIS is TradingView's widget:
                drawing tools and their indicator library, but a cross-origin
                iframe nothing can be drawn into. Two views instead of one
                compromise. */}
            <div
              className="mr-2 flex rounded-sm border border-cyber-border bg-cyber-surface p-0.5"
              role="radiogroup"
              aria-label="Chart view"
            >
              {VIEWS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={view === item.id}
                  title={item.hint}
                  onClick={() => setView(item.id)}
                  className={`rounded-sm px-2 py-1 text-[10px] font-mono uppercase tracking-widest transition ${
                    view === item.id
                      ? "bg-neon-accent/10 text-neon-accent"
                      : "text-muted-foreground hover:text-white"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div
              className="mr-2 flex rounded-sm border border-cyber-border bg-cyber-surface p-0.5"
              role="radiogroup"
              aria-label="Timeframe"
            >
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf.id}
                  type="button"
                  role="radio"
                  aria-checked={timeframe === tf.id}
                  onClick={() => setTimeframe(tf.id)}
                  className={`rounded-sm px-2 py-1 text-[10px] font-mono uppercase tracking-widest transition ${
                    timeframe === tf.id
                      ? "bg-neon-accent/10 text-neon-accent"
                      : "text-muted-foreground hover:text-white"
                  }`}
                >
                  {tf.label}
                </button>
              ))}
            </div>
            <input
              value={pairQuery}
              onChange={(e) => setPairQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filteredPairs.length > 0) {
                  selectPair(filteredPairs[0]);
                }
                if (e.key === "Escape") setPairQuery("");
              }}
              placeholder="SEARCH_PAIR…"
              aria-label="Search pair"
              className="w-28 rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 text-[10px] font-mono text-white placeholder:text-muted-foreground focus:border-neon-accent/50 focus:outline-none transition"
            />
          </div>
          {/* Search results: any symbol, with a star to favorite it. */}
          {pairQuery.trim() !== "" && (
            <div className="flex gap-1 flex-wrap items-center justify-end">
              {filteredPairs.length === 0 && (
                <span className="font-mono text-[10px] text-neon-warn">NO_MATCH</span>
              )}
              {filteredPairs.map((p) => (
                <span
                  key={p}
                  className={`inline-flex items-center gap-1 rounded-sm border px-2 py-1 text-[10px] font-mono transition ${
                    symbol === p
                      ? "border-neon-accent/40 bg-neon-accent/10 text-neon-accent"
                      : "border-cyber-border bg-cyber-surface text-muted-foreground"
                  }`}
                >
                  <button type="button" onClick={() => selectPair(p)} className="hover:text-white">
                    {p}
                  </button>
                  <button
                    type="button"
                    aria-label={isFavorite(p) ? `Unstar ${p}` : `Star ${p}`}
                    onClick={() => toggleFavorite(p)}
                    className={`transition ${
                      isFavorite(p)
                        ? "text-neon-warn"
                        : "text-muted-foreground hover:text-neon-warn"
                    }`}
                  >
                    <Star className="size-3" fill={isFavorite(p) ? "currentColor" : "none"} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* Favorite shortcuts: only starred symbols (XAUUSD pinned by default). */}
          <div className="flex gap-1 flex-wrap items-center justify-end">
            {favorites.map((p) => (
              <button
                key={p}
                onClick={() => selectPair(p)}
                className={`inline-flex items-center gap-1 rounded-sm border px-2.5 py-1.5 text-[10px] font-mono transition ${
                  symbol === p
                    ? "border-neon-accent/40 bg-neon-accent/10 text-neon-accent"
                    : "border-cyber-border bg-cyber-surface text-muted-foreground hover:text-white"
                }`}
              >
                <Star className="size-2.5 text-neon-warn" fill="currentColor" />
                {p}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 grid gap-4 lg:grid-cols-[1fr_380px] min-h-0">
        {/* Only the left panel swaps. PairScanner stays mounted in both views,
            so BID/ASK/SPREAD, RUN_SCAN and the result card are untouched by the
            choice — they never read the chart. */}
        {view === "signal" ? (
          <MarketChart symbol={symbol} granularity={timeframe} result={result} quote={liveQuote} />
        ) : (
          <TradingViewChart pair={symbol} timeframe={timeframe} />
        )}

        <PairScanner
          key={symbol}
          pair={symbol}
          timeframe={timeframe}
          view={view}
          quote={liveQuote}
          isFavorite={isFavorite}
          onToggleFavorite={() => toggleFavorite(symbol)}
          result={result}
          setResult={setResult}
          setScanMessage={setScanMessage}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MarketChart — lightweight-charts (TradingView's open-source engine), same
// OANDA/Yahoo data the scanner uses. Draws ENTRY/SL/TP1/TP2 price lines with
// axis labels the moment a scan completes.
// ---------------------------------------------------------------------------

const UP = "#00ffa3";
const DOWN = "#ff2e5b";
const ACCENT = "#00d1ff";
const SOFT_GREEN = "#b6ffdc";

// Match the axis/price-line precision to the instrument's quote convention:
// gold + crypto in dollars (2 decimals), JPY pairs in 0.01 steps, FX 5.
function priceFormatFor(symbol: string): { type: "price"; precision: number; minMove: number } {
  if (symbol === "XAUUSD" || symbol === "BTCUSD" || symbol === "ETHUSD") {
    return { type: "price", precision: 2, minMove: 0.01 };
  }
  if (symbol.endsWith("JPY")) return { type: "price", precision: 3, minMove: 0.001 };
  return { type: "price", precision: 5, minMove: 0.00001 };
}

function MarketChart({
  symbol,
  granularity,
  result,
  quote,
}: {
  symbol: string;
  granularity: Granularity;
  result: ScanSignal | null;
  quote: LiveQuote;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lastBarRef = useRef<{
    time: UTCTimestamp;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const lastPriceLineRef = useRef<IPriceLine | null>(null);
  // Strategy overlays: one line series per indicator, plus price lines for the
  // horizontal levels and zone edges. Tracked separately from priceLinesRef so
  // a scan can redraw its ENTRY/SL/TP without tearing down the annotations.
  const overlaySeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const overlayLinesRef = useRef<IPriceLine[]>([]);
  const [showOverlays, setShowOverlays] = useState(true);
  const [lastPrice, setLastPrice] = useState<number | null>(null);
  const [tickDelta, setTickDelta] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  // Newest real mid from the feed (the animation target).
  const targetPriceRef = useRef<number | null>(null);
  // Currently painted price — eased toward the target each frame.
  const displayPriceRef = useRef<number | null>(null);
  const lastQuoteRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number>(0);

  const candlesFn = useServerFn(getMarketCandles);
  const quotesFn = useServerFn(getMarketQuotes);

  const candles = useQuery({
    queryKey: ["market-candles", symbol, granularity],
    queryFn: () => candlesFn({ data: { pair: symbol, granularity, count: 300 } }),
    refetchInterval: CANDLE_POLL_MS[granularity],
    retry: false,
  });

  // Overlays are derived from the bars already on the chart plus the list of
  // strategies that actually voted — no extra feed request, so turning them on
  // costs nothing against the token bucket.
  const overlays = useMemo<ChartOverlays | null>(() => {
    if (!result || !showOverlays) return null;
    const bars = (candles.data?.candles ?? []).map((c) => ({
      time: Math.floor(Date.parse(c.time) / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
    if (bars.length === 0) return null;
    const strategyOverlays = buildOverlays(
      bars,
      result.contributing_strategies ?? [],
      result.direction,
    );
    // Premium/discount is not a strategy, so it is built separately (that is
    // what keeps it out of the strategy-keyed guard test) and merged in here.
    // It is the one drawing that answers "am I buying the top?" at a glance,
    // which makes it the most useful thing on the canvas for someone still
    // learning to read the range rather than the indicators.
    const location = buildLocationOverlay(bars, result.direction);
    if (!location) return strategyOverlays;
    return {
      ...strategyOverlays,
      levels: [...strategyOverlays.levels, ...location.levels],
      zones: [...strategyOverlays.zones, ...location.zones],
      markers: [...strategyOverlays.markers, ...location.markers],
      drawn: [
        ...strategyOverlays.drawn,
        { strategyId: "location", drew: "premium/discount range" },
      ],
    };
  }, [result, candles.data, showOverlays]);

  // --- chart lifecycle: create once per symbol + granularity ---------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0f1115" },
        textColor: "#7a8497",
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        panes: { separatorColor: "#1e2229" },
      },
      grid: {
        vertLines: { color: "#14171d" },
        horzLines: { color: "#14171d" },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#1e2229", labelBackgroundColor: "#1e2229" },
        horzLine: { color: "#1e2229", labelBackgroundColor: "#1e2229" },
      },
      rightPriceScale: { borderColor: "#1e2229" },
      timeScale: { borderColor: "#1e2229", timeVisible: true, secondsVisible: false },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      // Full price precision on the axis + price-line labels (the default of
      // 2 decimals truncates e.g. 1.34455 to "1.34" on the ENTRY/SL/TP lines).
      priceFormat: priceFormatFor(symbol),
      // Keep the series' own last-value label (it auto-colours with the
      // candle) but kill its built-in price line. The LAST line created below
      // already draws that ray, and having both meant two horizontal lines and
      // two stacked axis labels at the same price.
      lastValueVisible: true,
      priceLineVisible: false,
    });

    // Volume overlay on the main pane.
    const volumeSeries = chart.addSeries(
      HistogramSeries,
      {
        priceScaleId: "vol",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      },
      0,
    );
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });

    // RSI(14) in a second pane — parity with the old widget's studies.
    const rsiSeries = chart.addSeries(
      LineSeries,
      {
        priceScaleId: "rsi",
        color: ACCENT,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      },
      1,
    );
    chart.priceScale("rsi", 1).applyOptions({ scaleMargins: { top: 0.15, bottom: 0.15 } });
    rsiSeries.createPriceLine({
      price: 70,
      color: "rgba(255,181,69,0.25)",
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    });
    rsiSeries.createPriceLine({
      price: 30,
      color: "rgba(255,181,69,0.25)",
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
    });

    chartRef.current = chart;
    candleRef.current = candleSeries;
    volumeRef.current = volumeSeries;
    rsiRef.current = rsiSeries;
    // One markers plugin per chart — reused across scans so no orphaned
    // primitives accumulate on the series (createSeriesMarkers attaches a
    // primitive to the series; recreating it per scan would leak them).
    markersRef.current = createSeriesMarkers<Time>(candleSeries);
    // A thin dotted line that tracks the live quote so the chart visibly moves
    // between candle refetches. No axis label and no title: the series' own
    // last-value label sits at this exact price, so a second label just stacked
    // on top of it, and the "LAST" title was clipped to "AST" by the axis.
    lastPriceLineRef.current = candleSeries.createPriceLine({
      price: 0,
      color: ACCENT,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: "",
    });
    setLastPrice(null);
    setTickDelta(null);
    setStale(false);
    targetPriceRef.current = null;
    displayPriceRef.current = null;
    lastQuoteRef.current = null;
    lastTickAtRef.current = Date.now();

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      rsiRef.current = null;
      priceLinesRef.current = [];
      markersRef.current = null;
      lastPriceLineRef.current = null;
      // chart.remove() disposes the overlay series too; just drop the handles
      // so the next chart doesn't try to remove series from a dead chart.
      overlaySeriesRef.current = [];
      overlayLinesRef.current = [];
      lastBarRef.current = null;
      targetPriceRef.current = null;
      displayPriceRef.current = null;
      setLastPrice(null);
    };
  }, [symbol, granularity]);

  // --- load candle data -----------------------------------------------------
  useEffect(() => {
    const series = candleRef.current;
    const chart = chartRef.current;
    const data = candles.data?.candles;
    if (!series || !chart || !data || data.length === 0) return;

    const bars = data.map((c) => ({
      time: Math.floor(Date.parse(c.time) / 1000) as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    series.setData(bars);
    lastBarRef.current = bars[bars.length - 1] ?? null;

    volumeRef.current?.setData(
      data.map((c, i) => ({
        time: bars[i].time,
        value: c.volume || 0,
        color: c.close >= c.open ? "rgba(0,255,163,0.3)" : "rgba(255,46,91,0.3)",
      })),
    );

    const closes = bars.map((b) => b.close);
    const rsi = computeRsi(closes);
    rsiRef.current?.setData(
      rsi
        .map((v, i) => (v == null ? null : { time: bars[i].time, value: v }))
        .filter((x): x is { time: UTCTimestamp; value: number } => x != null),
    );

    // Keep a tight window so live ticks are visible: short timeframes show
    // ~48 bars, longer ones ~40 (enough recent context to read structure).
    const visibleBars = granularity === "M1" || granularity === "M5" ? 48 : 40;
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, bars.length - visibleBars),
      to: bars.length + 4,
    });
    drawLevels(chart, series, result, bars, priceLinesRef, markersRef, overlays?.markers ?? []);
  }, [candles.data, symbol, granularity]);

  // --- redraw levels when the scan result changes ---------------------------
  useEffect(() => {
    const series = candleRef.current;
    const chart = chartRef.current;
    const bars = lastBarRef.current ? [lastBarRef.current] : [];
    drawLevels(chart, series, result, bars, priceLinesRef, markersRef, overlays?.markers ?? []);
  }, [result, symbol, granularity, overlays]);

  // --- strategy overlays ----------------------------------------------------
  useEffect(() => {
    drawOverlays(chartRef.current, candleRef.current, overlays, overlaySeriesRef, overlayLinesRef);
  }, [overlays, symbol, granularity]);

  // --- live price: record the newest real mid as the animation target -------
  useEffect(() => {
    if (!quote) return;
    const mid = (quote.bid + quote.ask) / 2;
    if (!Number.isFinite(mid)) return;
    targetPriceRef.current = mid;
    // First quote after a symbol/timeframe switch: land on it, don't ease in
    // from nothing.
    if (displayPriceRef.current == null) displayPriceRef.current = mid;
    const previous = lastQuoteRef.current;
    lastQuoteRef.current = mid;
    if (previous != null && previous !== mid) {
      setTickDelta(mid - previous);
      lastTickAtRef.current = Date.now();
    }
    // symbol/granularity are dependencies because the chart-lifecycle effect
    // above nulls targetPriceRef whenever either changes, and this effect is
    // the only thing that refills it. Keying on the quote alone meant a
    // timeframe switch left the target null until the feed happened to return
    // a DIFFERENT bid/ask — the quote query is keyed on symbol only, so an
    // unchanged price never re-fired this. On a quiet session that froze the
    // live price and the legend indefinitely after every timeframe change.
  }, [quote?.bid, quote?.ask, symbol, granularity]);

  // --- animation loop -------------------------------------------------------
  // Two jobs, both of which the old code was missing:
  //   1. BAR ROLLOVER. Every tick used to be written into the same bar time, so
  //      once an M1 candle closed the chart just kept stretching that one bar
  //      until the next candle refetch — which is exactly the "frozen on 1m"
  //      symptom. Now the forming bar rolls to the next bucket on schedule.
  //   2. EASING. Prices arrive in discrete polls; painting them raw makes the
  //      chart jump then sit still. Easing toward the newest real quote keeps
  //      motion continuous. It only ever moves toward a price the feed actually
  //      returned — no synthetic ticks are invented.
  useEffect(() => {
    const tfSeconds = TF_SECONDS[granularity];
    let frame = 0;
    let lastPaint = 0;
    let lastLegend = 0;

    const paint = (now: number) => {
      frame = requestAnimationFrame(paint);
      // ~20fps is smooth for a price ease and leaves the main thread alone.
      if (now - lastPaint < 50) return;
      lastPaint = now;

      const series = candleRef.current;
      const target = targetPriceRef.current;
      const bar = lastBarRef.current;
      if (!series || target == null || !bar) return;

      const current = displayPriceRef.current ?? target;
      const gap = target - current;
      const settled = Math.abs(gap) < Math.abs(target) * 1e-7;
      const next = settled ? target : current + gap * 0.18;
      displayPriceRef.current = next;

      const bucket = (Math.floor(Date.now() / 1000 / tfSeconds) * tfSeconds) as UTCTimestamp;
      const rollingOver = bucket > bar.time && bucket - bar.time >= tfSeconds;
      // Fully caught up and no new bar due (a closed market sits here): skip
      // the repaint entirely rather than rewriting the same candle 20x/sec.
      if (settled && !rollingOver && bar.close === next) {
        if (now - lastLegend >= 200) {
          lastLegend = now;
          setStale(Date.now() - lastTickAtRef.current > STALE_TICK_MS);
        }
        return;
      }
      // rollingOver requires a full bar of separation: some feeds (daily
      // futures bars) stamp times that aren't aligned to a UTC bucket
      // boundary, and a naive comparison would inject a spurious bar minutes
      // after the last one.
      if (rollingOver) {
        const opened = {
          time: bucket,
          open: bar.close,
          high: Math.max(bar.close, next),
          low: Math.min(bar.close, next),
          close: next,
        };
        lastBarRef.current = opened;
        series.update(opened);
      } else {
        bar.high = Math.max(bar.high, next);
        bar.low = Math.min(bar.low, next);
        bar.close = next;
        series.update({ ...bar });
      }
      lastPriceLineRef.current?.applyOptions({ price: next });

      // Legend + staleness at 5fps — no need to re-render React at 20.
      if (now - lastLegend >= 200) {
        lastLegend = now;
        setLastPrice(next);
        setStale(Date.now() - lastTickAtRef.current > STALE_TICK_MS);
      }
    };

    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [symbol, granularity]);

  return (
    <div className="rounded-lg border border-cyber-border bg-cyber-surface overflow-hidden min-h-0 relative flex flex-col">
      <div ref={containerRef} className="h-full w-full min-h-[380px]" />
      <ChartLegend
        symbol={symbol}
        granularity={granularity}
        result={result}
        lastPrice={lastPrice}
        quote={quote}
      />
      {candles.isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-cyber-surface/70 font-mono text-[11px] text-muted-foreground">
          LOADING_OANDA_CANDLES…
        </div>
      )}
      {quote && (
        <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-sm border border-cyber-border bg-cyber-bg/80 px-2 py-1 font-mono text-[9px] backdrop-blur">
          {stale ? (
            <span className="text-neon-warn" title="No price change from the feed in over 90s">
              NO_TICKS
            </span>
          ) : (
            <span className="text-neon-long">LIVE</span>
          )}
          <span className="text-muted-foreground"> {QUOTE_POLL_MS / 1000}s</span>
          {tickDelta != null && tickDelta !== 0 && (
            <span className={tickDelta > 0 ? "text-neon-long" : "text-neon-short"}>
              {" "}
              {tickDelta > 0 ? "▲" : "▼"} {formatPrice(symbol, Math.abs(tickDelta))}
            </span>
          )}
        </div>
      )}
      {result && (
        <div className="absolute bottom-10 left-3 z-10 max-w-[60%] rounded-sm border border-cyber-border bg-cyber-bg/85 px-2.5 py-2 font-mono text-[9px] backdrop-blur">
          <div className="flex items-center justify-between gap-4">
            <span className="uppercase tracking-widest text-muted-foreground">
              // strategy_markup
            </span>
            <button
              type="button"
              onClick={() => setShowOverlays((value) => !value)}
              className={`rounded-sm border px-1.5 py-0.5 uppercase tracking-wider transition ${
                showOverlays
                  ? "border-neon-accent/40 text-neon-accent"
                  : "border-cyber-border text-muted-foreground hover:text-white"
              }`}
            >
              {showOverlays ? "on" : "off"}
            </button>
          </div>
          {showOverlays && overlays && (
            <>
              {overlays.drawn.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {overlays.drawn.map((item) => (
                    <li key={item.strategyId}>
                      <span className="text-neon-accent">{item.drew}</span>
                      <span className="text-muted-foreground"> · {item.strategyId}</span>
                    </li>
                  ))}
                </ul>
              )}
              {overlays.noGeometry.length > 0 && (
                <p className="mt-1.5 leading-snug text-muted-foreground">
                  Voted, no price geometry to draw: {overlays.noGeometry.join(", ")}
                </p>
              )}
              {overlays.drawn.length === 0 && overlays.noGeometry.length === 0 && (
                <p className="mt-1.5 text-muted-foreground">
                  No drawable pattern in the visible window.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {candles.isError && (
        <div className="absolute inset-0 flex items-center justify-center bg-cyber-surface/70 font-mono text-[11px] text-neon-warn">
          CANDLE_FEED_ERROR
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Level drawing — ENTRY / SL / TP1 / TP2 as TradingView-style labeled lines.
// ---------------------------------------------------------------------------

/**
 * Draw the strategy annotations: indicator line series, horizontal levels, and
 * zone edges. Torn down and rebuilt wholesale on every change — the sets are
 * small (a handful of series) and partial diffing would be more code than it
 * saves.
 */
function drawOverlays(
  chart: IChartApi | null,
  series: ISeriesApi<"Candlestick"> | null,
  overlays: ChartOverlays | null,
  overlaySeriesRef: MutableRefObject<ISeriesApi<"Line">[]>,
  overlayLinesRef: MutableRefObject<IPriceLine[]>,
) {
  if (!chart || !series) return;

  for (const line of overlayLinesRef.current) {
    series.removePriceLine(line);
  }
  overlayLinesRef.current = [];
  for (const overlaySeries of overlaySeriesRef.current) {
    chart.removeSeries(overlaySeries);
  }
  overlaySeriesRef.current = [];

  if (!overlays) return;

  for (const line of overlays.lines) {
    const lineSeries = chart.addSeries(
      LineSeries,
      {
        color: line.color,
        lineWidth: line.lineWidth,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        // Annotations must never drive the price scale: an EMA55 that runs off
        // the visible window would otherwise rescale the candles around it.
        autoscaleInfoProvider: () => null,
      },
      0,
    );
    lineSeries.setData(
      line.points.map((point) => ({ time: point.time as UTCTimestamp, value: point.value })),
    );
    overlaySeriesRef.current.push(lineSeries);
  }

  for (const level of overlays.levels) {
    overlayLinesRef.current.push(
      series.createPriceLine({
        price: level.price,
        color: level.color,
        lineWidth: 1,
        lineStyle: level.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: false,
        title: level.label,
      }),
    );
  }

  // lightweight-charts has no rectangle primitive without a custom plugin, so a
  // zone is drawn as its two edges with the name on the upper one.
  for (const zone of overlays.zones) {
    overlayLinesRef.current.push(
      series.createPriceLine({
        price: zone.top,
        color: zone.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: zone.label,
      }),
      series.createPriceLine({
        price: zone.bottom,
        color: zone.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      }),
    );
  }
}

function drawLevels(
  chart: IChartApi | null,
  series: ISeriesApi<"Candlestick"> | null,
  result: ScanSignal | null,
  bars: { time: UTCTimestamp }[],
  priceLinesRef: MutableRefObject<IPriceLine[]>,
  markersRef: MutableRefObject<ReturnType<typeof createSeriesMarkers<Time>> | null>,
  overlayMarkers: OverlayMarker[] = [],
) {
  if (!chart || !series) return;

  // Clear previous levels.
  for (const line of priceLinesRef.current) {
    series.removePriceLine(line);
  }
  priceLinesRef.current = [];
  markersRef.current?.setMarkers([]);

  if (!result) return;

  const levels = [
    { price: result.entry, color: ACCENT, title: "ENTRY", style: LineStyle.Solid },
    { price: result.stop_loss, color: DOWN, title: "SL", style: LineStyle.Dashed },
    { price: result.take_profit_1, color: UP, title: "TP1", style: LineStyle.Dashed },
    { price: result.take_profit_2, color: SOFT_GREEN, title: "TP2", style: LineStyle.Dashed },
  ];
  for (const l of levels) {
    priceLinesRef.current.push(
      series.createPriceLine({
        price: l.price,
        color: l.color,
        lineWidth: 1,
        lineStyle: l.style,
        axisLabelVisible: true,
        title: l.title,
      }),
    );
  }

  // Entry marker at the last (current) bar, plus any structure markers the
  // overlay layer produced. One setMarkers call — the plugin replaces the whole
  // set each time, so they have to go in together.
  const markers: SeriesMarker<UTCTimestamp>[] = overlayMarkers.map((marker) => ({
    time: marker.time as UTCTimestamp,
    position: marker.position,
    color: marker.color,
    shape: marker.shape,
    text: marker.text,
  }));
  const last = bars[bars.length - 1];
  if (last) {
    markers.push({
      time: last.time,
      position: result.direction === "long" ? "belowBar" : "aboveBar",
      color: result.direction === "long" ? UP : DOWN,
      shape: result.direction === "long" ? "arrowUp" : "arrowDown",
      text: `${result.direction.toUpperCase()} ${result.confluence}%`,
    });
  }
  markers.sort((a, b) => (a.time as number) - (b.time as number));
  markersRef.current?.setMarkers(markers);

  // Keep autoscale ENABLED: levels sit within a couple ATR of the live price,
  // so the normal autoscaled view already shows them. Pinning the range with
  // setVisibleRange() would disable autoscale and freeze the chart.
  chart.priceScale("right").applyOptions({ autoScale: true });
  // Nudge the view so the newest bar (and its marker) stays on screen, but
  // don't pin to the absolute right edge — recent context stays visible.
  chart.timeScale().scrollToPosition(12, false);
}

// --- RSI(14), Wilder smoothing ---------------------------------------------
function computeRsi(closes: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain += Math.max(diff, 0);
    avgLoss += Math.max(-diff, 0);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// --- legend overlay ----------------------------------------------------------
function ChartLegend({
  symbol,
  granularity,
  result,
  lastPrice,
  quote,
}: {
  symbol: string;
  granularity: Granularity;
  result: ScanSignal | null;
  lastPrice: number | null;
  quote?: { bid: number; ask: number } | null;
}) {
  const price = lastPrice ?? quote?.bid ?? null;
  // Re-derived every legend repaint, so the ticket flips to TOO LATE or
  // INVALIDATED live as the candle moves through TP1 / SL.
  const ticket = result ? classifyOrder(result, price) : null;
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-10 space-y-1 font-mono">
      <div className="flex items-center gap-2 rounded-sm border border-cyber-border bg-cyber-bg/80 px-2 py-1 text-[10px] backdrop-blur">
        <span className="font-bold text-white">{symbol}</span>
        <span className="text-muted-foreground">{granularity}</span>
        <span className="text-neon-long">OANDA</span>
        {price != null && <span className="text-white">{formatPrice(symbol, price)}</span>}
      </div>
      {result && ticket && (
        <div className="rounded-sm border border-cyber-border bg-cyber-bg/80 px-2 py-1 text-[10px] backdrop-blur space-y-0.5">
          <div className="flex items-center gap-2">
            <span
              className={
                ticket.tone === "long"
                  ? "text-neon-long"
                  : ticket.tone === "short"
                    ? "text-neon-short"
                    : ticket.tone === "warn"
                      ? "text-neon-warn"
                      : "text-muted-foreground"
              }
            >
              {ticket.label}
            </span>
            <span className="text-muted-foreground">
              {result.confluence}% · {result.timeframe}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <LegendItem color={ACCENT} label="ENTRY" value={result.entry} />
            <LegendItem color={DOWN} label="SL" value={result.stop_loss} />
            <LegendItem color={UP} label="TP1" value={result.take_profit_1} />
            <LegendItem color={SOFT_GREEN} label="TP2" value={result.take_profit_2} />
          </div>
        </div>
      )}
    </div>
  );
}

function LegendItem({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="text-white">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PairScanner — same panel as before, state lifted so the chart can react.
// ---------------------------------------------------------------------------

function PairScanner({
  pair,
  timeframe,
  view,
  quote,
  isFavorite,
  onToggleFavorite,
  result,
  setResult,
  setScanMessage,
}: {
  pair: string;
  timeframe: Granularity;
  view: ChartView;
  quote: LiveQuote;
  isFavorite: (p: string) => boolean;
  onToggleFavorite: () => void;
  result: ScanSignal | null;
  setResult: (r: ScanSignal | null) => void;
  setScanMessage: (m: string | null) => void;
}) {
  const genFn = useServerFn(generateSignals);
  const quotesFn = useServerFn(getMarketQuotes);
  const statusFn = useServerFn(getMarketDataStatus);
  const [scanMessage, setLocalMessage] = useState<string | null>(null);
  // The pair the in-flight scan was requested for, so a late response for a
  // previously selected symbol is never rendered under the new symbol's header.
  const requestedPairRef = useRef<string | null>(null);

  // Risk profile. AUTO derives it from the timeframe being scanned (per
  // timeframe in a sweep); the explicit options force one profile — previously
  // this was hard-derived from the chart's timeframe, so picking H1 on the
  // chart silently locked the scanner into intraday with no way to override.
  const [riskMode, setRiskMode] = useState<ScanMode>("auto");
  // SWEEP runs every timeframe the enabled strategies cover and keeps the
  // strongest setup; MTF keeps the classic single-entry + higher-TF tide scan.
  const [scope, setScope] = useState<ScanScope>("sweep");

  const sweepTimeframes = SWEEP_SETS[riskMode];
  // The profile the classic (MTF) path will resolve to, for the header chip.
  const resolvedMode: "intraday" | "scalper" =
    riskMode === "auto" ? modeForTimeframe(timeframe) : riskMode;

  const status = useQuery({
    queryKey: ["market-data-status"],
    queryFn: () => statusFn(),
    refetchInterval: 5_000,
    retry: false,
  });

  const gen = useMutation({
    mutationFn: () => {
      requestedPairRef.current = pair;
      if (scope === "sweep") {
        // Sweep: run the engine on every timeframe in the selected set and
        // return the highest-confluence setup. Scoped to the selected pair so
        // the feed's token bucket stays comfortable.
        return genFn({
          data: { mode: riskMode, pairs: [pair], sweep: true, sweepTimeframes },
        });
      }
      // MTF scan: the server confirms the direction on the higher timeframes
      // (15M/30M/1H/4H/1D intraday, 5M/15M/30M scalper) and generates the
      // entry on the mode's lower timeframe (5M / 1M).
      return genFn({ data: { mode: riskMode, timeframe, pairs: [pair], mtf: true } });
    },
    onSuccess: (data) => {
      // Bail if the user switched symbols while the scan was in flight.
      if (requestedPairRef.current !== pair) return;
      const found = data.signals.find((s) => s.pair === pair);
      if (found) {
        setResult(found as ScanSignal);
        setScanMessage(null);
        setLocalMessage(null);
      } else {
        setResult(null);
        const msg =
          data.warnings.find((w) => w.startsWith(pair)) ?? `${pair}: no confluence setup right now`;
        setScanMessage(msg);
        setLocalMessage(msg);
      }
    },
    onError: (e: Error) => {
      if (requestedPairRef.current !== pair) return;
      setResult(null);
      setScanMessage(e.message);
      setLocalMessage(e.message);
    },
  });

  const rateLimited = status.data?.rate_limit?.limited === true;
  const feedReady = status.data?.configured === true;

  return (
    <aside className="rounded-lg border border-cyber-border bg-cyber-surface p-4 flex flex-col gap-3 overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-mono-strong font-bold text-white">{pair}</span>
            <button
              type="button"
              aria-label={isFavorite(pair) ? `Unstar ${pair}` : `Star ${pair}`}
              onClick={onToggleFavorite}
              className={`transition ${isFavorite(pair) ? "text-neon-warn" : "text-muted-foreground hover:text-neon-warn"}`}
            >
              <Star className="size-4" fill={isFavorite(pair) ? "currentColor" : "none"} />
            </button>
            <span className="text-[10px] font-mono text-neon-accent">{timeframe}</span>
          </div>
        </div>
        {/* Only surfaced when something is wrong. The healthy OANDA_FEED state
            was constant chrome; a degraded feed still needs to be visible,
            because a rate-limited bucket silently changes what a scan sees. */}
        {(rateLimited || !feedReady) && (
          <span className="rounded-sm border border-neon-warn/40 px-2 py-0.5 text-[9px] font-mono text-neon-warn">
            {rateLimited ? "RATE_LIMITED…" : "FEED_OFFLINE"}
          </span>
        )}
      </div>

      {quote && (
        <div className="rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2 grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div>
            <div className="text-[9px] uppercase text-muted-foreground">BID</div>
            <div className="text-white">{formatPrice(pair, quote.bid)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-muted-foreground">ASK</div>
            <div className="text-white">{formatPrice(pair, quote.ask)}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-muted-foreground">SPREAD</div>
            <div className="text-neon-accent">{formatSpread(pair, quote.ask - quote.bid)}</div>
          </div>
        </div>
      )}

      {/* Generation lives in ANALYSIS; SIGNAL is for reading what came out of
          it. Running a scan from the view that cannot draw the result was the
          redundant half. The header above (pair, BID/ASK/SPREAD) is shared. */}
      {view === "signal" && (
        <PairSignalHistory pair={pair} selected={result} onSelect={setResult} />
      )}

      {view === "analysis" && (
        <>
          <div className="space-y-1.5">
            <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
              // RISK_MODE
            </div>
            <div
              className="flex rounded-sm border border-cyber-border bg-cyber-bg p-0.5"
              role="radiogroup"
              aria-label="Risk mode"
            >
              {SCAN_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={riskMode === m}
                  onClick={() => setRiskMode(m)}
                  className={`flex-1 rounded-sm px-2 py-1.5 text-[10px] font-mono uppercase tracking-widest transition ${
                    riskMode === m
                      ? m === "scalper"
                        ? "bg-neon-warn/10 text-neon-warn"
                        : "bg-neon-accent/10 text-neon-accent"
                      : "text-muted-foreground hover:text-white"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
              // SCAN_SCOPE
            </div>
            <div
              className="flex rounded-sm border border-cyber-border bg-cyber-bg p-0.5"
              role="radiogroup"
              aria-label="Scan scope"
            >
              {SCAN_SCOPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={scope === s.id}
                  onClick={() => setScope(s.id)}
                  title={s.hint}
                  className={`flex-1 rounded-sm px-2 py-1.5 text-[10px] font-mono uppercase tracking-widest transition ${
                    scope === s.id
                      ? "bg-neon-accent/10 text-neon-accent"
                      : "text-muted-foreground hover:text-white"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {(scope === "sweep"
                ? sweepTimeframes
                : resolvedMode === "scalper"
                  ? (["M1", "M5", "M15", "M30"] as Granularity[])
                  : (["M5", "M15", "M30", "H1", "H4", "D1"] as Granularity[])
              ).map((tf) => (
                <span
                  key={tf}
                  className="rounded-sm border border-cyber-border bg-cyber-bg px-1.5 py-0.5 text-[9px] font-mono text-neon-long"
                >
                  {tf}
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
              {scope === "sweep"
                ? `SWEEP · ${sweepTimeframes.length}_TF${riskMode === "auto" ? " · PER_TF_RISK" : ""}`
                : `${resolvedMode === "scalper" ? "SCALPER" : "INTRADAY"}_RISK · ${timeframe}`}
            </div>
            <button
              onClick={() => gen.mutate()}
              disabled={gen.isPending || !feedReady}
              className={`inline-flex items-center gap-1.5 rounded-sm border px-3 py-2 text-[10px] font-mono font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                riskMode === "scalper"
                  ? "border-neon-warn/40 bg-neon-warn/10 text-neon-warn hover:bg-neon-warn/20"
                  : "border-neon-accent/40 bg-neon-accent/10 text-neon-accent hover:bg-neon-accent/20"
              }`}
            >
              <Zap className="size-3" />
              {gen.isPending ? "SCANNING…" : "RUN_SCAN"}
            </button>
          </div>

          {gen.isPending && (
            <div className="rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2 font-mono text-[10px] text-muted-foreground">
              {scope === "sweep"
                ? `SWEEPING_${sweepTimeframes.join("_")}`
                : resolvedMode === "scalper"
                  ? "MTF_SCAN_1M_ENTRY_M5_M15_M30_TIDE"
                  : "MTF_SCAN_5M_ENTRY_15M_30M_1H_4H_1D_TIDE"}
              …
            </div>
          )}

          {result && (
            <div className="rounded-sm border border-neon-accent/30 bg-cyber-bg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-bold text-white">
                  {result.pair} ·{" "}
                  <span
                    className={result.direction === "long" ? "text-neon-long" : "text-neon-short"}
                  >
                    {result.direction.toUpperCase()}
                  </span>{" "}
                  · {result.timeframe}
                </span>
                <span className="font-mono text-xs text-neon-accent">{result.confluence}%</span>
              </div>

              {/* Why this is a scalp and not a swing, with the evidence behind it. */}
              <ReasoningStrip signal={result} />

              {/* The placeable order, re-derived from the live mid on every tick. */}
              <OrderTicketCard signal={result} mid={quote ? (quote.bid + quote.ask) / 2 : null} />

              <div className="space-y-1">
                <div className="text-[9px] font-mono uppercase text-muted-foreground">
                  TECHNICAL_READ
                </div>
                {summarizeSignal(result).map((line, index) => (
                  <p key={index} className="text-[11px] leading-snug text-muted-foreground">
                    <span className="text-neon-accent">{index + 1}.</span> {line}
                  </p>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                <ScanField label="ENTRY" value={result.entry} />
                <ScanField label="ATR" value={result.atr} />
                <ScanField label="SL" value={result.stop_loss} tone="short" />
                <ScanField label="TP1" value={result.take_profit_1} tone="long" />
                <ScanField label="TP2" value={result.take_profit_2} tone="long" />
                <ScanField
                  label="EXPIRES"
                  value={`${EXPIRY_LABEL[result.timeframe as Granularity] ?? "90m"}`}
                />
              </div>
              <div>
                <div className="text-[9px] font-mono uppercase text-muted-foreground">
                  VERIFIED STRATEGY VOTES
                </div>
                <div className="mt-0.5 text-[11px] font-mono text-white">
                  {result.contributing_strategies.join(" · ")}
                </div>
              </div>
              {result.rationale && (
                <p className="text-[11px] text-muted-foreground">{result.rationale}</p>
              )}
              <SweepBreakdown signal={result} />
              <ScanContext signal={result} />
              <MarketSourceTag signal={result} />
            </div>
          )}

          {!result && !gen.isPending && scanMessage && (
            <div className="rounded-sm border border-neon-warn/40 bg-neon-warn/5 px-3 py-2 flex items-start gap-2">
              <CircleAlert className="size-3.5 text-neon-warn mt-0.5 shrink-0" />
              <div className="text-[11px] text-muted-foreground">{scanMessage}</div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

const OUTCOME_LABEL: Record<string, { text: string; tone: string }> = {
  // B-single: TP1 was reached, then the breakeven stop took it out. Flat, not a win.
  hit_tp1: { text: "BE_AFTER_TP1", tone: "text-muted-foreground" },
  hit_tp2: { text: "TP2_HIT", tone: "text-neon-long" },
  hit_sl: { text: "SL_HIT", tone: "text-neon-short" },
  invalidated: { text: "INVALIDATED", tone: "text-muted-foreground" },
};

function ageLabel(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * The last three signals this pair produced, with what actually happened to
 * each one.
 *
 * Every generated signal is paper-traded by the engine whether or not you would
 * have taken it — `scoreSignalPerformance` replays the candle path, resolves it
 * to TP1/TP2/SL/invalidated, persists that, and `signal-learning` turns the
 * record into per-strategy trust multipliers. This panel is the visible end of
 * that loop, and it also DRIVES it: the scoring poll runs here too, so leaving
 * the chart open advances the learning rather than requiring the Signal Center
 * to be the open tab.
 *
 * Clicking a row loads it onto the chart with its levels and strategy markup.
 */
function PairSignalHistory({
  pair,
  selected,
  onSelect,
}: {
  pair: string;
  selected: ScanSignal | null;
  onSelect: (signal: ScanSignal | null) => void;
}) {
  const listFn = useServerFn(listSignals);
  const scoreFn = useServerFn(scoreSignalPerformance);

  // Both polls are deliberately SLOWER here than on the Signal Center.
  //
  // Neither is free against the feed's token bucket: `listSignals` batches a
  // quote fetch for every pair holding an open signal, and
  // `scoreSignalPerformance` pulls a candle path PER PAIR to replay it — two
  // tokens each on gold, because of the futures-to-spot rebase. Stacking those
  // at the Signal Center's cadence on top of this page's 2s quote poll pinned
  // the bucket at RATE_LIMITED continuously; measured, not guessed.
  //
  // A minute is ample for this panel. Signals do not arrive faster than that,
  // a fresh scan sets the chart's result directly rather than waiting on a
  // refetch, and an outcome resolving 30s later costs nothing — the learning
  // loop is not latency-sensitive. The query keys match the Signal Center's, so
  // with both pages open React Query dedupes to one request at the faster
  // interval rather than doubling the load.
  const signals = useQuery({
    queryKey: ["signals"],
    queryFn: () => listFn(),
    refetchInterval: 120_000,
    retry: false,
  });
  // Five minutes, not thirty seconds. `scoreSignalPerformance` is inherently
  // bursty: it replays a candle path for EVERY pair holding a live signal, two
  // tokens apiece on gold. At 60s that burst outran the bucket's 1/s refill and
  // held the feed at RATE_LIMITED continuously — measured on this page, not
  // assumed. Outcome resolution has no latency requirement whatsoever; a fill
  // recorded five minutes late trains the model identically. The Signal Center
  // keeps its 30s cadence, and the shared query key means that faster interval
  // wins whenever that page is also open.
  useQuery({
    queryKey: ["signal-performance"],
    queryFn: () => scoreFn(),
    refetchInterval: 300_000,
    retry: false,
  });

  const rows = (signals.data?.signals ?? []).filter((s) => s.pair === pair).slice(0, 3);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
          // LAST_3_SIGNALS
        </span>
        <span className="font-mono text-[8px] uppercase tracking-wider text-muted-foreground">
          paper-traded
        </span>
      </div>

      {signals.isLoading && rows.length === 0 && (
        <p className="font-mono text-[10px] text-muted-foreground">LOADING…</p>
      )}

      {!signals.isLoading && rows.length === 0 && (
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          No signals for {pair} yet. Switch to ANALYSIS and run a scan — results land here and are
          tracked to TP1/TP2/SL automatically.
        </p>
      )}

      {rows.map((signal) => {
        const status = signal.live_status ?? signal.status;
        const outcome = OUTCOME_LABEL[status];
        const r = rForStatus(status);
        const ticket = outcome ? null : classifyOrder(signal, signal.live_mid);
        const isSelected =
          selected != null &&
          selected.entry === signal.entry &&
          selected.timeframe === signal.timeframe &&
          selected.direction === signal.direction;
        return (
          <button
            key={signal.id}
            type="button"
            onClick={() => onSelect(signal as unknown as ScanSignal)}
            className={`w-full rounded-sm border px-2.5 py-2 text-left font-mono transition ${
              isSelected
                ? "border-neon-accent/50 bg-neon-accent/5"
                : "border-cyber-border hover:border-neon-accent/30"
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={`text-[11px] font-bold ${
                  signal.direction === "long" ? "text-neon-long" : "text-neon-short"
                }`}
              >
                {signal.direction.toUpperCase()}
                <span className="ml-1.5 text-[9px] text-muted-foreground">
                  {signal.timeframe} · {signal.confluence}%
                </span>
              </span>
              <span className="text-[8px] text-muted-foreground">
                {ageLabel(signal.created_at as string)} ago
              </span>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span
                className={`text-[10px] ${outcome ? outcome.tone : TICKET_TEXT_TONE[ticket!.tone]}`}
              >
                {outcome ? outcome.text : ticket!.label}
              </span>
              {r != null ? (
                <span
                  className={`text-[10px] ${r > 0 ? "text-neon-long" : r < 0 ? "text-neon-short" : "text-muted-foreground"}`}
                >
                  {r > 0 ? "+" : ""}
                  {r.toFixed(2)}R
                </span>
              ) : (
                <span className="text-[8px] uppercase text-muted-foreground">open</span>
              )}
            </div>
          </button>
        );
      })}

      {rows.length > 0 && (
        <p className="pt-0.5 font-mono text-[8px] leading-relaxed text-muted-foreground">
          Every signal is scored as if taken, so the engine learns from all of them. Click one to
          draw it on the chart.
        </p>
      )}
    </div>
  );
}

const TICKET_TEXT_TONE: Record<OrderTicket["tone"], string> = {
  long: "text-neon-long",
  short: "text-neon-short",
  warn: "text-neon-warn",
  dead: "text-muted-foreground",
};

const EXPIRY_LABEL: Record<Granularity, string> = {
  M1: "10m",
  M5: "15m",
  M15: "30m",
  M30: "60m",
  H1: "90m",
  H4: "4h",
  D1: "24h",
};

function formatPrice(pair: string, price: number) {
  // Gold and crypto in dollars, JPY pairs in 0.01 steps, FX 5 decimals.
  if (pair === "XAUUSD") return price.toFixed(2);
  if (pair === "BTCUSD" || pair === "ETHUSD") return price.toFixed(2);
  if (pair.endsWith("JPY")) return price.toFixed(3);
  return price.toFixed(5);
}

function formatSpread(pair: string, spread: number) {
  // Gold/crypto quoted in dollars; JPY pairs in 0.01 points.
  if (pair === "XAUUSD" || pair === "BTCUSD" || pair === "ETHUSD") {
    return `${spread.toFixed(2)} $`;
  }
  if (pair.endsWith("JPY")) return `${(spread / 0.01).toFixed(1)}p`;
  return `${(spread / 0.0001).toFixed(1)}p`;
}

function ScanField({
  label,
  value,
  tone,
}: {
  label: string;
  value: unknown;
  tone?: "long" | "short";
}) {
  const color =
    tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : "text-white";
  return (
    <div>
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className={color}>{String(value)}</div>
    </div>
  );
}

// The order ticket. A direction alone isn't actionable — this says whether to
// hit the market, park a stop above / limit below, or stand down because price
// already took the stop or the first target.
const TICKET_TONE: Record<OrderTicket["tone"], string> = {
  long: "border-neon-long/40 bg-neon-long/10 text-neon-long",
  short: "border-neon-short/40 bg-neon-short/10 text-neon-short",
  warn: "border-neon-warn/40 bg-neon-warn/10 text-neon-warn",
  dead: "border-cyber-border bg-cyber-surface text-muted-foreground",
};

function OrderTicketCard({ signal, mid }: { signal: ScanSignal; mid: number | null }) {
  const ticket = classifyOrder(signal, mid);
  return (
    <div className={`rounded-sm border px-2.5 py-2 ${TICKET_TONE[ticket.tone]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm font-bold tracking-wide">{ticket.label}</span>
        <span className="font-mono text-[9px] opacity-80">
          {ticket.closed ? "NO_ENTRY" : `${ticket.distanceR}R FROM_PRICE`}
        </span>
      </div>
      <p className="mt-0.5 text-[10px] leading-snug opacity-90">{ticket.note}</p>
    </div>
  );
}

// Per-timeframe sweep breakdown: what every timeframe returned, and which one
// won. Makes it obvious that the scan is no longer pinned to a single TF.
/**
 * Structural mirror of `ArmedSetup` from `@/lib/armed-setup`, declared locally
 * because this arrives as jsonb over the wire and is `unknown` client-side —
 * the same reason `SweepAttempt` is read defensively below.
 */
type ArmedSetupView = {
  direction: "long" | "short";
  conditions: { label: string; met: boolean }[];
  metCount: number;
  totalCount: number;
  trigger: { price: number; description: string } | null;
  invalidation: { price: number; description: string } | null;
  expiresInBars: number;
};

/** Reads the engine's jsonb breadcrumb without assuming any of it is present. */
function engineBlock(newsContext: unknown) {
  const context =
    newsContext && !Array.isArray(newsContext) && typeof newsContext === "object"
      ? (newsContext as Record<string, unknown>)
      : null;
  return context?.strategy_engine as
    | {
        mode?: { verdict: string; reason: string; bias: string | null };
        regime?: {
          regime: string;
          adx: number;
          trendDirection: string | null;
          atrPercentile: number;
          efficiencyRatio: number;
        } | null;
        location?: {
          swingPosition: number;
          label: string;
          chasing: boolean;
          headroomAtr: number | null;
          multiplier: number;
        } | null;
        sweep?: { requested?: string[]; evaluated?: SweepAttempt[]; winner?: string };
      }
    | undefined;
}

const VERDICT_TONE: Record<string, string> = {
  intraday: "border-neon-accent/40 bg-neon-accent/10 text-neon-accent",
  scalp: "border-neon-long/40 bg-neon-long/10 text-neon-long",
  wait: "border-neon-warn/40 bg-neon-warn/10 text-neon-warn",
  stand_down: "border-neon-short/40 bg-neon-short/10 text-neon-short",
};

/**
 * The engine's judgement, stated as evidence rather than as a verdict alone.
 *
 * This is the teaching surface: the mode call, the regime that produced it, and
 * where in the swing range price actually sits. A "wait" with no explanation
 * trains obedience; a "wait" next to "0.84 of the swing range" eventually
 * trains the reader to spot the chase themselves.
 */
function ReasoningStrip({ signal }: { signal: ScanSignal }) {
  const engine = engineBlock(signal.news_context);
  const mode = engine?.mode;
  const regime = engine?.regime;
  const location = engine?.location;
  if (!mode && !regime && !location) return null;

  return (
    <div className="space-y-1.5 rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5">
      {mode && (
        <div className="flex items-start gap-2">
          <span
            className={`shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
              VERDICT_TONE[mode.verdict] ?? "border-cyber-border text-muted-foreground"
            }`}
          >
            {mode.verdict.replace("_", " ")}
          </span>
          <p className="text-[11px] leading-snug text-muted-foreground">{mode.reason}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[9px]">
        {regime && (
          <span className="text-muted-foreground">
            REGIME <span className="text-white">{regime.regime.replace("_", " ")}</span>
            <span className="ml-1 opacity-60">
              ADX {Math.round(regime.adx)} · EFF {regime.efficiencyRatio.toFixed(2)} · ATR{" "}
              {Math.round(regime.atrPercentile * 100)}pct
            </span>
          </span>
        )}
        {location && (
          <span className="text-muted-foreground">
            LOCATION{" "}
            <span className={location.chasing ? "text-neon-warn" : "text-white"}>
              {location.swingPosition.toFixed(2)} {location.label}
            </span>
            {location.chasing && <span className="ml-1 text-neon-warn">CHASING</span>}
            <span className="ml-1 opacity-60">
              ×{location.multiplier.toFixed(2)}
              {location.headroomAtr !== null && ` · ${location.headroomAtr.toFixed(1)} ATR room`}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A setup that is forming but has not triggered. The engine used to discard
 * this entirely and report "no setup" — every condition below was already
 * computed and thrown away.
 */
function ArmedSetupCard({ armed, verdict }: { armed: ArmedSetupView; verdict?: string }) {
  return (
    <div className="space-y-1 rounded-sm border border-neon-warn/30 bg-neon-warn/5 px-2 py-1.5">
      <div className="flex items-center justify-between font-mono text-[9px]">
        <span className="text-neon-warn">
          {armed.direction.toUpperCase()} · ARMED
          {verdict ? <span className="ml-1 opacity-70">{verdict.replace("_", " ")}</span> : null}
        </span>
        <span className="text-muted-foreground">
          {armed.metCount}/{armed.totalCount} CONDITIONS
        </span>
      </div>
      <div className="space-y-0.5">
        {armed.conditions.map((condition) => (
          <div key={condition.label} className="flex items-start gap-1.5 text-[10px]">
            <span
              className={`font-mono ${condition.met ? "text-neon-long" : "text-muted-foreground"}`}
            >
              [{condition.met ? "x" : " "}]
            </span>
            <span className={condition.met ? "text-muted-foreground" : "text-white"}>
              {condition.label}
            </span>
          </div>
        ))}
      </div>
      <div className="space-y-0.5 font-mono text-[9px] text-muted-foreground">
        {armed.trigger && (
          <div>
            TRIGGER <span className="text-neon-accent">{armed.trigger.description}</span>
          </div>
        )}
        {armed.invalidation && (
          <div>
            INVALIDATES <span className="text-neon-short">{armed.invalidation.description}</span>
          </div>
        )}
        <div>EXPIRES IN {armed.expiresInBars} BARS</div>
      </div>
    </div>
  );
}

function SweepBreakdown({ signal }: { signal: ScanSignal }) {
  const context =
    signal.news_context &&
    !Array.isArray(signal.news_context) &&
    typeof signal.news_context === "object"
      ? (signal.news_context as Record<string, unknown>)
      : null;
  const engine = context?.strategy_engine as
    | { sweep?: { requested?: string[]; evaluated?: SweepAttempt[]; winner?: string } }
    | undefined;
  const sweep = engine?.sweep;
  const evaluated = sweep?.evaluated ?? [];
  if (evaluated.length === 0) return null;

  return (
    <div className="rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 space-y-1">
      <div className="flex items-center justify-between text-[9px] font-mono">
        <span className="text-neon-accent">TF_SWEEP</span>
        <span className="text-muted-foreground">
          {evaluated.filter((a) => a.direction).length}/{evaluated.length} WITH_SETUP
        </span>
      </div>
      <div className="space-y-0.5">
        {evaluated.map((attempt) => {
          const won = attempt.timeframe === sweep?.winner;
          return (
            <div
              key={attempt.timeframe}
              title={attempt.reason ?? undefined}
              className={`flex items-center justify-between rounded-sm px-1.5 py-0.5 text-[9px] font-mono ${
                won ? "bg-neon-accent/10 text-neon-accent" : "text-muted-foreground"
              }`}
            >
              <span>
                {attempt.timeframe}
                <span className="ml-1 opacity-60">{attempt.mode}</span>
                {won && " ← BEST"}
              </span>
              {attempt.direction ? (
                <span
                  className={attempt.direction === "long" ? "text-neon-long" : "text-neon-short"}
                >
                  {attempt.direction.toUpperCase()} {attempt.confluence}% · {attempt.strategies}v
                </span>
              ) : attempt.armed ? (
                // "no setup" was never the whole truth — this timeframe has a
                // setup forming, it just has not triggered yet.
                <span className="text-neon-warn">
                  ARMED {(attempt.armed as ArmedSetupView).metCount}/
                  {(attempt.armed as ArmedSetupView).totalCount}
                </span>
              ) : (
                <span className="text-muted-foreground">no setup</span>
              )}
            </div>
          );
        })}
      </div>
      {/* The most-formed armed setup across the sweep, expanded in full. */}
      {(() => {
        const best = evaluated
          .filter((a): a is SweepAttempt & { armed: ArmedSetupView } => Boolean(a.armed))
          .sort((a, b) => b.armed.metCount - a.armed.metCount)[0];
        return best ? <ArmedSetupCard armed={best.armed} verdict={best.modeVerdict} /> : null;
      })()}
    </div>
  );
}

function ScanContext({ signal }: { signal: { news_context: unknown } }) {
  const context =
    signal.news_context &&
    !Array.isArray(signal.news_context) &&
    typeof signal.news_context === "object"
      ? (signal.news_context as Record<string, unknown>)
      : null;
  if (!context) return null;
  const engine = context.strategy_engine as
    | {
        downweighted?: string[];
        evaluated?: string[];
        incompatible?: string[];
        catalog_only?: string[];
        votes?: { strategyId: string }[];
        weights?: { entries?: { strategyId: string; weight: number; downweighted: boolean }[] };
        learning?: {
          multipliers?: { strategyId: string; multiplier: number; verdict: string }[];
        };
        mtf?: {
          confirmed?: "long" | "short" | null;
          alignment?: number;
          agreementScore?: number;
          plan?: { entryTf?: string; directionTfs?: string[] };
          biases?: {
            tf: string;
            direction: "long" | "short" | "neutral";
            strength: number;
            votes: number;
            strategies?: string[];
          }[];
        };
      }
    | undefined;
  const macro = context.macro as
    | {
        events?: { currency: string; title: string; time: string; impact: string }[];
        cot?: { net: number; netPct: number; reportDate: string } | null;
      }
    | undefined;

  const downweighted = engine?.downweighted ?? [];
  const learning = engine?.learning?.multipliers ?? [];
  const mtf = engine?.mtf;

  // Strategy census. "Why did only 2 of my strategies vote?" has four distinct
  // answers and the engine already records all of them; they were just never
  // shown. The sets are disjoint by construction in scanCandlesForSignal:
  //   catalog_only  enabled in the DB but not implemented in the engine
  //   incompatible  implemented, but this timeframe is not in its definition
  //   evaluated     implemented AND timeframe-compatible
  //     of which downweighted = walk-forward weight < DOWNWEIGHT_FLOOR, so it
  //     is blocked from contributing even when its pattern fires
  //   voted         survived all of that AND actually found its setup
  const census = (() => {
    const evaluated = engine?.evaluated ?? [];
    const incompatible = engine?.incompatible ?? [];
    const catalogOnly = engine?.catalog_only ?? [];
    const voted = engine?.votes?.length ?? 0;
    const enabled = evaluated.length + incompatible.length + catalogOnly.length;
    if (enabled === 0) return null;
    return {
      enabled,
      incompatible: incompatible.length,
      catalogOnly: catalogOnly.length,
      evaluated: evaluated.length,
      downweighted: downweighted.length,
      active: evaluated.length - downweighted.length,
      voted,
      incompatibleIds: incompatible,
      catalogOnlyIds: catalogOnly,
    };
  })();
  const events = macro?.events ?? [];
  const cot = macro?.cot ?? null;
  const hasMacro = events.length > 0 || cot != null;

  return (
    <div className="space-y-2">
      {mtf && (
        <div
          className={`rounded-sm border px-2 py-1.5 text-[9px] font-mono ${
            mtf.confirmed
              ? "border-neon-accent/30 bg-neon-accent/5"
              : "border-cyber-border bg-cyber-bg"
          }`}
        >
          <div className="flex items-center justify-between">
            <span
              className={
                mtf.confirmed === "long"
                  ? "text-neon-long"
                  : mtf.confirmed === "short"
                    ? "text-neon-short"
                    : "text-muted-foreground"
              }
            >
              {mtf.confirmed
                ? `MTF_TIDE ${mtf.confirmed.toUpperCase()} · ${mtf.agreementScore}% ALIGNMENT`
                : "MTF_TIDE SPLIT"}
            </span>
            {mtf.plan?.entryTf && (
              <span className="text-muted-foreground">ENTRY_ON_{mtf.plan.entryTf}</span>
            )}
          </div>
          <div className="mt-1 flex gap-1 flex-wrap">
            {(mtf.biases ?? []).map((bias) => (
              <span
                key={bias.tf}
                className={`rounded-sm border px-1 py-0.5 text-[8px] ${
                  bias.direction === "long"
                    ? "border-neon-long/30 text-neon-long"
                    : bias.direction === "short"
                      ? "border-neon-short/30 text-neon-short"
                      : "border-cyber-border text-muted-foreground"
                }`}
                title={(bias.strategies ?? []).join(", ") || bias.tf}
              >
                {bias.tf} {bias.direction === "long" ? "▲" : bias.direction === "short" ? "▼" : "·"}
                {bias.votes > 0 ? ` ${bias.votes}v` : ""}
              </span>
            ))}
          </div>
        </div>
      )}
      {census && (
        <div className="rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 font-mono text-[9px] space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="uppercase tracking-widest text-muted-foreground">
              // STRATEGY_CENSUS
            </span>
            <span className="text-muted-foreground">
              {census.voted} of {census.enabled} voted
            </span>
          </div>
          {/* Bar widths are shares of the enabled catalog, so the drop-off from
              catalog to actual votes is readable at a glance. */}
          <div className="flex h-1.5 overflow-hidden rounded-sm">
            <div
              className="bg-neon-long"
              style={{ width: `${(census.voted / census.enabled) * 100}%` }}
              title={`${census.voted} voted`}
            />
            <div
              className="bg-neon-accent/40"
              style={{ width: `${((census.active - census.voted) / census.enabled) * 100}%` }}
              title={`${census.active - census.voted} ran but found no setup`}
            />
            <div
              className="bg-neon-warn/50"
              style={{ width: `${(census.downweighted / census.enabled) * 100}%` }}
              title={`${census.downweighted} blocked by walk-forward`}
            />
            <div
              className="bg-muted-foreground/25"
              style={{ width: `${(census.incompatible / census.enabled) * 100}%` }}
              title={`${census.incompatible} not valid on this timeframe`}
            />
            <div
              className="bg-neon-short/40"
              style={{ width: `${(census.catalogOnly / census.enabled) * 100}%` }}
              title={`${census.catalogOnly} enabled but not implemented`}
            />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[8.5px] text-muted-foreground">
            <span>
              <span className="text-neon-long">{census.voted}</span> found their setup
            </span>
            <span>
              <span className="text-white">{census.active - census.voted}</span> ran, no setup
            </span>
            <span>
              <span className="text-neon-warn">{census.downweighted}</span> blocked · walk-forward
            </span>
            <span title={census.incompatibleIds.join(", ")}>
              <span className="text-white">{census.incompatible}</span> wrong timeframe
            </span>
            {census.catalogOnly > 0 && (
              <span className="col-span-2" title={census.catalogOnlyIds.join(", ")}>
                <span className="text-neon-short">{census.catalogOnly}</span> enabled but not
                implemented in the engine
              </span>
            )}
          </div>
          <p className="leading-snug text-muted-foreground">
            A strategy only votes when its pattern is actually present, so a low count is normal —
            what matters is how many were even allowed to look.
          </p>
        </div>
      )}
      {learning.length > 0 && (
        <div className="rounded-sm border border-neon-accent/30 bg-neon-accent/5 px-2 py-1.5 text-[9px] font-mono">
          <span className="text-neon-accent">SELF_TUNED</span>{" "}
          <span className="text-muted-foreground">
            {learning.map((l) => `${l.strategyId}×${l.multiplier}`).join(", ")} — trust adjusted
            from resolved outcomes
          </span>
        </div>
      )}
      {downweighted.length > 0 && (
        <div className="rounded-sm border border-neon-warn/30 bg-neon-warn/5 px-2 py-1.5 text-[9px] font-mono">
          <span className="text-neon-warn">DOWNWEIGHTED</span>{" "}
          <span className="text-muted-foreground">
            {downweighted.join(", ")} — failed recent walk-forward accuracy
          </span>
        </div>
      )}
      {hasMacro && (
        <div className="rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 text-[9px] font-mono space-y-1">
          {cot && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">COT {cot.reportDate}</span>
              <span className={cot.net >= 0 ? "text-neon-long" : "text-neon-short"}>
                {cot.net >= 0 ? "LONG" : "SHORT"} {Math.abs(cot.netPct)}%
              </span>
            </div>
          )}
          {events.map((event, index) => (
            <div key={index} className="truncate">
              <span
                className={event.impact === "High" ? "text-neon-warn" : "text-muted-foreground"}
              >
                {event.currency} {event.impact} {event.time}Z
              </span>{" "}
              <span className="text-muted-foreground">{event.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MarketSourceTag({ signal }: { signal: { news_context: unknown } }) {
  const context = signal.news_context;
  const marketData =
    context && !Array.isArray(context) && typeof context === "object"
      ? (context as Record<string, unknown>).market_data
      : null;
  if (!marketData || typeof marketData !== "object") {
    return (
      <div className="rounded-sm border border-neon-warn/30 bg-neon-warn/5 px-2 py-1 text-[9px] font-mono text-neon-warn">
        UNVERIFIED_PRICE
      </div>
    );
  }
  const details = marketData as Record<string, unknown>;
  const note = typeof details.source_note === "string" ? details.source_note : null;
  return (
    <div className="rounded-sm border border-neon-long/30 bg-neon-long/5 px-2 py-1 text-[9px] font-mono text-neon-long">
      <Radio className="mr-1 inline size-2.5" />
      {String(details.provider)} • {String(details.price_type)}
      {note && <div className="mt-0.5 text-[9px] text-neon-warn">⚠ {note}</div>}
    </div>
  );
}
