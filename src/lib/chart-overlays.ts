// Chart overlay layer.
//
// When a scan fires, the result card tells you WHICH strategies voted. This
// module turns that list into what those strategies were actually looking at,
// drawn on the chart the way a discretionary trader would mark it up: the
// moving averages that were stacked, the channel that broke, the imbalance that
// got retested, the swing that was swept.
//
// Two rules keep this honest:
//
//   1. Only strategies that ACTUALLY VOTED get drawn. Nothing decorative.
//   2. The indicator maths is imported from signal-engine.ts, not re-derived
//      here. If the engine's EMA and the chart's EMA could drift apart, the
//      picture would stop being evidence for the vote.
//
// What this is NOT: a replay of the engine's internal state. The engine votes
// on a 220-candle window server-side; the chart holds 300 candles. The shapes
// are the same technique on the same feed, recomputed on the client — near
// enough to explain a signal, not a byte-for-byte audit trail. Strategies with
// no price geometry (RSI, MACD, CCI, session bias, news, COT positioning) are
// reported as such rather than given an invented drawing.
//
// Client-safe: imports only the pure engine helpers, no server modules.

// Relative + explicit .ts extension: this module is unit-tested under
// `node --test`, which resolves neither the "@/" alias nor extensionless
// imports. Same reason mtf-engine/signal-learning/strategy-weights do it.
import {
  atrSeries,
  emaSeries,
  findSwingPoints,
  type SignalEngineCandle,
  type SwingPoint,
} from "./signal-engine.ts";
import { readLocation } from "./location.ts";

export type OverlayCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type OverlayLine = {
  id: string;
  label: string;
  color: string;
  lineWidth: 1 | 2;
  dashed: boolean;
  points: { time: number; value: number }[];
};

/** A single horizontal price of interest (a swept high, an S/R shelf). */
export type OverlayLevel = {
  id: string;
  label: string;
  color: string;
  price: number;
  dashed: boolean;
};

/** A band — order block, fair-value gap, fib pocket. Drawn as top+bottom. */
export type OverlayZone = {
  id: string;
  label: string;
  color: string;
  top: number;
  bottom: number;
};

export type OverlayMarker = {
  time: number;
  position: "aboveBar" | "belowBar";
  color: string;
  shape: "circle" | "arrowUp" | "arrowDown";
  text: string;
};

export type ChartOverlays = {
  lines: OverlayLine[];
  levels: OverlayLevel[];
  zones: OverlayZone[];
  markers: OverlayMarker[];
  /** Strategies that voted AND produced a drawing, with what was drawn. */
  drawn: { strategyId: string; drew: string }[];
  /** Strategies that voted but have no price geometry to show. */
  noGeometry: string[];
};

// Muted enough to read as annotation rather than compete with the candles.
const C = {
  fast: "#4dd4ff",
  slow: "#7a6cff",
  ribbon: "#3f8cff",
  channel: "rgba(255,181,69,0.55)",
  band: "rgba(160,170,190,0.5)",
  zone: "rgba(0,209,255,0.75)",
  sweep: "#ff2e5b",
  structure: "#00ffa3",
  vwap: "#ffb545",
  trail: "#00d1ff",
  rsiDiv: "#ffd23f",
  macdDiv: "#c77dff",
  climax: "#f72585",
  breakout: "#06d6a0",
  // Low-alpha fills: unlike the other zones (order block, FVG, fib pocket —
  // a handful of bars tall), a location zone can span half the visible
  // price range. Full-strength fill would bury the candles under it.
  discountZone: "rgba(0,255,163,0.12)",
  premiumZone: "rgba(255,46,91,0.12)",
} as const;

const EMPTY: ChartOverlays = {
  lines: [],
  levels: [],
  zones: [],
  markers: [],
  drawn: [],
  noGeometry: [],
};

/** Strategies whose evidence is an oscillator or an external feed, not a
 *  price level. Listed so the UI can say so instead of drawing nothing and
 *  leaving you wondering whether it failed. */
const NO_GEOMETRY = new Set([
  "rsi_momo",
  "macd_hist",
  "stoch_rsi",
  "cci_extreme",
  "atr_expansion",
  "ny_killzone",
  "london_killzone",
  "news_reactive",
  "ai_confluence",
  "heiken_ashi_scalp",
]);

// --- small helpers ---------------------------------------------------------

