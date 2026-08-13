import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  getXauusdPaperAccount,
  getXauusdPaperSignalDetail,
  listXauusdPaperSignals,
  type PaperSignalDetail,
  type PaperSignalListItem,
} from "@/lib/xauusd-paper.functions";
import { getMarketCandles, getMarketQuotes } from "@/lib/market-data.functions";
import { MARKET_TIMEFRAMES, type MarketCandle } from "@/lib/market-data.server";
import { classifyOrder, summarizeSignal, type OrderTicket } from "@/lib/order-ticket";
import { computePaperPosition } from "@/lib/xauusd-paper-pnl";
import { summarizePaperAccount, type PaperAccountSummary } from "@/lib/xauusd-paper-view";
import { PAPER_LOT_SIZE } from "@/lib/paper-trade-state";
import {
  simulateExitPolicies,
  EXIT_POLICY_LABEL,
  type PolicySimResult,
} from "@/lib/paper-policy-sim";
import { computeHoldStats, openTradeMeters } from "@/lib/paper-proximity";
import {
  buildLocationOverlay,
  buildOverlays,
  type ChartOverlays,
  type OverlayMarker,
} from "@/lib/chart-overlays";
import { Star, Radio, CircleAlert } from "lucide-react";
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
          "Real-time OANDA chart with canonical paper-trade levels, strategy markup and overlays.",
      },
      { property: "og:title", content: "Live Chart — MDTAlphaFX" },
      {
        property: "og:description",
        content:
          "Real-time OANDA chart with canonical paper-trade levels, strategy markup and overlays.",
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
    hint: "The terminal's chart: canonical paper entry/SL/TP levels and strategy markup.",
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

// Canonical rows are mapped into this local shape so the existing chart,
// ticket and technical-read code keeps working unchanged. news_context is
// always null — canonical signals carry `rationale` + engine accounting in the
// DTO instead of the old jsonb blob.
type ScanSignal = {
  id?: string;
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
  trade: PaperSignalListItem["trade"] | null;
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

// Paper states that mean the trade is still live (armed, filled, or
// breakeven-protected). Closed/expired trades are history, not a position.
const ACTIVE_PAPER_STATES: Record<string, true> = {
  waiting_entry: true,
  open: true,
  tp1_protected: true,
};

function toScanSignal(dto: PaperSignalListItem): ScanSignal {
  return {
    id: dto.id,
    pair: dto.pair,
    direction: dto.direction,
    mode: dto.mode,
    timeframe: dto.timeframe,
    entry: dto.entry,
    stop_loss: dto.stopLoss,
    take_profit_1: dto.takeProfit1,
    take_profit_2: dto.takeProfit2,
    atr: dto.atr,
    confluence: dto.confluence,
    contributing_strategies: dto.contributingStrategies,
    rationale: dto.rationale,
    news_context: null,
    trade: dto.trade,
  };
}

function Chart() {
  // Gold-first: the user primarily trades XAUUSD and it is a pinned favorite.
  const [symbol, setSymbol] = useState("XAUUSD");
  const [pairQuery, setPairQuery] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [timeframe, setTimeframe] = useState<Granularity>("H1");
  const [result, setResult] = useState<ScanSignal | null>(null);
  const [view, setView] = useState<ChartView>("signal");

  // Canonical paper rows for the current pair + timeframe — the ONLY source of
  // signals now that browser scanning is retired. The worker owns XAUUSD only;
  // other pairs simply have no canonical history.
  const paperSignalsFn = useServerFn(listXauusdPaperSignals);
  const paperSignalsQ = useQuery({
    queryKey: ["xauusd-paper-signals", false],
    queryFn: () => paperSignalsFn({ data: { archived: false } }),
    refetchInterval: 60_000,
    retry: false,
  });

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

  const mid = liveQuote ? (liveQuote.bid + liveQuote.ask) / 2 : null;

  // Account rows (every worker signal, archived included) folded into the $
  // terminal-bar summary. Fetched separately from paperSignalsQ because that
  // list filters archived_at IS NULL — realized P&L would otherwise drop every
  // closed trade the archive job has moved out.
  const accountFn = useServerFn(getXauusdPaperAccount);
  const accountQ = useQuery({
    queryKey: ["xauusd-paper-account"],
    queryFn: () => accountFn(),
    refetchInterval: 60_000,
    retry: false,
  });
  const account = useMemo(
    () => summarizePaperAccount(accountQ.data ?? [], mid),
    [accountQ.data, mid],
  );

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
  }, [symbol]);

  // Auto-select the live position for the current pair + timeframe once it
  // arrives, so the chart draws the open trade's levels without a manual
  // click. Falls back to the newest signal (any state) when nothing is live.
  // Only fires while nothing is selected yet.
  const chartSignals =
    paperSignalsQ.data
      ?.filter((s) => s.pair === symbol && s.timeframe === timeframe)
      .sort((a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc)) ?? [];
  const pinnedForChart =
    chartSignals.find((s) => ACTIVE_PAPER_STATES[s.trade.state]) ?? chartSignals[0];
  useEffect(() => {
    if (pinnedForChart && !result) setResult(toScanSignal(pinnedForChart));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedForChart?.id]);

  return (
    <div className="p-6 space-y-4 h-[calc(100vh-3.5rem)] flex flex-col">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Live Chart</h1>
        </div>
        <div className="flex flex-col gap-1.5 items-end">
          <div className="flex gap-1 flex-wrap items-center">
            {/* SIGNAL is the terminal's own chart: canonical paper levels,
                strategy markup, live tick engine. ANALYSIS is TradingView's
                widget: drawing tools and their indicator library, but a
                cross-origin iframe nothing can be drawn into. Two views
                instead of one compromise. */}
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
      <AccountBar account={account} />

      <div className="flex-1 grid gap-4 lg:grid-cols-[1fr_380px] min-h-0">
        {/* Only the left panel swaps. PairScanner stays mounted in both views,
            so BID/ASK/SPREAD and the read-only signal history are untouched by
            the choice — they never read the chart. */}
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
          paperSignals={paperSignalsQ.data ?? []}
          paperLoading={paperSignalsQ.isLoading}
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

  // Entry + exit markers. One setMarkers call — the plugin replaces the whole
  // set each time, so they have to go in together. Entry sits at the actual
  // fill time when the trade carries one (else the newest loaded bar); a closed
  // trade also draws its exit arrow at the resolved bar so a TP2 winner and a
  // stop-out are visually distinct, not just two rows in a list.
  const markers: SeriesMarker<UTCTimestamp>[] = overlayMarkers.map((marker) => ({
    time: marker.time as UTCTimestamp,
    position: marker.position,
    color: marker.color,
    shape: marker.shape,
    text: marker.text,
  }));
  const trade = result.trade;
  const last = bars[bars.length - 1];

  const entryTime = (() => {
    if (trade?.entryTime) {
      const sec = Math.floor(Date.parse(trade.entryTime) / 1000);
      if (Number.isFinite(sec)) return sec as UTCTimestamp;
    }
    return last?.time ?? null;
  })();
  if (entryTime != null) {
    markers.push({
      time: entryTime,
      position: result.direction === "long" ? "belowBar" : "aboveBar",
      color: result.direction === "long" ? UP : DOWN,
      shape: result.direction === "long" ? "arrowUp" : "arrowDown",
      text: `${result.direction.toUpperCase()} ${result.confluence}%`,
    });
  }

  if (trade?.tp1ArmedAt) {
    const tp1Sec = Math.floor(Date.parse(trade.tp1ArmedAt) / 1000);
    if (Number.isFinite(tp1Sec)) {
      markers.push({
        time: tp1Sec as UTCTimestamp,
        position: result.direction === "long" ? "belowBar" : "aboveBar",
        color: SOFT_GREEN,
        shape: "circle",
        text: "TP1 · BE ARMED",
      });
    }
  }

  if (trade?.exitTime && trade.exitPrice != null) {
    const exitSec = Math.floor(Date.parse(trade.exitTime) / 1000);
    if (Number.isFinite(exitSec)) {
      const isWin = trade.state === "closed_tp2";
      const isLoss = trade.state === "closed_stop";
      markers.push({
        time: exitSec as UTCTimestamp,
        position: result.direction === "long" ? "aboveBar" : "belowBar",
        color: isWin ? UP : isLoss ? DOWN : SOFT_GREEN,
        shape: result.direction === "long" ? "arrowDown" : "arrowUp",
        text: isWin ? "EXIT TP2" : isLoss ? "EXIT SL" : "EXIT BE",
      });
    }
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
  // Live-position read: the selected signal's canonical trade state, plus its
  // floating P&L when the engine has actually filled it (open / tp1_protected).
  const tradeState = result?.trade?.state ?? null;
  const stateMeta = tradeState ? PAPER_STATE_LABEL[tradeState] : null;
  const floating = (() => {
    if (!result) return null;
    if (tradeState !== "open" && tradeState !== "tp1_protected") return null;
    const current = lastPrice ?? (quote ? (quote.bid + quote.ask) / 2 : null);
    const entryPrice = result.trade?.entryPrice ?? result.entry;
    if (current == null) return null;
    return computePaperPosition({
      direction: result.direction,
      entry: entryPrice,
      stopLoss: result.stop_loss,
      lotSize: PAPER_LOT_SIZE,
      current,
    });
  })();
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
          {stateMeta && (
            <div className="mt-1 flex items-center gap-2 border-t border-cyber-border pt-1">
              <span className={stateMeta.tone}>{stateMeta.text}</span>
              {floating && (
                <span
                  className={
                    floating.usd > 0
                      ? "text-neon-long"
                      : floating.usd < 0
                        ? "text-neon-short"
                        : "text-muted-foreground"
                  }
                >
                  {fmtUsd(floating.usd)} · {floating.r > 0 ? "+" : ""}
                  {floating.r.toFixed(2)}R
                </span>
              )}
            </div>
          )}
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
// AccountBar — the MT5 terminal strip for the imaginary paper account.
// ---------------------------------------------------------------------------

function fmtUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function AccountStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "long" | "short" | "accent" | "muted";
}) {
  const color =
    tone === "long"
      ? "text-neon-long"
      : tone === "short"
        ? "text-neon-short"
        : tone === "accent"
          ? "text-neon-accent"
          : "text-white";
  return (
    <div className="flex flex-col">
      <span className="text-[8px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={`font-mono text-[11px] ${color}`}>{value}</span>
    </div>
  );
}

function AccountBar({ account }: { account: PaperAccountSummary }) {
  const floatingTone =
    account.floatingUsd > 0 ? "long" : account.floatingUsd < 0 ? "short" : "muted";
  const realizedTone =
    account.realizedUsd > 0 ? "long" : account.realizedUsd < 0 ? "short" : "muted";
  const equityTone = account.equityUsd >= account.startingBalanceUsd ? "long" : "short";
  return (
    <div className="flex flex-wrap items-center gap-5 rounded-lg border border-cyber-border bg-cyber-surface px-4 py-2">
      <span className="font-mono text-[8px] uppercase tracking-widest text-neon-accent">
        // PAPER_ACCOUNT
      </span>
      <AccountStat label="BALANCE" value={fmtUsd(account.balanceUsd)} />
      <AccountStat label="EQUITY" value={fmtUsd(account.equityUsd)} tone={equityTone} />
      <AccountStat label="FLOATING" value={fmtUsd(account.floatingUsd)} tone={floatingTone} />
      <AccountStat label="OPEN" value={String(account.openCount)} tone="accent" />
      <AccountStat label="REALIZED" value={fmtUsd(account.realizedUsd)} tone={realizedTone} />
      <AccountStat
        label="MAX DD"
        value={fmtUsd(-account.maxDrawdownUsd)}
        tone={account.maxDrawdownUsd > 0 ? "short" : "muted"}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PairScanner — read-only research over the canonical paper history.
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
  paperSignals,
  paperLoading,
}: {
  pair: string;
  timeframe: Granularity;
  view: ChartView;
  quote: LiveQuote;
  isFavorite: (p: string) => boolean;
  onToggleFavorite: () => void;
  result: ScanSignal | null;
  setResult: (r: ScanSignal | null) => void;
  paperSignals: PaperSignalListItem[];
  paperLoading: boolean;
}) {
  // Browser scanning is retired: canonical signals come only from the
  // unattended auto-paper worker (XAUUSD, 0.01-lot, no broker connection). This
  // panel is READ-ONLY research over the worker's history plus the selected
  // signal's levels — it can never generate a signal itself.
  const rows = paperSignals
    .filter((s) => s.pair === pair && s.timeframe === timeframe)
    .sort((a, b) => Date.parse(b.timestampUtc) - Date.parse(a.timestampUtc))
    .slice(0, 3);

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

      {/* SIGNAL is for reading the worker's canonical history; ANALYSIS holds
          the selected signal's research card. Neither can generate a signal —
          the unattended Auto-Paper worker owns generation now. */}
      {view === "signal" && (
        <PairSignalHistory
          pair={pair}
          timeframe={timeframe}
          selected={result}
          onSelect={setResult}
          rows={rows}
          loading={paperLoading}
        />
      )}

      {view === "analysis" && (
        <>
          <DisabledScanNotice />
          {result ? (
            <>
              <ResearchCard
                signal={result}
                dto={rows.find((r) => r.entry === result.entry)}
                mid={quote ? (quote.bid + quote.ask) / 2 : null}
              />
              <AutopsyCard
                signal={result}
                pair={pair}
                timeframe={timeframe}
                quote={quote}
                paperSignals={paperSignals}
              />
            </>
          ) : (
            <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
              Select a signal from the SIGNAL view to inspect its order ticket, technical read and
              paper provenance.
            </p>
          )}
        </>
      )}
    </aside>
  );
}