function toEngineCandles(candles: OverlayCandle[]): SignalEngineCandle[] {
  return candles.map((candle) => ({
    time: new Date(candle.time * 1000).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    complete: true,
    volume: candle.volume,
  }));
}

function lineFrom(
  candles: OverlayCandle[],
  values: (number | null)[],
  spec: Omit<OverlayLine, "points">,
): OverlayLine | null {
  const points = candles
    .map((candle, index) => ({ time: candle.time, value: values[index] }))
    .filter(
      (point): point is { time: number; value: number } =>
        typeof point.value === "number" && Number.isFinite(point.value),
    );
  return points.length > 1 ? { ...spec, points } : null;
}

/** Fractal swing highs/lows: a bar whose extreme beats `span` bars either side.
 *  Same definition the structure strategies use to find a swing. */
function swings(candles: OverlayCandle[], span = 3) {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = span; i < candles.length - span; i += 1) {
    const window = candles.slice(i - span, i + span + 1);
    if (candles[i].high >= Math.max(...window.map((c) => c.high))) highs.push(i);
    if (candles[i].low <= Math.min(...window.map((c) => c.low))) lows.push(i);
  }
  return { highs, lows };
}

// --- per-strategy overlay builders -----------------------------------------
// Each returns whatever it can draw, or nothing when the pattern it needs is
// not present in the visible window.

function emaOverlay(candles: OverlayCandle[], periods: number[], label: string) {
  const closes = candles.map((c) => c.close);
  const colors = [C.fast, C.ribbon, C.slow, "#9a7cff"];
  return periods
    .map((period, index) =>
      lineFrom(candles, emaSeries(closes, period), {
        id: `ema_${period}`,
        label: `${label} EMA${period}`,
        color: colors[index % colors.length],
        lineWidth: 1,
        dashed: false,
      }),
    )
    .filter((line): line is OverlayLine => line != null);
}

/** Rolling N-bar high/low, offset by one bar — the channel a breakout strategy
 *  measures against is the one BEFORE the breaking candle. */
function donchian(candles: OverlayCandle[], period: number) {
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i < period) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const window = candles.slice(i - period, i);
    upper.push(Math.max(...window.map((c) => c.high)));
    lower.push(Math.min(...window.map((c) => c.low)));
  }
  return { upper, lower };
}

function bollinger(candles: OverlayCandle[], period = 20, sigma = 2) {
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const mid: (number | null)[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i < period - 1) {
      upper.push(null);
      lower.push(null);
      mid.push(null);
      continue;
    }
    const window = candles.slice(i - period + 1, i + 1).map((c) => c.close);
    const mean = window.reduce((sum, v) => sum + v, 0) / window.length;
    const deviation = Math.sqrt(
      window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length,
    );
    mid.push(mean);
    upper.push(mean + sigma * deviation);
    lower.push(mean - sigma * deviation);
  }
  return { upper, lower, mid };
}

function keltner(candles: OverlayCandle[], period = 20, multiple = 1.5) {
  const closes = candles.map((c) => c.close);
  const basis = emaSeries(closes, period);
  const atr = atrSeries(toEngineCandles(candles), 14);
  const upper = basis.map((value, i) => {
    const a = atr[i];
    return typeof a === "number" ? value + multiple * a : null;
  });
  const lower = basis.map((value, i) => {
    const a = atr[i];
    return typeof a === "number" ? value - multiple * a : null;
  });
  return { upper, lower, basis };
}

/** 10-period, 3x ATR SuperTrend — the engine's parameters. */
function supertrend(candles: OverlayCandle[], period = 10, multiple = 3) {
  const atr = atrSeries(toEngineCandles(candles), period);
  const out: (number | null)[] = [];
  let trendUp = true;
  let previous: number | null = null;
  for (let i = 0; i < candles.length; i += 1) {
    const a = atr[i];
    if (typeof a !== "number") {
      out.push(null);
      continue;
    }
    const mid = (candles[i].high + candles[i].low) / 2;
    const upperBand = mid + multiple * a;
    const lowerBand = mid - multiple * a;
    if (previous == null) {
      trendUp = candles[i].close >= mid;
      previous = trendUp ? lowerBand : upperBand;
      out.push(previous);
      continue;
    }
    if (trendUp) {
      previous = Math.max(lowerBand, previous);
      if (candles[i].close < previous) {
        trendUp = false;
        previous = upperBand;
      }
    } else {
      previous = Math.min(upperBand, previous);
      if (candles[i].close > previous) {
        trendUp = true;
        previous = lowerBand;
      }
    }
    out.push(previous);
  }
  return out;
}