/**
 * Manual scan controls are retired. Signals are generated only by the
 * unattended Auto-Paper worker (XAUUSD, 0.01 lot, no broker connection) — this
 * panel reads its history and can never call a generator.
 */
function DisabledScanNotice() {
  return (
    <div className="flex items-start gap-2 rounded-sm border border-neon-warn/30 bg-neon-warn/5 px-2.5 py-2">
      <CircleAlert className="mt-0.5 size-3 shrink-0 text-neon-warn" />
      <p className="font-mono text-[9.5px] leading-snug text-muted-foreground">
        SCANS_RETIRED — signals come from the unattended Auto-Paper worker only.{" "}
        <Link to="/dashboard" className="text-neon-accent underline-offset-2 hover:underline">
          AUTO_PAPER →
        </Link>
      </p>
    </div>
  );
}

/** Canonical paper trade states — the worker's B-single machine, not a guess. */
const PAPER_STATE_LABEL: Record<string, { text: string; tone: string }> = {
  waiting_entry: { text: "WAITING_ENTRY", tone: "text-muted-foreground" },
  open: { text: "OPEN", tone: "text-neon-accent" },
  tp1_protected: { text: "TP1_PROTECTED", tone: "text-neon-accent" },
  closed_tp2: { text: "TP2_HIT", tone: "text-neon-long" },
  closed_breakeven: { text: "BE_AFTER_TP1", tone: "text-muted-foreground" },
  closed_stop: { text: "SL_HIT", tone: "text-neon-short" },
  expired: { text: "EXPIRED", tone: "text-muted-foreground" },
};