/** Least-squares line through the recent swing pivots on the side being
 *  broken — the construction trendline_break measures against. */
function trendline(candles: OverlayCandle[], direction: "long" | "short") {
  const { highs, lows } = swings(candles, 3);
  // A long breaks a descending line drawn across highs; a short breaks a
  // rising line across lows.
  const indices = (direction === "long" ? highs : lows).slice(-4);
  if (indices.length < 2) return null;
  const points = indices.map((i) => ({
    x: i,
    y: direction === "long" ? candles[i].high : candles[i].low,
  }));
  const n = points.length;
  const sumX = points.reduce((sum, p) => sum + p.x, 0);
  const sumY = points.reduce((sum, p) => sum + p.y, 0);
  const sumXX = points.reduce((sum, p) => sum + p.x * p.x, 0);
  const sumXY = points.reduce((sum, p) => sum + p.x * p.y, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const from = indices[0];
  const to = candles.length - 1;
  return [
    { time: candles[from].time, value: slope * from + intercept },
    { time: candles[to].time, value: slope * to + intercept },
  ];
}

/**
 * Ichimoku 9/26/52.
 *
 * Senkou A/B are the cloud edges. They are conventionally plotted 26 bars
 * FORWARD, so the value shown at bar i is derived from bar i-26 — that shift is
 * applied here rather than drawing the raw series, which would put the cloud in
 * the wrong place. The final 26 bars of cloud project past the last candle and
 * are simply not drawn; lightweight-charts has no bars there to hang them on.
 */
function ichimoku(candles: OverlayCandle[]) {
  const midpoint = (period: number, index: number) => {
    if (index < period - 1) return null;
    const window = candles.slice(index - period + 1, index + 1);
    return (Math.max(...window.map((c) => c.high)) + Math.min(...window.map((c) => c.low))) / 2;
  };
  const tenkan = candles.map((_, i) => midpoint(9, i));
  const kijun = candles.map((_, i) => midpoint(26, i));
  const SHIFT = 26;
  const spanA = candles.map((_, i) => {
    const source = i - SHIFT;
    if (source < 0) return null;
    const t = tenkan[source];
    const k = kijun[source];
    return t != null && k != null ? (t + k) / 2 : null;
  });
  const spanB = candles.map((_, i) => (i - SHIFT < 0 ? null : midpoint(52, i - SHIFT)));
  return { tenkan, kijun, spanA, spanB };
}

/**
 * The X-A-B-C-D polyline the harmonic strategies score their ratios against.
 *
 * Pivots are reduced to a strictly alternating high/low sequence first —
 * consecutive same-side pivots collapse to the most extreme one — because a
 * harmonic leg is only meaningful between opposite extremes.
 */
function harmonicLegs(candles: OverlayCandle[]) {
  const { highs, lows } = swings(candles, 3);
  const pivots = [
    ...highs.map((i) => ({ index: i, price: candles[i].high, high: true })),
    ...lows.map((i) => ({ index: i, price: candles[i].low, high: false })),
  ].sort((a, b) => a.index - b.index);

  const alternating: typeof pivots = [];
  for (const pivot of pivots) {
    const previous = alternating[alternating.length - 1];
    if (!previous || previous.high !== pivot.high) {
      alternating.push(pivot);
      continue;
    }
    // Same side twice: keep whichever is the more extreme of the two.
    const moreExtreme = pivot.high ? pivot.price > previous.price : pivot.price < previous.price;
    if (moreExtreme) alternating[alternating.length - 1] = pivot;
  }

  const legs = alternating.slice(-5);
  if (legs.length < 5) return null;
  return legs.map((pivot, position) => ({
    time: candles[pivot.index].time,
    value: pivot.price,
    label: ["X", "A", "B", "C", "D"][position],
    high: pivot.high,
  }));
}

/** Rolling VWAP over the visible window (the engine uses a session-rolling
 *  VWAP; on a 300-bar client window this is the same calculation). */
function vwap(candles: OverlayCandle[], period = 60) {
  const out: (number | null)[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    if (i < period - 1) {
      out.push(null);
      continue;
    }
    const window = candles.slice(i - period + 1, i + 1);
    let pv = 0;
    let vol = 0;
    for (const candle of window) {
      const typical = (candle.high + candle.low + candle.close) / 3;
      const v = candle.volume && candle.volume > 0 ? candle.volume : 1;
      pv += typical * v;
      vol += v;
    }
    out.push(vol > 0 ? pv / vol : null);
  }
  return out;
}

/** Dominant swing leg in the recent window, and its 0.5 / 0.618 pocket. */
function fibPocket(candles: OverlayCandle[], direction: "long" | "short") {
  const window = candles.slice(-120);
  if (window.length < 20) return null;
  const highIndex = window.reduce((best, c, i) => (c.high > window[best].high ? i : best), 0);
  const lowIndex = window.reduce((best, c, i) => (c.low < window[best].low ? i : best), 0);
  const high = window[highIndex].high;
  const low = window[lowIndex].low;
  const leg = high - low;
  if (leg <= 0) return null;
  // A long retraces DOWN into the pocket of an up-leg; a short retraces up.
  const top = direction === "long" ? high - leg * 0.5 : low + leg * 0.618;
  const bottom = direction === "long" ? high - leg * 0.618 : low + leg * 0.5;
  return { top: Math.max(top, bottom), bottom: Math.min(top, bottom), high, low };
}

/** Last opposing candle before a >=1.25 ATR displacement — the engine's
 *  order-block definition. Returns the most recent one. */
function orderBlock(candles: OverlayCandle[], direction: "long" | "short") {
  const atr = atrSeries(toEngineCandles(candles), 14);
  for (let i = candles.length - 2; i > 1; i -= 1) {
    const a = atr[i];
    if (typeof a !== "number") continue;
    const body = candles[i].close - candles[i].open;
    const displaced = Math.abs(body) >= 1.25 * a;
    if (!displaced) continue;
    if (direction === "long" && body <= 0) continue;
    if (direction === "short" && body >= 0) continue;
    // Walk back to the last candle opposing the displacement.
    for (let j = i - 1; j >= Math.max(0, i - 6); j -= 1) {
      const opposing =
        direction === "long"
          ? candles[j].close < candles[j].open
          : candles[j].close > candles[j].open;
      if (opposing) {
        return { top: candles[j].high, bottom: candles[j].low, time: candles[j].time };
      }
    }
  }
  return null;
}

/** Three-candle imbalance: candle i-2 high below candle i low (bullish gap),
 *  or i-2 low above candle i high (bearish gap). Most recent unfilled one. */
function fairValueGap(candles: OverlayCandle[], direction: "long" | "short") {
  for (let i = candles.length - 1; i >= 2; i -= 1) {
    const first = candles[i - 2];
    const third = candles[i];
    if (direction === "long" && first.high < third.low) {
      return { top: third.low, bottom: first.high, time: third.time };
    }
    if (direction === "short" && first.low > third.high) {
      return { top: first.low, bottom: third.high, time: third.time };
    }
  }
  return null;
}

/** Horizontal shelf touched at least three times within a quarter-ATR. */
function srShelf(candles: OverlayCandle[]) {
  const { highs, lows } = swings(candles, 3);
  const atr = atrSeries(toEngineCandles(candles), 14).at(-1);
  if (typeof atr !== "number") return null;
  const tolerance = atr * 0.25;
  const pivots = [...highs.map((i) => candles[i].high), ...lows.map((i) => candles[i].low)];
  let best: { price: number; touches: number } | null = null;
  for (const price of pivots) {
    const touches = pivots.filter((other) => Math.abs(other - price) <= tolerance).length;
    if (touches >= 3 && (!best || touches > best.touches)) best = { price, touches };
  }
  return best;
}

/**
 * The two most recent swing pivots the divergence strategies compare against
 * price — both lows for a long (bullish) divergence, both highs for a short
 * (bearish) one. Uses signal-engine's OWN findSwingPoints (k=2), not the
 * local `swings()` fractal helper above, so the drawn pivots are the exact
 * ones the vote fired on rather than a lookalike computed a different way.
 */
function divergencePivots(
  candles: OverlayCandle[],
  direction: "long" | "short",
): { time: number; price: number }[] | null {
  const kind: SwingPoint["kind"] = direction === "long" ? "low" : "high";
  const swings: SwingPoint[] = findSwingPoints(toEngineCandles(candles), 2).filter(
    (point) => point.kind === kind,
  );
  if (swings.length < 2) return null;
  return swings.slice(-2).map((point) => ({ time: candles[point.index].time, price: point.price }));
}

/** The freshest 20-bar boundary break-and-fail, mirroring
 *  evaluateFailedBreakout's own backward search over the last 10 bars. Only
 *  the side matching `direction` is checked — the strategy already voted, so
 *  we know which one fired. */
function failedBreakoutBoundary(
  candles: OverlayCandle[],
  direction: "long" | "short",
): { price: number; time: number } | null {
  const lastIndex = candles.length - 1;
  for (let i = lastIndex - 1; i >= Math.max(0, lastIndex - 10); i -= 1) {
    const window = candles.slice(i - 20, i);
    if (window.length < 20) continue;
    if (direction === "short") {
      const windowHigh = Math.max(...window.map((c) => c.high));
      if (candles[i].close > windowHigh) return { price: windowHigh, time: candles[i].time };
    } else {
      const windowLow = Math.min(...window.map((c) => c.low));
      if (candles[i].close < windowLow) return { price: windowLow, time: candles[i].time };
    }
  }
  return null;
}

// --- entry point -----------------------------------------------------------

/**
 * Build the overlay set for a signal.
 *
 * @param candles   The bars currently on the chart.
 * @param strategyIds  The strategies that voted for this signal.
 * @param direction The signal's direction — several patterns are directional.
 */
export function buildOverlays(
  candles: OverlayCandle[],
  strategyIds: string[],
  direction: "long" | "short",
): ChartOverlays {
  if (candles.length < 30 || strategyIds.length === 0) return EMPTY;

  const lines: OverlayLine[] = [];
  const levels: OverlayLevel[] = [];
  const zones: OverlayZone[] = [];
  const markers: OverlayMarker[] = [];
  const drawn: { strategyId: string; drew: string }[] = [];
  const noGeometry: string[] = [];
  const voted = new Set(strategyIds);
  const push = (strategyId: string, drew: string) => drawn.push({ strategyId, drew });

  // --- trend structure ---
  if (voted.has("ema_trend")) {
    lines.push(...emaOverlay(candles, [21, 55], ""));
    push("ema_trend", "EMA21 / EMA55");
  }
  if (voted.has("ma_ribbon")) {
    lines.push(...emaOverlay(candles, [8, 13, 21, 34], "ribbon"));
    push("ma_ribbon", "EMA 8/13/21/34 ribbon");
  }
  if (voted.has("qullamaggie_breakout")) {
    lines.push(...emaOverlay(candles, [50], ""));
    push("qullamaggie_breakout", "EMA50 + 20-bar high");
  }
  if (voted.has("supertrend")) {
    const line = lineFrom(candles, supertrend(candles), {
      id: "supertrend",
      label: "SuperTrend 10/3",
      color: C.trail,
      lineWidth: 2,
      dashed: false,
    });
    if (line) {
      lines.push(line);
      push("supertrend", "SuperTrend 10 / 3xATR");
    }
  }

  if (voted.has("ichimoku")) {
    const cloud = ichimoku(candles);
    const parts: [string, (number | null)[], string, string, boolean][] = [
      ["tenkan", cloud.tenkan, "Tenkan 9", C.fast, false],
      ["kijun", cloud.kijun, "Kijun 26", C.slow, false],
      ["senkou_a", cloud.spanA, "Senkou A", C.band, true],
      ["senkou_b", cloud.spanB, "Senkou B", C.band, true],
    ];
    let any = false;
    for (const [id, values, label, color, dashed] of parts) {
      const line = lineFrom(candles, values, { id, label, color, lineWidth: 1, dashed });
      if (line) {
        lines.push(line);
        any = true;
      }
    }
    if (any) push("ichimoku", "Ichimoku 9/26/52 (cloud edges)");
    else noGeometry.push("ichimoku");
  }
  if (voted.has("trendline_break")) {
    const points = trendline(candles, direction);
    if (points) {
      lines.push({
        id: "trendline",
        label: "Swing trendline",
        color: C.channel,
        lineWidth: 2,
        dashed: true,
        points,
      });
      push("trendline_break", "Broken swing trendline");
    } else {
      noGeometry.push("trendline_break");
    }
  }

  // --- harmonic geometry ---
  const harmonic = ["gartley", "bat_pattern", "butterfly_pattern"].filter((id) => voted.has(id));
  if (harmonic.length > 0) {
    const legs = harmonicLegs(candles);
    if (legs) {
      lines.push({
        id: "harmonic",
        label: "XABCD",
        color: "#9a7cff",
        lineWidth: 2,
        dashed: false,
        points: legs.map((leg) => ({ time: leg.time, value: leg.value })),
      });
      for (const leg of legs) {
        markers.push({
          time: leg.time,
          position: leg.high ? "aboveBar" : "belowBar",
          color: "#9a7cff",
          shape: "circle",
          text: leg.label,
        });
      }
      for (const id of harmonic) push(id, "X-A-B-C-D swing legs");
    } else {
      noGeometry.push(...harmonic);
    }
  }

  // --- channels and bands ---
  if (voted.has("donchian_break") || voted.has("qullamaggie_breakout")) {
    const { upper, lower } = donchian(candles, 20);
    const up = lineFrom(candles, upper, {
      id: "donchian_upper",
      label: "20-bar high",
      color: C.channel,
      lineWidth: 1,
      dashed: true,
    });
    const down = lineFrom(candles, lower, {
      id: "donchian_lower",
      label: "20-bar low",
      color: C.channel,
      lineWidth: 1,
      dashed: true,
    });
    if (up) lines.push(up);
    if (down) lines.push(down);
    if (voted.has("donchian_break")) push("donchian_break", "20-bar Donchian channel");
  }
  if (voted.has("bollinger_squeeze")) {
    const { upper, lower } = bollinger(candles);
    for (const [id, values, label] of [
      ["bb_upper", upper, "BB 20/2 upper"],
      ["bb_lower", lower, "BB 20/2 lower"],
    ] as const) {
      const line = lineFrom(candles, values, {
        id,
        label,
        color: C.band,
        lineWidth: 1,
        dashed: true,
      });
      if (line) lines.push(line);
    }
    push("bollinger_squeeze", "Bollinger 20 / 2σ");
  }
  if (voted.has("keltner_break")) {
    const { upper, lower } = keltner(candles);
    for (const [id, values, label] of [
      ["kc_upper", upper, "Keltner upper"],
      ["kc_lower", lower, "Keltner lower"],
    ] as const) {
      const line = lineFrom(candles, values, {
        id,
        label,
        color: C.band,
        lineWidth: 1,
        dashed: true,
      });
      if (line) lines.push(line);
    }
    push("keltner_break", "Keltner EMA20 ± 1.5 ATR");
  }
  if (voted.has("vwap_mean_rev")) {
    const line = lineFrom(candles, vwap(candles), {
      id: "vwap",
      label: "VWAP",
      color: C.vwap,
      lineWidth: 2,
      dashed: false,
    });
    if (line) {
      lines.push(line);
      push("vwap_mean_rev", "Rolling VWAP");
    }
  }

  // --- order flow zones ---
  if (voted.has("order_block")) {
    const block = orderBlock(candles, direction);
    if (block) {
      zones.push({
        id: "order_block",
        label: "ORDER BLOCK",
        color: C.zone,
        top: block.top,
        bottom: block.bottom,
      });
      push("order_block", "Order block zone");
    } else {
      noGeometry.push("order_block");
    }
  }
  if (voted.has("fvg")) {
    const gap = fairValueGap(candles, direction);
    if (gap) {
      zones.push({
        id: "fvg",
        label: "FVG",
        color: C.zone,
        top: gap.top,
        bottom: gap.bottom,
      });
      push("fvg", "Fair-value gap");
    } else {
      noGeometry.push("fvg");
    }
  }
  if (voted.has("fib_retracement")) {
    const pocket = fibPocket(candles, direction);
    if (pocket) {
      zones.push({
        id: "fib",
        label: "FIB 0.5–0.618",
        color: "rgba(255,181,69,0.75)",
        top: pocket.top,
        bottom: pocket.bottom,
      });
      push("fib_retracement", "0.5–0.618 pocket");
    } else {
      noGeometry.push("fib_retracement");
    }
  }

  // --- swept liquidity and structure ---
  if (voted.has("liquidity_sweep")) {
    const window = candles.slice(-21, -1);
    if (window.length > 0) {
      const price =
        direction === "long"
          ? Math.min(...window.map((c) => c.low))
          : Math.max(...window.map((c) => c.high));
      levels.push({
        id: "sweep",
        label: "SWEPT",
        color: C.sweep,
        price,
        dashed: true,
      });
      push("liquidity_sweep", "Swept 20-bar extreme");
    }
  }
  if (voted.has("bos_choch")) {
    const { highs, lows } = swings(candles, 3);
    const pivotIndex = direction === "long" ? highs.at(-1) : lows.at(-1);
    if (pivotIndex != null) {
      const candle = candles[pivotIndex];
      const price = direction === "long" ? candle.high : candle.low;
      levels.push({
        id: "bos",
        label: "BOS",
        color: C.structure,
        price,
        dashed: true,
      });
      markers.push({
        time: candle.time,
        position: direction === "long" ? "aboveBar" : "belowBar",
        color: C.structure,
        shape: "circle",
        text: "BOS",
      });
      push("bos_choch", "Broken swing structure");
    } else {
      noGeometry.push("bos_choch");
    }
  }
  if (voted.has("sr_confluence")) {
    const shelf = srShelf(candles);
    if (shelf) {
      levels.push({
        id: "sr",
        label: `S/R ×${shelf.touches}`,
        color: C.channel,
        price: shelf.price,
        dashed: false,
      });
      push("sr_confluence", `Multi-touch level (${shelf.touches} touches)`);
    } else {
      noGeometry.push("sr_confluence");
    }
  }

  // --- session ranges ---
  if (voted.has("asian_range") || voted.has("opening_range_breakout")) {
    const window = candles.slice(-40);
    if (window.length > 4) {
      const high = Math.max(...window.slice(0, 12).map((c) => c.high));
      const low = Math.min(...window.slice(0, 12).map((c) => c.low));
      zones.push({
        id: "session_range",
        label: voted.has("asian_range") ? "ASIAN RANGE" : "OPENING RANGE",
        color: "rgba(122,132,151,0.7)",
        top: high,
        bottom: low,
      });
      // Both session strategies read the same range box, so both are credited
      // when both voted. Crediting only the first silently dropped the other
      // from the legend — the exact failure the catalog guard test exists for.
      for (const id of ["asian_range", "opening_range_breakout"]) {
        if (voted.has(id)) push(id, "Session range high/low");
      }
    }
  }

  // --- sharp-reversal pack: rsi_divergence, macd_divergence, ---
  // --- climax_exhaustion, stop_run_reversal, failed_breakout ---
  const divergenceVoted = ["rsi_divergence", "macd_divergence"].filter((id) => voted.has(id));
  if (divergenceVoted.length > 0) {
    const pivots = divergencePivots(candles, direction);
    if (pivots) {
      const [a, b] = pivots;
      const markerPosition = direction === "short" ? "aboveBar" : "belowBar";
      if (voted.has("rsi_divergence")) {
        lines.push({
          id: "rsi_divergence_line",
          label: "RSI14 divergence",
          color: C.rsiDiv,
          lineWidth: 2,
          dashed: true,
          points: [
            { time: a.time, value: a.price },
            { time: b.time, value: b.price },
          ],
        });
        markers.push(
          {
            time: a.time,
            position: markerPosition,
            color: C.rsiDiv,
            shape: "circle",
            text: "RSI DIV",
          },
          {
            time: b.time,
            position: markerPosition,
            color: C.rsiDiv,
            shape: "circle",
            text: "RSI DIV",
          },
        );
        push("rsi_divergence", "RSI14 divergence pivots");
      }
      if (voted.has("macd_divergence")) {
        lines.push({
          id: "macd_divergence_line",
          label: "MACD-line divergence",
          color: C.macdDiv,
          lineWidth: 2,
          dashed: true,
          points: [
            { time: a.time, value: a.price },
            { time: b.time, value: b.price },
          ],
        });
        markers.push(
          {
            time: a.time,
            position: markerPosition,
            color: C.macdDiv,
            shape: "circle",
            text: "MACD DIV",
          },
          {
            time: b.time,
            position: markerPosition,
            color: C.macdDiv,
            shape: "circle",
            text: "MACD DIV",
          },
        );
        push("macd_divergence", "MACD-line divergence pivots");
      }
    } else {
      noGeometry.push(...divergenceVoted);
    }
  }

  if (voted.has("climax_exhaustion")) {
    const latest = candles.at(-1)!;
    const price = direction === "short" ? latest.high : latest.low;
    levels.push({
      id: "climax",
      label: "CLIMAX",
      color: C.climax,
      price,
      dashed: true,
    });
    markers.push({
      time: latest.time,
      position: direction === "short" ? "aboveBar" : "belowBar",
      color: C.climax,
      shape: "circle",
      text: "CLIMAX",
    });
    push("climax_exhaustion", "Climax bar extreme");
  }

  if (voted.has("stop_run_reversal")) {
    const sweepBar = candles.at(-2)!;
    const prior = candles.slice(-22, -2);
    if (prior.length > 0) {
      const price =
        direction === "short"
          ? Math.max(...prior.map((c) => c.high))
          : Math.min(...prior.map((c) => c.low));
      levels.push({
        id: "stop_run",
        label: "STOP RUN",
        color: C.sweep,
        price,
        dashed: true,
      });
      markers.push({
        time: sweepBar.time,
        position: direction === "short" ? "aboveBar" : "belowBar",
        color: C.sweep,
        shape: "circle",
        text: "SWEEP",
      });
      push("stop_run_reversal", "Swept prior 20-bar extreme");
    }
  }

  if (voted.has("failed_breakout")) {
    const boundary = failedBreakoutBoundary(candles, direction);
    if (boundary) {
      levels.push({
        id: "failed_breakout",
        label: "FAILED BREAKOUT",
        color: C.breakout,
        price: boundary.price,
        dashed: true,
      });
      markers.push({
        time: boundary.time,
        position: direction === "short" ? "aboveBar" : "belowBar",
        color: C.breakout,
        shape: "circle",
        text: "FAILED",
      });
      push("failed_breakout", "Broken 20-bar boundary");
    } else {
      noGeometry.push("failed_breakout");
    }
  }

  for (const strategyId of strategyIds) {
    if (NO_GEOMETRY.has(strategyId) && !noGeometry.includes(strategyId)) {
      noGeometry.push(strategyId);
    }
  }

  return { lines, levels, zones, markers, drawn, noGeometry };
}

/**
 * Premium/discount overlay — the highest-teaching-value drawing in the
 * product: one glance should show whether an entry sits in the cheap half
 * of its own range or is being chased into the expensive half.
 *
 * Deliberately NOT folded into buildOverlays(): location is not a strategy
 * vote, it applies to every signal regardless of which strategies fired, and
 * mixing it into the strategy-keyed drawer would disturb the "every engine
 * strategy is accounted for" guard test above (chart-overlays.test.ts:109),
 * which walks ALL_ENGINE_STRATEGY_IDS and expects nothing extra.
 */
export function buildLocationOverlay(
  candles: OverlayCandle[],
  direction: "long" | "short",
): { zones: OverlayZone[]; levels: OverlayLevel[]; markers: OverlayMarker[] } | null {
  const engineCandles = toEngineCandles(candles);
  const atr = atrSeries(engineCandles, 14).at(-1);
  if (typeof atr !== "number") return null;
  const read = readLocation(engineCandles, direction, atr);
  if (!read) return null;

  const { highPrice, lowPrice } = read.swing;
  const equilibrium = (highPrice + lowPrice) / 2;
  const latest = candles.at(-1)!;
  // The two zones already split the range in half at equilibrium — the
  // marker reuses that same two-way split (not the five-way LocationLabel
  // used in the signal card's prose) so the chart tag and the zone it sits
  // in always say the same thing.
  const half = read.swingPosition >= 0.5 ? "premium" : "discount";

  return {
    zones: [
      {
        id: "location_discount",
        label: "DISCOUNT ZONE",
        color: C.discountZone,
        top: equilibrium,
        bottom: lowPrice,
      },
      {
        id: "location_premium",
        label: "PREMIUM ZONE",
        color: C.premiumZone,
        top: highPrice,
        bottom: equilibrium,
      },
    ],
    levels: [
      {
        id: "location_eq",
        label: `EQ ${Number(equilibrium.toFixed(5))}`,
        color: C.band,
        price: equilibrium,
        dashed: true,
      },
    ],
    markers: [
      {
        time: latest.time,
        position: half === "premium" ? "aboveBar" : "belowBar",
        color: half === "premium" ? C.sweep : C.structure,
        shape: "circle",
        text: `${read.swingPosition.toFixed(2)} ${half}`,
      },
    ],
  };
}