function ageLabel(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/**
 * The last three canonical signals this pair produced, with what the paper
 * engine actually did with each one (B-single: TP1 then breakeven, TP2, SL, or
 * expiry). Clicking a row draws its levels and strategy markup on the chart.
 */
function PairSignalHistory({
  pair,
  timeframe,
  selected,
  onSelect,
  rows,
  loading,
}: {
  pair: string;
  timeframe: Granularity;
  selected: ScanSignal | null;
  onSelect: (signal: ScanSignal | null) => void;
  rows: PaperSignalListItem[];
  loading: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
          // LAST_3_SIGNALS
        </span>
        <span className="font-mono text-[8px] uppercase tracking-wider text-neon-accent">
          paper · 0.01 lot
        </span>
      </div>

      {loading && rows.length === 0 && (
        <p className="font-mono text-[10px] text-muted-foreground">LOADING…</p>
      )}

      {!loading && rows.length === 0 && (
        <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
          No canonical signals for {pair} on {timeframe} yet. The Auto-Paper worker generates XAUUSD
          signals unattended — enable it from the Dashboard.
        </p>
      )}

      {rows.map((signal) => {
        const state = PAPER_STATE_LABEL[signal.trade.state];
        const isSelected = selected?.id === signal.id;
        const terminal = signal.trade.resultR != null;
        return (
          <button
            key={signal.id}
            type="button"
            onClick={() => onSelect(toScanSignal(signal))}
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
              <span
                className="text-[8px] text-muted-foreground"
                title={`UTC ${signal.timestampUtc}`}
              >
                {ageLabel(signal.timestampUtc)} ago
              </span>
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2">
              <span className={`text-[9px] ${state ? state.tone : "text-muted-foreground"}`}>
                {state ? state.text : signal.trade.state.toUpperCase()}
              </span>
              {terminal ? (
                <span
                  className={`text-[10px] ${
                    signal.trade.resultR! > 0
                      ? "text-neon-long"
                      : signal.trade.resultR! < 0
                        ? "text-neon-short"
                        : "text-muted-foreground"
                  }`}
                >
                  {signal.trade.resultR! > 0 ? "+" : ""}
                  {signal.trade.resultR!.toFixed(2)}R
                </span>
              ) : (
                <span className="text-[8px] uppercase text-muted-foreground">open</span>
              )}
            </div>
            <div
              className="mt-1 text-[8px] text-muted-foreground"
              title={`UTC ${signal.timestampUtc}`}
            >
              {signal.timestampPht}
            </div>
          </button>
        );
      })}

      {rows.length > 0 && (
        <p className="pt-0.5 font-mono text-[8px] leading-relaxed text-muted-foreground">
          Every signal is paper-traded by the engine and resolved to TP1/TP2/SL automatically. Click
          one to draw it on the chart.
        </p>
      )}
    </div>
  );
}

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

/**
 * The research card for a canonical paper signal. The engine's jsonb breadcrumb
 * (mode verdict, sweep breakdown, macro events, strategy census) is not stored
 * on canonical rows — their DTO carries `rationale` + engine accounting
 * instead, so the read is assembled from those.
 */
function ResearchCard({
  signal,
  dto,
  mid,
}: {
  signal: ScanSignal;
  dto: PaperSignalListItem | undefined;
  mid: number | null;
}) {
  return (
    <div className="rounded-sm border border-neon-accent/30 bg-cyber-bg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-bold text-white">
          {signal.pair} ·{" "}
          <span className={signal.direction === "long" ? "text-neon-long" : "text-neon-short"}>
            {signal.direction.toUpperCase()}
          </span>{" "}
          · {signal.timeframe}
        </span>
        <span className="font-mono text-xs text-neon-accent">{signal.confluence}%</span>
      </div>

      <div className="rounded-sm border border-neon-accent/30 bg-neon-accent/5 px-2 py-1 font-mono text-[8.5px] uppercase tracking-wider text-neon-accent">
        PAPER ONLY · 0.01 LOT · NO BROKER CONNECTION
      </div>

      <OrderTicketCard signal={signal} mid={mid} />

      <div className="space-y-1">
        <div className="text-[9px] font-mono uppercase text-muted-foreground">TECHNICAL_READ</div>
        {summarizeSignal(signal).map((line, index) => (
          <p key={index} className="text-[11px] leading-snug text-muted-foreground">
            <span className="text-neon-accent">{index + 1}.</span> {line}
          </p>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
        <ScanField label="ENTRY" value={signal.entry} />
        <ScanField label="ATR" value={signal.atr} />
        <ScanField label="SL" value={signal.stop_loss} tone="short" />
        <ScanField label="TP1" value={signal.take_profit_1} tone="long" />
        <ScanField label="TP2" value={signal.take_profit_2} tone="long" />
        <ScanField
          label="EXPIRES"
          value={`${EXPIRY_LABEL[signal.timeframe as Granularity] ?? "90m"}`}
        />
      </div>
      <div>
        <div className="text-[9px] font-mono uppercase text-muted-foreground">
          VERIFIED STRATEGY VOTES
        </div>
        <div className="mt-0.5 text-[11px] font-mono text-white">
          {signal.contributing_strategies.join(" · ")}
        </div>
      </div>
      {signal.rationale && <p className="text-[11px] text-muted-foreground">{signal.rationale}</p>}
      {dto && (
        <>
          <div className="flex items-start gap-1.5 rounded-sm border border-neon-long/30 bg-neon-long/5 px-2 py-1 text-[9px] font-mono text-neon-long">
            <Radio className="mt-0.5 size-2.5 shrink-0" />
            <span>
              {dto.provider.name} · {dto.provider.instrument}
              <span className="block text-[8.5px] text-muted-foreground">
                PROVIDER_TIME {dto.provider.providerTime} UTC · {dto.timestampPht} PHT
              </span>
            </span>
          </div>
          {dto.engine.accounting && (
            <div className="rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 font-mono text-[9px] space-y-0.5">
              <div className="uppercase tracking-widest text-muted-foreground">
                // ENGINE_ACCOUNTING
              </div>
              <div className="text-muted-foreground">
                <span className="text-white">{dto.engine.accounting.evaluated.length}</span>{" "}
                evaluated ·{" "}
                <span className="text-white">{dto.engine.accounting.abstained.length}</span>{" "}
                abstained ·{" "}
                <span className="text-white">{dto.engine.accounting.failed.length}</span> failed
              </div>
              <div className="text-[8px] text-muted-foreground">
                v{dto.engine.version || "?"} · policy {dto.engine.policyVersion || "?"}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AutopsyCard — the signal autopsy. For the selected canonical signal this
// answers, with the owner's own ledger and the chart's candles:
//   1. What actually happened (state, R, journey: peak MFE / trough MAE,
//      bars held, ambiguity) and the exact event sequence the worker recorded.
//   2. If the trade is open: how far TP1 and SL are, live, in R and $, and
//      what fraction of resolved trades at this proximity actually reached
//      TP1 (the ledger's own "will it hold?" estimate).
//   3. If it resolved: what each alternative exit policy WOULD have done on
//      the same candles (close at TP1 / trail 1.0xATR after TP1 / early BE at
//      +0.5R), against the CURRENT B-single control.
// The policy comparison is analysis only — the live worker keeps b_single_v1
// until the ledger says a policy wins.
// ---------------------------------------------------------------------------

const EVENT_LABEL: Record<string, string> = {
  market_observed: "OBSERVED",
  entry_filled: "ENTRY FILL",
  tp1_protected: "TP1 · BE ARMED",
  closed_tp2: "TP2 HIT",
  closed_breakeven: "BE EXIT",
  closed_stop: "SL HIT",
  expired: "EXPIRED",
};

const SIM_STATE_LABEL: Record<PolicySimResult["state"], { text: string; tone: string }> = {
  closed_tp2: { text: "TP2 +2R", tone: "text-neon-long" },
  closed_tp1: { text: "TP1", tone: "text-neon-long" },
  closed_breakeven: { text: "BE 0R", tone: "text-muted-foreground" },
  closed_stop: { text: "SL -1R", tone: "text-neon-short" },
  trail_exit: { text: "TRAIL EXIT", tone: "text-neon-accent" },
  still_open: { text: "STILL OPEN", tone: "text-muted-foreground" },
};

function fmtR(value: number | null): string {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function durationLabel(fromIso: string | null, toIso: string | null): string {
  if (!fromIso || !toIso) return "—";
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function evidencePrice(evidence: Record<string, string | number | boolean | null>): string | null {
  const price =
    typeof evidence.entryPrice === "number" ? evidence.entryPrice : typeof evidence.exitPrice === "number" ? evidence.exitPrice : null;
  return price == null ? null : price.toFixed(2);
}

function AutopsyCard({
  signal,
  pair,
  timeframe,
  quote,
  paperSignals,
}: {
  signal: ScanSignal;
  pair: string;
  timeframe: Granularity;
  quote: LiveQuote;
  paperSignals: PaperSignalListItem[];
}) {
  const detailFn = useServerFn(getXauusdPaperSignalDetail);
  const candlesFn = useServerFn(getMarketCandles);

  const detailQ = useQuery({
    queryKey: ["paper-signal-detail", signal.id],
    queryFn: () => detailFn({ data: { signalId: signal.id } }),
    enabled: !!signal.id,
    retry: false,
  });
  const detail: PaperSignalDetail | null = detailQ.data?.detail ?? null;
  const trade = detail?.trade ?? null;
  const mid = quote ? (quote.bid + quote.ask) / 2 : null;
  const resolved = trade != null && trade.resultR != null;
  const active = trade != null && ACTIVE_PAPER_STATES[trade.state] === true;

  const candlesQ = useQuery({
    queryKey: ["market-candles", pair, timeframe],
    queryFn: () => candlesFn({ data: { pair, granularity: timeframe, count: 300 } }),
    enabled: !!detail && !!trade?.entryTime && detail.timeframe === timeframe,
    refetchInterval: CANDLE_POLL_MS[timeframe],
    retry: false,
  });

  const holdStats = useMemo(() => computeHoldStats(paperSignals, pair, timeframe), [
    paperSignals,
    pair,
    timeframe,
  ]);

  const meters = useMemo(
    () => (active && detail ? openTradeMeters(detail, mid) : null),
    [active, detail, mid],
  );

  const sims = useMemo<PolicySimResult[] | null>(() => {
    if (!detail || !trade || !resolved || !trade.entryTime || detail.timeframe !== timeframe) {
      return null;
    }
    const candles = (candlesQ.data?.candles ?? [])
      .filter((c) => c.time != null)
      .map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (candles.length === 0) return null;
    if (Date.parse(candles[0].time) > Date.parse(trade.entryTime)) return null; // no coverage
    return simulateExitPolicies({
      direction: detail.direction,
      entry: trade.entryPrice ?? detail.entry,
      stopLoss: detail.stopLoss,
      takeProfit1: detail.takeProfit1,
      takeProfit2: detail.takeProfit2,
      atr: detail.atr,
      entryTime: trade.entryTime,
      candles,
    });
  }, [detail, trade, resolved, timeframe, candlesQ.data]);

  if (!signal.id) return null;
  if (detailQ.isLoading) {
    return (
      <div className="rounded-sm border border-cyber-border bg-cyber-surface px-3 py-2 font-mono text-[9px] text-muted-foreground">
        // AUTOPSY — LOADING…
      </div>
    );
  }
  if (detailQ.isError || !detail) {
    return (
      <div className="rounded-sm border border-cyber-border bg-cyber-surface px-3 py-2 font-mono text-[9px] text-muted-foreground">
        // AUTOPSY — UNAVAILABLE
      </div>
    );
  }
  if (!trade) return null; // canonical rows always carry a trade (mapper enforces)

  const stateMeta = PAPER_STATE_LABEL[trade.state] ?? { text: trade.state.toUpperCase(), tone: "text-muted-foreground" };
  const tp1DistR = Math.abs(detail.takeProfit1 - detail.entry) / Math.max(1e-9, Math.abs(detail.entry - detail.stopLoss));
  const peakProgressPct = trade.mfeR != null ? Math.round(Math.min(100, (trade.mfeR / tp1DistR) * 100)) : null;

  return (
    <div className="rounded-sm border border-neon-accent/40 bg-cyber-bg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-bold tracking-widest text-neon-accent">
          // AUTOPSY
        </span>
        <span className={`rounded-sm border px-1.5 py-0.5 font-mono text-[8px] uppercase ${stateMeta.tone}`}>
          {stateMeta.text}
        </span>
      </div>

      {/* Journey — what actually happened */}
      <div className="rounded-sm border border-cyber-border bg-cyber-surface px-2.5 py-2 font-mono text-[10px] space-y-1">
        <div className="flex items-baseline justify-between">
          <span className="text-[8px] uppercase tracking-widest text-muted-foreground">
            {resolved ? "RESOLVED" : active ? "LIVE" : "EXPIRED"}
          </span>
          <span
            className={
              trade.resultR != null
                ? trade.resultR > 0
                  ? "text-neon-long"
                  : trade.resultR < 0
                    ? "text-neon-short"
                    : "text-muted-foreground"
                : "text-neon-accent"
            }
          >
            {fmtR(trade.resultR)}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          <div>
            <span className="text-muted-foreground">PEAK </span>
            <span className="text-neon-long">{fmtR(trade.mfeR)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">TROUGH </span>
            <span className="text-neon-short">{fmtR(trade.maeR)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">BARS </span>
            <span className="text-white">{trade.barsHeld}</span>
          </div>
          <div>
            <span className="text-muted-foreground">DURATION </span>
            <span className="text-white">{durationLabel(trade.entryTime, trade.exitTime)}</span>
          </div>
        </div>
        {resolved && peakProgressPct != null && (
          <p className="text-[9px] text-muted-foreground">
            {trade.mfeR != null && trade.mfeR >= tp1DistR
              ? "REACHED TP1 — " +
                (trade.state === "closed_tp2"
                  ? "THE RUNNER CONTINUED TO TP2"
                  : "THEN THE STOP TOOK IT BACK")
              : `REACHED ${peakProgressPct}% OF THE WAY TO TP1 — NEVER TOUCHED IT`}
          </p>
        )}
        {trade.ambiguousIntrabar && (
          <p className="text-[9px] text-neon-warn">
            AMBIGUOUS INTRABAR — STOP AND TARGET TOUCHED IN THE SAME CANDLE, RESOLVED ADVERSARIALLY
            TO THE STOP
          </p>
        )}
      </div>

      {/* Live meters — will it still hold until TP1? */}
      {active && (
        <div className="rounded-sm border border-cyber-border bg-cyber-surface px-2.5 py-2 font-mono text-[10px] space-y-1.5">
          <div className="text-[8px] uppercase tracking-widest text-muted-foreground">
            LIVE · HOLD-TO-TP1 METERS
          </div>
          {meters ? (
            <div className="grid grid-cols-3 gap-x-3 gap-y-0.5">
              <div>
                <span className="text-muted-foreground">TO_TP1 </span>
                <span className="text-neon-long">{fmtR(meters.toTp1R)}</span>
                <span className="block text-[8px] text-muted-foreground">
                  ${meters.toTp1Usd.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">TO_SL </span>
                <span className="text-neon-accent">{fmtR(meters.toSlR)}</span>
                <span className="block text-[8px] text-muted-foreground">
                  {meters.progressPct != null ? `${Math.round(meters.progressPct)}% TO TP1` : "—"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">BE </span>
                <span className="text-white">
                  {trade.state === "tp1_protected" ? "ARMED" : "AT TP1 ONLY"}
                </span>
                <span className="block text-[8px] text-muted-foreground">
                  {trade.tp1ArmedAt ? "PROTECTED" : "NOT YET"}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-[9px] text-muted-foreground">NO QUOTE — WAITING FOR THE TAPE</p>
          )}
          <HoldOdds holdStats={holdStats} progressPct={meters?.progressPct ?? null} timeframe={timeframe} />
        </div>
      )}

      {/* Ledger hold-odds (resolved context too) */}
      {resolved && <HoldOdds holdStats={holdStats} progressPct={peakProgressPct} timeframe={timeframe} />}

      {/* Event timeline */}
      <div className="space-y-1">
        <div className="text-[8px] font-mono uppercase tracking-widest text-muted-foreground">
          EVENT LEDGER
        </div>
        <div className="max-h-44 space-y-0.5 overflow-y-auto pr-1">
          {detail.events.length === 0 && (
            <p className="font-mono text-[9px] text-muted-foreground">NO EVENTS RECORDED</p>
          )}
          {detail.events.map((event) => (
            <div
              key={event.sequence}
              className="flex items-baseline justify-between gap-2 font-mono text-[9px]"
            >
              <span className="shrink-0 text-muted-foreground">
                {event.sequence}.{" "}
                <span className="text-white">{EVENT_LABEL[event.type] ?? event.type}</span>
              </span>
              <span className="shrink-0 text-muted-foreground">
                {event.beforeState && event.beforeState !== event.afterState
                  ? `${event.beforeState.toUpperCase()}→${event.afterState?.toUpperCase()}`
                  : event.afterState
                    ? event.afterState.toUpperCase()
                    : ""}
              </span>
              <span className="shrink-0 text-neon-accent">
                {evidencePrice(event.evidence) ?? ""}
              </span>
              <span className="ml-auto shrink-0 text-muted-foreground">{event.workerTimePht}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Policy what-if */}
      <div className="space-y-1">
        <div className="text-[8px] font-mono uppercase tracking-widest text-muted-foreground">
          WHAT-IF · EXIT POLICIES
        </div>
        {!resolved && (
          <p className="font-mono text-[9px] text-muted-foreground">
            RESOLVED TRADES ONLY — THE OPEN TRADE IS SIMULATED BY THE LIVE WORKER
          </p>
        )}
        {resolved && !sims && (
          <p className="font-mono text-[9px] text-muted-foreground">
            NEED CANDLES FROM {trade.entryTime ? new Date(trade.entryTime).toISOString() : "ENTRY"} —
            SHOW {timeframe} ON THE CHART OR SCROLL BACK
          </p>
        )}
        {resolved && sims && (
          <div className="space-y-1">
            {sims.map((sim) => {
              const meta = SIM_STATE_LABEL[sim.state];
              const isCurrent = sim.policy === "b_single_v1";
              const bestR = Math.max(...sims.map((s) => s.resultR ?? -999));
              const isBest = sim.resultR != null && sim.resultR === bestR && !isCurrent;
              return (
                <div
                  key={sim.policy}
                  className={`flex items-baseline justify-between gap-2 rounded-sm border px-2 py-1 font-mono text-[9px] ${
                    isCurrent
                      ? "border-neon-accent/50 bg-neon-accent/5"
                      : "border-cyber-border bg-cyber-surface"
                  }`}
                >
                  <span className="shrink-0 text-muted-foreground">
                    {EXIT_POLICY_LABEL[sim.policy]}
                    {isCurrent && <span className="ml-1 text-neon-accent">← ACTUAL</span>}
                    {isBest && <span className="ml-1 text-neon-long">← BEST</span>}
                  </span>
                  <span className={`shrink-0 font-bold ${meta.tone}`}>
                    {meta.text}
                    {sim.resultR != null && !["closed_tp1", "closed_tp2", "closed_stop", "closed_breakeven"].includes(sim.state) && (
                      <span className="ml-1 font-normal text-muted-foreground">
                        {fmtR(sim.resultR)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {sim.barsHeld}b{sim.ambiguousIntrabar ? " · ?" : ""}
                  </span>
                </div>
              );
            })}
            <p className="text-[8px] font-mono leading-snug text-muted-foreground">
              MID-CANDLE RE-SIMULATION ON RE-FETCHED CHART CANDLES — SPREAD IGNORED. THE WORKER
              KEEPS B_SINGLE UNTIL THE LEDGER SAYS OTHERWISE.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ledger hold-odds: of resolved {timeframe} trades at this proximity to TP1,
 *  how many actually reached it? Answers "will it hold?" with data, not vibes. */
function HoldOdds({
  holdStats,
  progressPct,
  timeframe,
}: {
  holdStats: ReturnType<typeof computeHoldStats>;
  progressPct: number | null;
  timeframe: Granularity;
}) {
  const applicable = progressPct != null
    ? [...holdStats].reverse().find((bucket) => progressPct >= bucket.thresholdPct) ?? null
    : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {holdStats.map((bucket) => (
          <div key={bucket.thresholdPct} className="flex-1">
            <div className="flex justify-between font-mono text-[8px] text-muted-foreground">
              <span>&gt;={bucket.thresholdPct}%</span>
              <span>{bucket.reached > 0 ? `${Math.round((bucket.hitRate ?? 0) * 100)}%` : "—"}</span>
            </div>
            <div className="mt-0.5 h-1 rounded-sm bg-cyber-border">
              <div
                className="h-1 rounded-sm bg-neon-long/70"
                style={{ width: `${bucket.reached > 0 ? Math.round((bucket.hitRate ?? 0) * 100) : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {applicable && applicable.reached > 0 ? (
        <p className="font-mono text-[9px] text-muted-foreground">
          AT {Math.round(progressPct ?? 0)}% TOWARD TP1: OF{" "}
          <span className="text-white">{applicable.reached}</span> RESOLVED {timeframe} TRADES AT
          THIS PROXIMITY,{" "}
          <span className={applicable.hitRate! >= 0.5 ? "text-neon-long" : "text-neon-warn"}>
            {Math.round(applicable.hitRate! * 100)}%
          </span>{" "}
          REACHED TP1
        </p>
      ) : (
        <p className="font-mono text-[9px] text-muted-foreground">
          {progressPct != null && progressPct < 50
            ? `BELOW 50% TOWARD TP1 (${Math.round(progressPct)}%) — BELOW THE LEDGER'S FIRST BUCKET`
            : "NO RESOLVED TRADES AT THIS PROXIMITY YET — THE LEDGER IS STILL YOUNG"}
        </p>
      )}
    </div>
  );
}
