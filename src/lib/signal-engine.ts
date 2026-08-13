// Relative + explicit .ts extension, matching chart-overlays.ts / mtf-engine.ts
// / signal-learning.ts / strategy-weights.ts: this module is exercised under
// `node --test`, which resolves neither the "@/" alias nor extensionless
// imports. location.ts and regime.ts both import back from here
// (SignalEngineCandle, clamp, emaSeries, findSwingPoints, atrSeries,
// StrategyCategory) — safe as a circular ESM import because every name
// crossing the boundary is a hoisted function/type declaration, never a
// value read at module-evaluation time.
import { describeLocation, readLocation, type LocationRead } from "./location.ts";
import { clusterDepthBonus, DEFAULT_CLUSTERS, rollupByCluster } from "./strategy-clusters.ts";
import {
  describeRegime,
  readRegime,
  regimeWeightFor,
  type MarketRegime,
  type RegimeRead,
} from "./regime.ts";
export type { MarketRegime } from "./regime.ts";

/**
 * Stand-in used only when a caller pins `regimeOverride` on a window too short
 * for `readRegime` to measure anything. The pinned regime is what drives the
 * weighting; these placeholder readings exist so the reported shape stays
 * consistent, and they are deliberately neutral rather than invented — a
 * fabricated ADX would read as measurement when it is nothing of the kind.
 */
const EMPTY_REGIME_READ: RegimeRead = {
  regime: "range",
  adx: 0,
  trendDirection: null,
  atrPercentile: 0,
  efficiencyRatio: 0,
};

export type SignalDirection = "long" | "short";
export type SignalMode = "intraday" | "scalper";
export type SignalTimeframe = "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";

export type SignalEngineCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  complete: boolean;
  volume?: number;
};

export type SignalEngineQuote = {
  bid: number;
  ask: number;
  mid: number;
};

export type StrategyCategory =
  | "trend"
  | "momentum"
  | "mean_reversion"
  | "breakout"
  | "volatility"
  | "orderflow"
  | "sr"
  | "session"
  | "harmonic"
  | "ai";

type StrategyDefinition = {
  category: StrategyCategory;
  timeframes: SignalTimeframe[];
  description: string;
};

export type StrategyVote = {
  strategyId: string;
  category: StrategyCategory;
  direction: SignalDirection;
  strength: number;
  reason: string;
};

/**
 * Trigger strictness for a strategy's detector. `standard` is what the live
 * worker scans with; `relaxed` loosens one gate (see the per-strategy
 * comments) and exists ONLY so the backtest harness can measure what firing
 * more often would do before any change ships. The live path never passes
 * variants, so production behavior is byte-identical unless the ledger says
 * a relaxed variant wins.
 */
export type StrategyTriggerVariant = "standard" | "relaxed";

/** Minimal macro overlay the news/ai strategies read (no dependency on the
 *  server-only macro module, so the engine stays bundle-safe on the client). */
export type EngineMacroContext = {
  events?: {
    currency: string;
    title: string;
    time: string;
    /** Epoch ms UTC — the real release instant, computed once at the source
     *  (macro-data.server.ts). Window checks read this, never the bare HH:MM. */
    timestamp: number;
    impact: string;
  }[];
  cot?: { net: number; netPct: number; reportDate: string } | null;
};

/**
 * Trust floor: strategies with a walk-forward weight below this are excluded
 * from signals. 0.35 (not 0.4) so mildly underperforming strategies still
 * contribute at reduced strength — only clear failures are silenced — keeping
 * more of the catalog working at once.
 */
export const DOWNWEIGHT_FLOOR = 0.35;

/**
 * A side must hold at least this fraction of total weighted vote strength to
 * win the direction call. Below it, the book is too contested to trade — an
 * exact 50/50 split must never default long, and vote COUNT alone is not the
 * same as conviction (two strong votes can rightly beat three weak ones).
 */
export const DIRECTION_MARGIN = 0.58;

export type RiskLevels = {
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  atr: number;
  riskDistance: number;
  structureDistance: number;
  volatilityFloor: number;
  spreadFloor: number;
  basis: "structure" | "volatility" | "spread";
};

export type SignalEngineResult = {
  signal: {
    direction: SignalDirection;
    timeframe: SignalTimeframe;
    entry: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    atr: number;
    confluence: number;
    contributingStrategies: string[];
    rationale: string;
    risk: RiskLevels;
    location: LocationRead | null;
    regime: RegimeRead | null;
  } | null;
  diagnostics: {
    reason: string;
    evaluatedStrategyIds: string[];
    downweightedStrategyIds: string[];
    incompatibleStrategyIds: string[];
    catalogOnlyStrategyIds: string[];
    votes: StrategyVote[];
  };
};

// Which timeframes each strategy is meaningful on. Everything below the
// strategy's natural resolution is noise; everything above adds little.
const ALL_TIMEFRAMES: SignalTimeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];
const SCALP_TIMEFRAMES: SignalTimeframe[] = ["M1", "M5", "M15", "M30"];
const SWING_TIMEFRAMES: SignalTimeframe[] = ["H1", "H4", "D1"];
const INTRADAY_TIMEFRAMES: SignalTimeframe[] = ["M5", "M15", "M30", "H1"];

const IMPLEMENTED_STRATEGIES: Record<string, StrategyDefinition> = {
  opening_range_breakout: {
    category: "breakout",
    timeframes: SCALP_TIMEFRAMES,
    description:
      "Break of the first two candles after a session open (London/NY/Asia) with range-expansion confirmation.",
  },
  heiken_ashi_scalp: {
    category: "trend",
    timeframes: SCALP_TIMEFRAMES,
    description:
      "Three consecutive green Heiken Ashi candles above EMA21 with no meaningful lower wick.",
  },
  qullamaggie_breakout: {
    category: "breakout",
    timeframes: INTRADAY_TIMEFRAMES,
    description:
      "Qullamaggie-style: price above EMA50, ATR compression, close above the prior 20-bar high with volume expansion.",
  },
  trendline_break: {
    category: "sr",
    timeframes: [...INTRADAY_TIMEFRAMES, "H4"],
    description: "Least-squares swing trendline broken with a retest-and-hold close beyond it.",
  },
  fib_retracement: {
    category: "sr",
    timeframes: [...INTRADAY_TIMEFRAMES, "H4"],
    description:
      "Pullback into the 0.5–0.618 zone of the dominant swing leg with a rejection close.",
  },
  ny_killzone: {
    category: "session",
    timeframes: [...SCALP_TIMEFRAMES, "H1"],
    description: "Bias formed inside the New York 12:00–15:00 UTC session.",
  },
  asian_range: {
    category: "session",
    timeframes: [...SCALP_TIMEFRAMES, "H1"],
    description: "Break of the Asian-session range (22:00–07:00 UTC) on the London open.",
  },
  ema_trend: {
    category: "trend",
    timeframes: ALL_TIMEFRAMES,
    description: "Close and EMA21 aligned above/below EMA55 with a rising/falling EMA21.",
  },
  supertrend: {
    category: "trend",
    timeframes: [...INTRADAY_TIMEFRAMES, "H4"],
    description: "Fresh 10-period, 3×ATR SuperTrend directional flip.",
  },
  ma_ribbon: {
    category: "trend",
    timeframes: SWING_TIMEFRAMES,
    description: "EMA 8/13/21/34 ordered with ribbon spread expanding versus three bars ago.",
  },
  ichimoku: {
    category: "trend",
    timeframes: SWING_TIMEFRAMES,
    description: "Price outside the 9/26/52 cloud with Tenkan/Kijun and 26-bar confirmation.",
  },
  rsi_momo: {
    category: "momentum",
    timeframes: ALL_TIMEFRAMES,
    description: "RSI14 above 55 with a rising close, or below 45 with a falling close.",
  },
  macd_hist: {
    category: "momentum",
    timeframes: ALL_TIMEFRAMES,
    description: "MACD 12/26/9 histogram sign with continued expansion.",
  },
  stoch_rsi: {
    category: "momentum",
    timeframes: SCALP_TIMEFRAMES,
    description: "Stochastic RSI14 crossing out of oversold or overbought.",
  },
  cci_extreme: {
    category: "mean_reversion",
    timeframes: ["M15", "M30", "H1", "H4"],
    description: "CCI20 re-entry through −100 or +100 after an extreme.",
  },
  bollinger_squeeze: {
    category: "breakout",
    timeframes: [...SCALP_TIMEFRAMES, "H1"],
    description: "20-period, 2σ break after bottom-quartile bandwidth and ≥1 ATR range.",
  },
  keltner_break: {
    category: "breakout",
    timeframes: [...INTRADAY_TIMEFRAMES, "H4"],
    description: "Close crossing the EMA20 ± 1.5 ATR Keltner channel.",
  },
  donchian_break: {
    category: "breakout",
    timeframes: ALL_TIMEFRAMES,
    description: "Close crossing the previous 20-candle high or low.",
  },
  atr_expansion: {
    category: "volatility",
    timeframes: ALL_TIMEFRAMES,
    description: "Directional true range expanding beyond 1.25 ATR.",
  },
  liquidity_sweep: {
    category: "orderflow",
    timeframes: [...SCALP_TIMEFRAMES, "H1"],
    description: "Prior 20-candle extreme swept and rejected by the close.",
  },
  fvg: {
    category: "orderflow",
    timeframes: [...SCALP_TIMEFRAMES, "H1"],
    description: "Three-candle imbalance retested and held or rejected within 10 bars.",
  },
  order_block: {
    category: "orderflow",
    timeframes: [...INTRADAY_TIMEFRAMES, "H4"],
    description: "Last opposing candle before a ≥1.25 ATR displacement, retested and held.",
  },
  bos_choch: {
    category: "orderflow",
    timeframes: [...SCALP_TIMEFRAMES, "H1"],
    description: "Break of a swing structure with a change-of-character close beyond it.",
  },
  vwap_mean_rev: {
    category: "mean_reversion",
    timeframes: SCALP_TIMEFRAMES,
    description: "Price extended ≥1.5 ATR from the rolling session VWAP reverting toward it.",
  },
  sr_confluence: {
    category: "sr",
    timeframes: SWING_TIMEFRAMES,
    description: "Current price at a multi-touch horizontal level with rejection.",
  },
  london_killzone: {
    category: "session",
    timeframes: [...SCALP_TIMEFRAMES, "H1"],
    description: "Bias formed inside the London 07:00–10:00 UTC session.",
  },
  gartley: {
    category: "harmonic",
    timeframes: ["H1", "H4"],
    description:
      "Ratio-validated Gartley (D at 0.786 of XA): pullback to the potential reversal zone with a rejection close.",
  },
  bat_pattern: {
    category: "harmonic",
    timeframes: ["H1", "H4"],
    description:
      "Ratio-validated Bat (D at 0.886 of XA): deep pullback to the potential reversal zone with a rejection close.",
  },
  butterfly_pattern: {
    category: "harmonic",
    timeframes: ["H1", "H4"],
    description:
      "Ratio-validated Butterfly (D at 1.27 of XA, beyond X): extended sweep into the potential reversal zone.",
  },
  news_reactive: {
    category: "ai",
    timeframes: ["M15", "H1", "H4"],
    description:
      "Bias from directional momentum only while a high-impact release for one of the pair's currencies is imminent.",
  },
  ai_confluence: {
    category: "ai",
    timeframes: ["M15", "H1", "H4"],
    description:
      "Positioning overlay: votes with CFTC COT net positioning when strongly tilted, boosted by an imminent catalyst.",
  },
  // The catalog above is trend- and breakout-heavy: it can tell you a move is
  // running, not that it is ending. These five exist to find the sharp top
  // and the sharp bottom instead of confirming a leg already underway.
  rsi_divergence: {
    category: "momentum",
    timeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    description:
      "Regular RSI14 divergence against the two most recent swing extremes, fresh and with a reclaim already underway.",
  },
  macd_divergence: {
    category: "momentum",
    timeframes: ["M15", "M30", "H1", "H4", "D1"],
    description:
      "Regular divergence between price swing extremes and the raw MACD line (not the histogram) on the far side of the zero line.",
  },
  climax_exhaustion: {
    category: "volatility",
    timeframes: ALL_TIMEFRAMES,
    description:
      "Top-decile range bar on a fresh 20-bar extreme that closes back against itself — the blow-off bar at the end of a leg.",
  },
  stop_run_reversal: {
    category: "orderflow",
    timeframes: ["M1", "M5", "M15", "M30", "H1", "H4"],
    description:
      "A 20-bar extreme swept, then the next bar closes back inside it on a real body — the confirmed two-bar sibling of liquidity_sweep.",
  },
  failed_breakout: {
    category: "mean_reversion",
    timeframes: ["M5", "M15", "M30", "H1", "H4", "D1"],
    description:
      "A break of the prior 20-bar range that closes back inside within 10 bars, trapping the breakout traders.",
  },
};

export function getEngineStrategyCapability(strategyId: string) {
  const definition = IMPLEMENTED_STRATEGIES[strategyId];
  return definition
    ? {
        implemented: true as const,
        timeframes: [...definition.timeframes],
        description: definition.description,
      }
    : {
        implemented: false as const,
        timeframes: [] as SignalTimeframe[],
        description: null,
      };
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Exported alongside emaSeries/atrSeries/findSwingPoints below: location.ts
// composites its score from the same clamp semantics, so a 0..1 term there
// clamps identically to every gate in this file rather than drifting by a
// rounding convention re-implemented a second time.
export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

// emaSeries / atrSeries / rsiSeries are exported so the chart's overlay layer
// (src/lib/chart-overlays.ts) draws the SAME numbers the strategies voted on.
// Re-deriving them there would let the picture drift from the vote.
export function emaSeries(values: number[], period: number) {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] * multiplier + result[index - 1] * (1 - multiplier));
  }
  return result;
}

function trueRange(current: SignalEngineCandle, previous: SignalEngineCandle) {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

export function atrSeries(candles: SignalEngineCandle[], period = 14) {
  if (candles.length < period + 1) return [];
  const ranges = candles.slice(1).map((candle, index) => trueRange(candle, candles[index]));
  let current = average(ranges.slice(0, period));
  const result = Array<number | null>(period).fill(null);
  result.push(current);
  for (const range of ranges.slice(period)) {
    current = (current * (period - 1) + range) / period;
    result.push(current);
  }
  return result;
}

export function latestAtr(candles: SignalEngineCandle[], period = 14) {
  const value = atrSeries(candles, period).at(-1);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Not enough complete candles to calculate ${period}-period ATR.`);
  }
  return value;
}

export function rsiSeries(values: number[], period = 14) {
  if (values.length < period + 1) return [];
  const changes = values.slice(1).map((value, index) => value - values[index]);
  let averageGain = average(changes.slice(0, period).map((change) => Math.max(change, 0)));
  let averageLoss = average(changes.slice(0, period).map((change) => Math.max(-change, 0)));
  const result = Array<number | null>(period).fill(null);
  const toRsi = () =>
    averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / Math.max(averageLoss, Number.EPSILON));
  result.push(toRsi());
  for (const change of changes.slice(period)) {
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result.push(toRsi());
  }
  return result;
}

function rollingStats(values: number[], period: number) {
  const window = values.slice(-period);
  const mean = average(window);
  const variance = average(window.map((value) => (value - mean) ** 2));
  return { mean, deviation: Math.sqrt(variance) };
}

function vote(
  strategyId: string,
  direction: SignalDirection,
  strength: number,
  reason: string,
): StrategyVote {
  return {
    strategyId,
    category: IMPLEMENTED_STRATEGIES[strategyId].category,
    direction,
    strength: Math.round(clamp(strength, 1, 100)),
    reason,
  };
}

function evaluateEmaTrend(candles: SignalEngineCandle[], atr: number, mode: SignalMode) {
  // Scalpers need a faster EMA21/EMA55 stack to lean on; intraday trades require
  // the slower, more confirmed separation so the trend is not already stretched.
  const minSeparation = mode === "scalper" ? 0.15 : 0.25;
  const closes = candles.map((candle) => candle.close);
  const fast = emaSeries(closes, 21);
  const slow = emaSeries(closes, 55);
  const latestClose = closes.at(-1)!;
  const fastNow = fast.at(-1)!;
  const slowNow = slow.at(-1)!;
  const fastPrior = fast.at(-4)!;
  const separation = Math.abs(fastNow - slowNow) / atr;
  if (separation < minSeparation) return null;
  if (latestClose > fastNow && fastNow > slowNow && fastNow > fastPrior) {
    return vote("ema_trend", "long", 55 + separation * 18, "Close and EMA21 are above EMA55.");
  }
  if (latestClose < fastNow && fastNow < slowNow && fastNow < fastPrior) {
    return vote("ema_trend", "short", 55 + separation * 18, "Close and EMA21 are below EMA55.");
  }
  return null;
}

function evaluateSupertrend(candles: SignalEngineCandle[], mode: SignalMode, relaxed = false) {
  const atrValues = atrSeries(candles, 10);
  // Intraday runs a tighter 2×ATR band (fewer whipsaws on H1); scalps keep the
  // classic 3×ATR so the band trails fast enough for M5/M15 moves.
  const multiplier = mode === "intraday" ? 2 : 3;
  let finalUpper = 0;
  let finalLower = 0;
  let supertrend = 0;
  let previousDirection: SignalDirection | null = null;
  let currentDirection: SignalDirection | null = null;

  for (let index = 10; index < candles.length; index += 1) {
    const candle = candles[index];
    const previous = candles[index - 1];
    const atr = atrValues[index];
    if (typeof atr !== "number") continue;
    const basis = (candle.high + candle.low) / 2;
    const basicUpper = basis + atr * multiplier;
    const basicLower = basis - atr * multiplier;
    const previousUpper = finalUpper;
    const previousLower = finalLower;
    const previousSupertrend = supertrend;

    finalUpper =
      index === 10 || basicUpper < previousUpper || previous.close > previousUpper
        ? basicUpper
        : previousUpper;
    finalLower =
      index === 10 || basicLower > previousLower || previous.close < previousLower
        ? basicLower
        : previousLower;
    if (index === 10) {
      supertrend = candle.close >= basis ? finalLower : finalUpper;
    } else if (previousSupertrend === previousUpper) {
      supertrend = candle.close <= finalUpper ? finalUpper : finalLower;
    } else {
      supertrend = candle.close >= finalLower ? finalLower : finalUpper;
    }
    const direction = supertrend === finalLower ? "long" : "short";
    if (index === candles.length - 2) previousDirection = direction;
    if (index === candles.length - 1) currentDirection = direction;
  }

  const latest = candles.at(-1)!;
  const latestAtrValue = atrValues.at(-1);
  // Standard: only the exact flip bar votes (fresh directional change).
  // Relaxed: established direction also votes once price holds a 0.25xATR
  // margin beyond the band — it fires far more often so the harness can see
  // whether the flip-only gate is leaving profit on the table.
  if (
    typeof latestAtrValue !== "number" ||
    supertrend === 0 ||
    !currentDirection ||
    (!relaxed && currentDirection === previousDirection)
  ) {
    return null;
  }
  if (currentDirection === "long" && latest.close > supertrend) {
    const margin = (latest.close - supertrend) / latestAtrValue;
    if (relaxed && margin < 0.25) return null;
    return vote(
      "supertrend",
      "long",
      58 + margin * 6,
      "SuperTrend is bullish above its trailing ATR band.",
    );
  }
  if (currentDirection === "short" && latest.close < supertrend) {
    const margin = (supertrend - latest.close) / latestAtrValue;
    if (relaxed && margin < 0.25) return null;
    return vote(
      "supertrend",
      "short",
      58 + margin * 6,
      "SuperTrend is bearish below its trailing ATR band.",
    );
  }
  return null;
}

function evaluateMaRibbon(candles: SignalEngineCandle[], atr: number) {
  const closes = candles.map((candle) => candle.close);
  const periods = [8, 13, 21, 34];
  const series = periods.map((period) => emaSeries(closes, period));
  const values = series.map((items) => items.at(-1)!);
  const priorValues = series.map((items) => items.at(-4)!);
  const spread = Math.abs(values[0] - values.at(-1)!) / atr;
  const priorSpread = Math.abs(priorValues[0] - priorValues.at(-1)!) / atr;
  const expanding = spread > priorSpread * 1.05;
  if (expanding && values.every((value, index) => index === 0 || values[index - 1] > value)) {
    return vote(
      "ma_ribbon",
      "long",
      55 + spread * 20,
      "EMA ribbon is ordered and expanding upward.",
    );
  }
  if (expanding && values.every((value, index) => index === 0 || values[index - 1] < value)) {
    return vote(
      "ma_ribbon",
      "short",
      55 + spread * 20,
      "EMA ribbon is ordered and expanding downward.",
    );
  }
  return null;
}

function evaluateIchimoku(candles: SignalEngineCandle[], atr: number) {
  const midpoint = (period: number) => {
    const window = candles.slice(-period);
    return (
      (Math.max(...window.map((candle) => candle.high)) +
        Math.min(...window.map((candle) => candle.low))) /
      2
    );
  };
  const tenkan = midpoint(9);
  const kijun = midpoint(26);
  const spanA = (tenkan + kijun) / 2;
  const spanB = midpoint(52);
  const latest = candles.at(-1)!.close;
  const chikouReference = candles.at(-27)!.close;
  const cloudTop = Math.max(spanA, spanB);
  const cloudBottom = Math.min(spanA, spanB);
  if (latest > cloudTop && tenkan > kijun && latest > chikouReference) {
    return vote(
      "ichimoku",
      "long",
      60 + ((latest - cloudTop) / atr) * 10,
      "Price is above the cloud with Tenkan above Kijun.",
    );
  }
  if (latest < cloudBottom && tenkan < kijun && latest < chikouReference) {
    return vote(
      "ichimoku",
      "short",
      60 + ((cloudBottom - latest) / atr) * 10,
      "Price is below the cloud with Tenkan below Kijun.",
    );
  }
  return null;
}

function evaluateRsiMomentum(candles: SignalEngineCandle[]) {
  const values = rsiSeries(candles.map((candle) => candle.close));
  const current = values.at(-1);
  const previous = values.at(-2);
  if (typeof current !== "number" || typeof previous !== "number") return null;
  if (current > 55 && candles.at(-1)!.close > candles.at(-2)!.close) {
    return vote("rsi_momo", "long", current, `RSI momentum is bullish at ${current.toFixed(1)}.`);
  }
  if (current < 45 && candles.at(-1)!.close < candles.at(-2)!.close) {
    return vote(
      "rsi_momo",
      "short",
      100 - current,
      `RSI momentum is bearish at ${current.toFixed(1)}.`,
    );
  }
  return null;
}

function evaluateMacd(candles: SignalEngineCandle[], atr: number) {
  const closes = candles.map((candle) => candle.close);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macd = closes.map((_, index) => fast[index] - slow[index]);
  const signal = emaSeries(macd, 9);
  const histogram = macd.map((value, index) => value - signal[index]);
  const current = histogram.at(-1)!;
  const previous = histogram.at(-2)!;
  if (current > 0 && current >= previous) {
    return vote(
      "macd_hist",
      "long",
      55 + (current / atr) * 100,
      "MACD histogram is positive and non-decreasing.",
    );
  }
  if (current < 0 && current <= previous) {
    return vote(
      "macd_hist",
      "short",
      55 + (Math.abs(current) / atr) * 100,
      "MACD histogram is negative and non-increasing.",
    );
  }
  return null;
}

function evaluateStochRsi(candles: SignalEngineCandle[], mode: SignalMode) {
  const rsi = rsiSeries(candles.map((candle) => candle.close)).filter(
    (value): value is number => typeof value === "number",
  );
  if (rsi.length < 15) return null;
  const oscillator = (end: number) => {
    const window = rsi.slice(end - 14, end);
    const low = Math.min(...window);
    const high = Math.max(...window);
    return high === low ? 50 : ((window.at(-1)! - low) / (high - low)) * 100;
  };
  const previous = oscillator(rsi.length - 1);
  const current = oscillator(rsi.length);
  // Scalps take earlier exits from extreme zones (20/80); intraday waits for
  // deeper 15/85 extremes to fade, which are more reliable on H1+.
  const lower = mode === "scalper" ? 20 : 15;
  const upper = mode === "scalper" ? 80 : 85;
  if (previous <= lower && current > lower) {
    return vote(
      "stoch_rsi",
      "long",
      65 + (lower - previous),
      `Stochastic RSI crossed up from oversold (${lower}).`,
    );
  }
  if (previous >= upper && current < upper) {
    return vote(
      "stoch_rsi",
      "short",
      65 + (previous - upper),
      `Stochastic RSI crossed down from overbought (${upper}).`,
    );
  }
  return null;
}

function evaluateCci(candles: SignalEngineCandle[]) {
  const typical = candles.map((candle) => (candle.high + candle.low + candle.close) / 3);
  const cciAt = (end: number) => {
    const window = typical.slice(end - 20, end);
    const mean = average(window);
    const deviation = average(window.map((value) => Math.abs(value - mean)));
    return deviation === 0 ? 0 : (window.at(-1)! - mean) / (0.015 * deviation);
  };
  const previous = cciAt(typical.length - 1);
  const current = cciAt(typical.length);
  if (previous < -100 && current >= -100) {
    return vote(
      "cci_extreme",
      "long",
      60 + Math.min(30, Math.abs(previous + 100)),
      "CCI recovered from an oversold extreme.",
    );
  }
  if (previous > 100 && current <= 100) {
    return vote(
      "cci_extreme",
      "short",
      60 + Math.min(30, Math.abs(previous - 100)),
      "CCI rejected an overbought extreme.",
    );
  }
  return null;
}

function evaluateBollingerBreakout(
  candles: SignalEngineCandle[],
  atr: number,
  mode: SignalMode,
  relaxed = false,
) {
  const closes = candles.map((candle) => candle.close);
  const priorCloses = closes.slice(0, -1);
  const priorStats = rollingStats(priorCloses, 20);
  const bandwidths = Array.from({ length: Math.min(40, priorCloses.length - 19) }, (_, offset) => {
    const end = priorCloses.length - offset;
    const stats = rollingStats(priorCloses.slice(0, end), 20);
    return (stats.deviation * 4) / Math.max(Math.abs(stats.mean), Number.EPSILON);
  });
  const sortedBandwidths = [...bandwidths].sort((left, right) => left - right);
  // Standard: bottom-quartile bandwidth squeeze plus a >=1 ATR release bar.
  // Relaxed: bottom-40% bandwidth and a 0.5 ATR release — the harness measures
  // whether the strict squeeze gate is over-filtering on M15/H1.
  const squeezeQuantile = relaxed ? 0.4 : 0.25;
  const squeezeThreshold = sortedBandwidths[Math.floor(sortedBandwidths.length * squeezeQuantile)];
  const priorBandwidth =
    (priorStats.deviation * 4) / Math.max(Math.abs(priorStats.mean), Number.EPSILON);
  const squeeze = priorBandwidth <= squeezeThreshold * 1.05;
  const latest = closes.at(-1)!;
  const prior = closes.at(-2)!;
  const priorUpper = priorStats.mean + priorStats.deviation * 2;
  const priorLower = priorStats.mean - priorStats.deviation * 2;
  const range = trueRange(candles.at(-1)!, candles.at(-2)!);
  // Scalps only chase squeezes that are already moving (range >= 1.25 ATR);
  // intraday accepts the standard 1×ATR release on slower bars.
  const rangeThreshold = mode === "scalper" ? atr * (relaxed ? 0.75 : 1.25) : atr * (relaxed ? 0.5 : 1);
  if (squeeze && range >= rangeThreshold && latest > priorUpper && prior <= priorUpper) {
    return vote(
      "bollinger_squeeze",
      "long",
      60 + ((latest - priorUpper) / atr) * 25,
      "Price broke above the Bollinger envelope after a bandwidth squeeze.",
    );
  }
  if (squeeze && range >= rangeThreshold && latest < priorLower && prior >= priorLower) {
    return vote(
      "bollinger_squeeze",
      "short",
      60 + ((priorLower - latest) / atr) * 25,
      "Price broke below the Bollinger envelope after a bandwidth squeeze.",
    );
  }
  return null;
}

function evaluateKeltnerBreak(candles: SignalEngineCandle[], atr: number) {
  const closes = candles.map((candle) => candle.close);
  const ema = emaSeries(closes, 20);
  const currentUpper = ema.at(-1)! + atr * 1.5;
  const currentLower = ema.at(-1)! - atr * 1.5;
  const priorUpper = ema.at(-2)! + atr * 1.5;
  const priorLower = ema.at(-2)! - atr * 1.5;
  if (closes.at(-1)! > currentUpper && closes.at(-2)! <= priorUpper) {
    return vote(
      "keltner_break",
      "long",
      62 + ((closes.at(-1)! - currentUpper) / atr) * 20,
      "Price broke above the Keltner channel.",
    );
  }
  if (closes.at(-1)! < currentLower && closes.at(-2)! >= priorLower) {
    return vote(
      "keltner_break",
      "short",
      62 + ((currentLower - closes.at(-1)!) / atr) * 20,
      "Price broke below the Keltner channel.",
    );
  }
  return null;
}

function evaluateDonchianBreak(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const prior = candles.slice(-21, -1);
  const high = Math.max(...prior.map((candle) => candle.high));
  const low = Math.min(...prior.map((candle) => candle.low));
  if (latest.close > high) {
    return vote(
      "donchian_break",
      "long",
      62 + ((latest.close - high) / atr) * 20,
      "Close broke the prior 20-candle high.",
    );
  }
  if (latest.close < low) {
    return vote(
      "donchian_break",
      "short",
      62 + ((low - latest.close) / atr) * 20,
      "Close broke the prior 20-candle low.",
    );
  }
  return null;
}

function evaluateAtrExpansion(candles: SignalEngineCandle[], atr: number, mode: SignalMode) {
  const latest = candles.at(-1)!;
  const range = trueRange(latest, candles.at(-2)!);
  // Scalper mode requires a stronger impulse (1.5 ATR) so M5 noise cannot fire
  // a volatility vote; intraday accepts the standard 1.25 ATR expansion.
  const expansion = mode === "scalper" ? 1.5 : 1.25;
  if (range < atr * expansion) return null;
  if (latest.close > latest.open) {
    return vote(
      "atr_expansion",
      "long",
      55 + (range / atr) * 15,
      "Bullish true range expanded beyond 1.25 ATR.",
    );
  }
  if (latest.close < latest.open) {
    return vote(
      "atr_expansion",
      "short",
      55 + (range / atr) * 15,
      "Bearish true range expanded beyond 1.25 ATR.",
    );
  }
  return null;
}

function evaluateLiquiditySweep(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const prior = candles.slice(-21, -1);
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  if (latest.high > priorHigh && latest.close < priorHigh) {
    return vote(
      "liquidity_sweep",
      "short",
      62 + ((latest.high - priorHigh) / atr) * 20,
      "Prior high was swept and rejected.",
    );
  }
  if (latest.low < priorLow && latest.close > priorLow) {
    return vote(
      "liquidity_sweep",
      "long",
      62 + ((priorLow - latest.low) / atr) * 20,
      "Prior low was swept and reclaimed.",
    );
  }
  return null;
}

function evaluateOrderBlock(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const window = candles.slice(-16, -1);
  // Displacement: a candle whose range is >= 1.25 ATR in one direction, preceded
  // by an opposing (or doji) candle whose body is the order block. Retest: the
  // latest close has pulled back into the block zone and held above/below it.
  for (let index = 1; index < window.length - 1; index += 1) {
    const block = window[index];
    const displacement = window[index + 1];
    const blockBody = Math.abs(block.close - block.open);
    const displacementRange = Math.max(
      displacement.high - displacement.low,
      trueRange(displacement, block),
    );
    if (displacementRange < atr * 1.25 || blockBody < atr * 0.3) continue;
    if (displacement.close > displacement.open) {
      // Bullish displacement: the block is the last down candle before it.
      if (block.close >= block.open) continue;
      const zoneHigh = block.high;
      const zoneLow = Math.min(block.low, block.open);
      if (latest.low <= zoneHigh && latest.close > zoneHigh && latest.low > zoneLow - atr * 0.1) {
        return vote(
          "order_block",
          "long",
          60 + ((latest.close - zoneHigh) / atr) * 20,
          "Bullish order block retested and holding above the zone.",
        );
      }
    } else if (displacement.close < displacement.open) {
      // Bearish displacement: the block is the last up candle before it.
      if (block.close <= block.open) continue;
      const zoneLow = block.low;
      const zoneHigh = Math.max(block.high, block.open);
      if (latest.high >= zoneLow && latest.close < zoneLow && latest.high < zoneHigh + atr * 0.1) {
        return vote(
          "order_block",
          "short",
          60 + ((zoneLow - latest.close) / atr) * 20,
          "Bearish order block retested and rejected below the zone.",
        );
      }
    }
  }
  return null;
}

function evaluateBosChoch(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const prior = candles.slice(-22, -1);
  const swingHigh = Math.max(...prior.map((candle) => candle.high));
  const swingLow = Math.min(...prior.map((candle) => candle.low));
  const priorClose = candles.at(-2)!.close;
  // Break of structure: close beyond the prior swing, with a change of
  // character (the break candle closing beyond, not just wicking).
  if (latest.close > swingHigh && priorClose <= swingHigh) {
    return vote(
      "bos_choch",
      "long",
      62 + ((latest.close - swingHigh) / atr) * 18,
      "Break of structure above the prior swing high.",
    );
  }
  if (latest.close < swingLow && priorClose >= swingLow) {
    return vote(
      "bos_choch",
      "short",
      62 + ((swingLow - latest.close) / atr) * 18,
      "Break of structure below the prior swing low.",
    );
  }
  return null;
}

function evaluateVwapMeanReversion(candles: SignalEngineCandle[], atr: number, mode: SignalMode) {
  const session = candles.slice(-Math.min(candles.length, 96));
  const typical = session.map((candle) => (candle.high + candle.low + candle.close) / 3);
  const volume = session.map((candle) => candle.volume ?? 0);
  const totalVolume = volume.reduce((sum, value) => sum + value, 0);
  if (totalVolume <= 0) return null;
  const vwap =
    session.reduce((sum, candle, index) => sum + typical[index] * volume[index], 0) / totalVolume;
  const latest = candles.at(-1)!;
  const distance = (latest.close - vwap) / Math.max(atr, Number.EPSILON);
  // Scalps fade extensions sooner (1.2 ATR from VWAP) because M5 moves stretch
  // less; intraday waits for the fuller 1.5 ATR extension.
  const extension = mode === "scalper" ? 1.2 : 1.5;
  if (distance >= extension && latest.close < latest.open) {
    return vote(
      "vwap_mean_rev",
      "short",
      Math.min(75, 55 + distance * 12),
      `Price extended ${distance.toFixed(2)} ATR above session VWAP, fading back.`,
    );
  }
  if (distance <= -extension && latest.close > latest.open) {
    return vote(
      "vwap_mean_rev",
      "long",
      Math.min(75, 55 + Math.abs(distance) * 12),
      `Price extended ${Math.abs(distance).toFixed(2)} ATR below session VWAP, reverting up.`,
    );
  }
  return null;
}

function evaluateSrConfluence(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const window = candles.slice(-60, -1);
  // Cluster closes into horizontal levels; count touches per level.
  const buckets = new Map<number, number>();
  const tolerance = atr * 0.35;
  for (const candle of window) {
    const key = Math.round(candle.close / tolerance) * tolerance;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let bestLevel = 0;
  let bestTouches = 0;
  for (const [level, touches] of buckets) {
    if (touches > bestTouches) {
      bestLevel = level;
      bestTouches = touches;
    }
  }
  if (bestTouches < 4) return null;
  const distance = Math.abs(latest.close - bestLevel) / tolerance;
  if (distance <= 1.0) {
    if (latest.close > bestLevel && latest.low <= bestLevel) {
      return vote(
        "sr_confluence",
        "long",
        60 + bestTouches * 3,
        `${bestTouches}-touch support level holding below price.`,
      );
    }
    if (latest.close < bestLevel && latest.high >= bestLevel) {
      return vote(
        "sr_confluence",
        "short",
        60 + bestTouches * 3,
        `${bestTouches}-touch resistance level rejecting above price.`,
      );
    }
  }
  return null;
}

function evaluateLondonKillzone(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const hourUtc = new Date(latest.time).getUTCHours();
  if (hourUtc < 7 || hourUtc >= 10) return null;
  const prior = candles.slice(-24, -1);
  const open = prior[0]?.open ?? latest.open;
  if (latest.close > open && latest.close > candles.at(-2)!.close) {
    return vote(
      "london_killzone",
      "long",
      58 + ((latest.close - open) / atr) * 15,
      "London-session momentum bias to the upside.",
    );
  }
  if (latest.close < open && latest.close < candles.at(-2)!.close) {
    return vote(
      "london_killzone",
      "short",
      58 + ((open - latest.close) / atr) * 15,
      "London-session momentum bias to the downside.",
    );
  }
  return null;
}

function evaluateFvg(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const searchWindow = candles.slice(-12, -1);
  for (let index = searchWindow.length - 1; index >= 2; index -= 1) {
    const first = searchWindow[index - 2];
    const third = searchWindow[index];
    if (third.low > first.high && latest.low <= third.low && latest.close > third.low) {
      return vote(
        "fvg",
        "long",
        58 + ((third.low - first.high) / atr) * 25,
        "A bullish fair-value gap was retested and held.",
      );
    }
    if (third.high < first.low && latest.high >= third.high && latest.close < third.high) {
      return vote(
        "fvg",
        "short",
        58 + ((first.low - third.high) / atr) * 25,
        "A bearish fair-value gap was retested and rejected.",
      );
    }
  }
  return null;
}

function evaluateOpeningRangeBreakout(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  // Find the most recent session open (07:00 London, 12:00 NY, 22:00/00:00 Asia)
  // by scanning backward for an hour rollover into one of the anchor hours.
  const SESSION_OPEN_HOURS = new Set([7, 12, 22, 0]);
  let sessionIndex = -1;
  for (let index = candles.length - 2; index >= 1; index -= 1) {
    const hour = new Date(candles[index].time).getUTCHours();
    const priorHour = new Date(candles[index - 1].time).getUTCHours();
    if (SESSION_OPEN_HOURS.has(hour) && hour !== priorHour) {
      sessionIndex = index;
      break;
    }
  }
  // Only trade a session's opening range while that session is still young —
  // a boundary from hours ago is stale, not an opening range. Without this
  // guard, random mid-session bars would masquerade as the "opening range".
  if (sessionIndex < 0 || candles.length - sessionIndex > 4) return null;
  const rangeHigh = Math.max(
    candles[sessionIndex]?.high ?? latest.high,
    candles[sessionIndex + 1]?.high ?? latest.high,
  );
  const rangeLow = Math.min(
    candles[sessionIndex]?.low ?? latest.low,
    candles[sessionIndex + 1]?.low ?? latest.low,
  );
  const rangeHeight = rangeHigh - rangeLow;
  if (rangeHeight <= 0) return null;
  const breakoutDistance =
    latest.close > rangeHigh
      ? latest.close - rangeHigh
      : latest.close < rangeLow
        ? rangeLow - latest.close
        : 0;
  if (breakoutDistance >= atr * 0.4) {
    if (latest.close > rangeHigh) {
      return vote(
        "opening_range_breakout",
        "long",
        62 + (breakoutDistance / atr) * 20,
        `Session opening range broken to the upside (range height ${rangeHeight.toFixed(2)}).`,
      );
    }
    if (latest.close < rangeLow) {
      return vote(
        "opening_range_breakout",
        "short",
        62 + (breakoutDistance / atr) * 20,
        `Session opening range broken to the downside (range height ${rangeHeight.toFixed(2)}).`,
      );
    }
  }
  return null;
}

function evaluateHeikenAshiScalp(candles: SignalEngineCandle[], atr: number) {
  const closes = candles.map((candle) => candle.close);
  const ema21 = emaSeries(closes, 21).at(-1)!;
  const latest = candles.at(-1)!;
  // Build Heiken Ashi values over the last few candles (with highs so both
  // wick checks are symmetric). The seed is the raw candle 5 bars back; only
  // the final three HA blocks are used, so the warmup is sufficient.
  const haFull: { open: number; close: number; high: number; low: number }[] = [];
  let seed = candles.at(-6)!;
  for (let index = candles.length - 6; index < candles.length; index += 1) {
    const candle = candles[index];
    const open = (seed.open + seed.close) / 2;
    const close = (candle.open + candle.high + candle.low + candle.close) / 4;
    const high = Math.max(candle.high, open, close);
    const low = Math.min(candle.low, open, close);
    haFull.push({ open, close, high, low });
    seed = { open, close, high, low } as SignalEngineCandle;
  }
  const blocks = haFull.slice(-3);
  if (blocks.length < 3) return null;
  const wickOk = (bar: (typeof blocks)[number], long: boolean) => {
    const body = Math.abs(bar.close - bar.open);
    const wick = long
      ? Math.min(bar.open, bar.close) - bar.low
      : bar.high - Math.max(bar.open, bar.close);
    return wick <= Math.max(body, atr * 0.05) * 0.6;
  };
  const allGreen = blocks.every((bar) => bar.close > bar.open);
  const allRed = blocks.every((bar) => bar.close < bar.open);
  if (allGreen && wickOk(blocks.at(-1)!, true) && latest.close > ema21) {
    return vote(
      "heiken_ashi_scalp",
      "long",
      58 + ((latest.close - ema21) / atr) * 10,
      "Three consecutive green Heiken Ashi candles above EMA21.",
    );
  }
  if (allRed && wickOk(blocks.at(-1)!, false) && latest.close < ema21) {
    return vote(
      "heiken_ashi_scalp",
      "short",
      58 + ((ema21 - latest.close) / atr) * 10,
      "Three consecutive red Heiken Ashi candles below EMA21.",
    );
  }
  return null;
}

function evaluateQullamaggieBreakout(candles: SignalEngineCandle[], atr: number, relaxed = false) {
  const latest = candles.at(-1)!;
  const closes = candles.map((candle) => candle.close);
  const ema50 = emaSeries(closes, 50).at(-1)!;
  if (closes.length < 60) return null;
  const recent = candles.slice(-30, -1);
  const prior = candles.slice(-21, -1);
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  const range = priorHigh - priorLow;
  const averageRange = average(recent.map((candle) => candle.high - candle.low));
  // Standard: tight 1.1x compression before the pop. Relaxed: 1.25x, and the
  // volume-less breakout distance drops to 0.4 ATR — the harness measures
  // whether the compression + volume double gate is too strict for M15/H1.
  const compression = range <= averageRange * (relaxed ? 1.25 : 1.1);
  const volume = candles.map((candle) => candle.volume ?? 0);
  const averageVolume = average(volume.slice(-20, -1));
  const latestVolume = volume.at(-1) ?? 0;
  const volumeSurge = averageVolume > 0 && latestVolume >= averageVolume * 1.15;
  const breakoutDistance = relaxed ? atr * 0.4 : atr * 0.8;
  if (
    compression &&
    latest.close > priorHigh &&
    latest.close > ema50 &&
    (volumeSurge || latest.close - priorHigh >= breakoutDistance)
  ) {
    return vote(
      "qullamaggie_breakout",
      "long",
      64 + ((latest.close - priorHigh) / atr) * 20,
      "Qullamaggie-style breakout: compression above EMA50 cleared the prior range high.",
    );
  }
  if (
    compression &&
    latest.close < priorLow &&
    latest.close < ema50 &&
    (volumeSurge || priorLow - latest.close >= breakoutDistance)
  ) {
    return vote(
      "qullamaggie_breakout",
      "short",
      64 + ((priorLow - latest.close) / atr) * 20,
      "Qullamaggie-style breakdown: compression below EMA50 cleared the prior range low.",
    );
  }
  return null;
}

function evaluateTrendlineBreak(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const window = candles.slice(-24, -1);
  if (window.length < 12) return null;
  const closes = window.map((candle) => candle.close);
  const n = closes.length;
  const meanX = (n - 1) / 2;
  const meanY = average(closes);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - meanX) * (closes[index] - meanY);
    denominator += (index - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  // The window holds candles x = 0..n-1; the latest close is at x = n-1.
  const trendlineAtCurrent = intercept + slope * (n - 1);
  const distance = latest.close - trendlineAtCurrent;
  const priorClose = candles.at(-2)!.close;
  const priorTrendline = intercept + slope * (n - 2);
  if (slope < 0 && distance > 0 && priorClose <= priorTrendline + atr * 0.05) {
    return vote(
      "trendline_break",
      "long",
      60 + (distance / atr) * 18,
      "Downward trendline broken and closing back above it.",
    );
  }
  if (slope > 0 && distance < 0 && priorClose >= priorTrendline - atr * 0.05) {
    return vote(
      "trendline_break",
      "short",
      60 + (Math.abs(distance) / atr) * 18,
      "Upward trendline broken and closing back below it.",
    );
  }
  return null;
}

function evaluateFibRetracement(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const lookback = candles.slice(-60, -1);
  if (lookback.length < 20) return null;
  const swingHigh = Math.max(...lookback.map((candle) => candle.high));
  const swingLow = Math.min(...lookback.map((candle) => candle.low));
  const leg = swingHigh - swingLow;
  if (leg <= 0) return null;
  const fib50 = swingLow + leg * 0.5;
  const fib618 = swingLow + leg * 0.618;
  const withinZone = latest.close >= fib50 && latest.close <= fib618;
  if (!withinZone) return null;
  const aboveHalf = latest.close >= (swingHigh + swingLow) / 2;
  if (aboveHalf && latest.low <= fib50 && latest.close > fib50) {
    return vote(
      "fib_retracement",
      "long",
      60 + ((latest.close - fib50) / atr) * 15,
      "Pullback held the 0.5–0.618 retracement of the dominant up-leg.",
    );
  }
  if (!aboveHalf && latest.high >= fib618 && latest.close < fib618) {
    return vote(
      "fib_retracement",
      "short",
      60 + ((fib618 - latest.close) / atr) * 15,
      "Pullback rejected the 0.5–0.618 retracement of the dominant down-leg.",
    );
  }
  return null;
}

function evaluateNyKillzone(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  const hourUtc = new Date(latest.time).getUTCHours();
  if (hourUtc < 12 || hourUtc >= 15) return null;
  const prior = candles.slice(-24, -1);
  const open = prior[0]?.open ?? latest.open;
  if (latest.close > open && latest.close > candles.at(-2)!.close) {
    return vote(
      "ny_killzone",
      "long",
      58 + ((latest.close - open) / atr) * 15,
      "New York-session momentum bias to the upside.",
    );
  }
  if (latest.close < open && latest.close < candles.at(-2)!.close) {
    return vote(
      "ny_killzone",
      "short",
      58 + ((open - latest.close) / atr) * 15,
      "New York-session momentum bias to the downside.",
    );
  }
  return null;
}

function evaluateAsianRange(candles: SignalEngineCandle[], atr: number) {
  const latest = candles.at(-1)!;
  // Asian range: the 22:00–06:00 UTC block. Find its bounds from recent candles
  // whose hour is inside the block, then test a London-open breakout.
  const hourUtc = new Date(latest.time).getUTCHours();
  if (hourUtc >= 7) return null; // only relevant before/at London open
  const asianCandles = candles.slice(-12).filter((candle) => {
    const hour = new Date(candle.time).getUTCHours();
    return hour >= 22 || hour < 7;
  });
  if (asianCandles.length < 3) return null;
  const rangeHigh = Math.max(...asianCandles.map((candle) => candle.high));
  const rangeLow = Math.min(...asianCandles.map((candle) => candle.low));
  if (latest.close > rangeHigh && latest.close - rangeHigh >= atr * 0.3) {
    return vote(
      "asian_range",
      "long",
      60 + ((latest.close - rangeHigh) / atr) * 15,
      "Asian-session range broken to the upside at the London open.",
    );
  }
  if (latest.close < rangeLow && rangeLow - latest.close >= atr * 0.3) {
    return vote(
      "asian_range",
      "short",
      60 + ((rangeLow - latest.close) / atr) * 15,
      "Asian-session range broken to the downside at the London open.",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Harmonic patterns (Gartley / Bat / Butterfly) — classic public definitions
// (H.M. Gartley 1935; Scott Carney's Harmonic Trading for the Bat). XABCD
// swing structure validated against the canonical Fibonacci ratios, entry at
// the D "potential reversal zone" on a rejection close.
// ---------------------------------------------------------------------------

export type SwingPoint = { index: number; price: number; kind: "high" | "low" };

export function findSwingPoints(candles: SignalEngineCandle[], k = 2): SwingPoint[] {
  if (candles.length < k * 2 + 1) return [];
  const swings: SwingPoint[] = [];
  for (let index = k; index < candles.length - k; index += 1) {
    const bar = candles[index];
    let isHigh = true;
    let isLow = true;
    for (let offset = 1; offset <= k; offset += 1) {
      if (candles[index - offset].high >= bar.high || candles[index + offset].high >= bar.high)
        isHigh = false;
      if (candles[index - offset].low <= bar.low || candles[index + offset].low <= bar.low)
        isLow = false;
    }
    if (isHigh) swings.push({ index, price: bar.high, kind: "high" });
    else if (isLow) swings.push({ index, price: bar.low, kind: "low" });
  }
  // Collapse consecutive same-kind swings into the more extreme one so the
  // sequence strictly alternates high/low.
  const deduped: SwingPoint[] = [];
  for (const swing of swings) {
    const last = deduped.at(-1);
    if (last && last.kind === swing.kind) {
      if (
        (swing.kind === "high" && swing.price > last.price) ||
        (swing.kind === "low" && swing.price < last.price)
      ) {
        deduped[deduped.length - 1] = swing;
      }
    } else {
      deduped.push(swing);
    }
  }
  return deduped;
}

type HarmonicPattern = {
  id: "gartley" | "bat_pattern" | "butterfly_pattern";
  abMin: number;
  abMax: number;
  bcMin: number;
  bcMax: number;
  cdMin: number;
  cdMax: number;
  /** D as a retracement (0..1) or extension (>1) of the XA leg. */
  dRatio: number;
  dTolerance: number;
};

const HARMONIC_PATTERNS: HarmonicPattern[] = [
  {
    id: "gartley",
    abMin: 0.586,
    abMax: 0.65,
    bcMin: 0.382,
    bcMax: 0.886,
    cdMin: 1.272,
    cdMax: 1.618,
    dRatio: 0.786,
    dTolerance: 0.06,
  },
  {
    id: "bat_pattern",
    abMin: 0.382,
    abMax: 0.5,
    bcMin: 0.382,
    bcMax: 0.886,
    cdMin: 1.27,
    cdMax: 1.618,
    dRatio: 0.886,
    dTolerance: 0.06,
  },
  {
    id: "butterfly_pattern",
    abMin: 0.75,
    abMax: 0.825,
    bcMin: 0.382,
    bcMax: 0.886,
    cdMin: 1.618,
    cdMax: 2.24,
    dRatio: 1.27,
    dTolerance: 0.08,
  },
];

function evaluateHarmonic(
  candles: SignalEngineCandle[],
  atr: number,
  pattern: HarmonicPattern,
): StrategyVote | null {
  const swings = findSwingPoints(candles);
  if (swings.length < 4) return null;
  const [C, B, A, X] = swings.slice(-4).reverse(); // X oldest … C newest
  if (!C || !B || !A || !X) return null;
  // The structure must be recent — C inside the last ~30 bars, and the whole
  // XABCD within the last ~120 so a stale multi-week X can't anchor a fresh C.
  if (candles.length - C.index > 30) return null;
  if (candles.length - X.index > 120) return null;

  const xa = Math.abs(A.price - X.price);
  const ab = Math.abs(A.price - B.price);
  const bc = Math.abs(C.price - B.price);
  if (xa <= 0 || ab <= 0 || bc <= 0) return null;

  const abRatio = ab / xa;
  if (abRatio < pattern.abMin || abRatio > pattern.abMax) return null;
  const bcRatio = bc / ab;
  if (bcRatio < pattern.bcMin || bcRatio > pattern.bcMax) return null;

  // A > X -> bullish XABCD (D is a projected LOW to buy); A < X -> bearish.
  const bullish = A.price > X.price;
  const dXa = bullish ? A.price - pattern.dRatio * xa : A.price + pattern.dRatio * xa;
  const latest = candles.at(-1)!;
  const touch = bullish ? latest.low : latest.high;
  const close = latest.close;

  // Price must have arrived at D: the CD leg ratio and the XA-zone check.
  const cdActual = Math.abs(touch - C.price) / bc;
  if (cdActual < pattern.cdMin || cdActual > pattern.cdMax) return null;
  // Tight D-zone check: the touch must sit close to the ideal XA retracement.
  // The ATR component is small so high-volatility instruments cannot stretch
  // the zone into noise.
  if (Math.abs(touch - dXa) > Math.max(pattern.dTolerance * xa, atr * 0.25)) return null;
  // Rejection close: price wicks into the zone and closes back toward C with a
  // meaningful body (not a doji), so a one-tick wick cannot fire the pattern.
  const bounced = bullish ? close > touch : close < touch;
  if (!bounced || Math.abs(close - touch) < atr * 0.15) return null;

  const idealCd = (pattern.cdMin + pattern.cdMax) / 2;
  const cdQuality = 1 - Math.min(1, Math.abs(cdActual - idealCd) / (idealCd * 0.3));
  const xaQuality = 1 - Math.min(1, Math.abs(touch - dXa) / (pattern.dTolerance * xa));
  const strength = Math.round(clamp(58 + (cdQuality * 0.6 + xaQuality * 0.4) * 18, 55, 80));
  const direction: SignalDirection = bullish ? "long" : "short";
  return vote(
    pattern.id,
    direction,
    strength,
    `${pattern.id} potential reversal zone at D (${pattern.dRatio} of XA) rejected ${bullish ? "up" : "down"}.`,
  );
}

// ---------------------------------------------------------------------------
// Exhaustion / reversal strategies — everything above either confirms a move
// already running (trend) or catches one just starting (breakout). None of
// it catches a move ending, which is how a late entry happens at the top of
// a leg. These five exist to find the sharp top and the sharp bottom.
// ---------------------------------------------------------------------------

/** Chronological swing points of one kind, oldest first — the shared shape
 *  both divergence strategies compare against price. */
function swingsOfKind(swings: SwingPoint[], kind: "high" | "low") {
  return swings.filter((swing) => swing.kind === kind);
}

function evaluateRsiDivergence(candles: SignalEngineCandle[]): StrategyVote | null {
  const swings = findSwingPoints(candles, 2);
  const rsi = rsiSeries(
    candles.map((candle) => candle.close),
    14,
  );
  const lastIndex = candles.length - 1;
  const lastClose = candles[lastIndex].close;

  const lows = swingsOfKind(swings, "low");
  if (lows.length >= 2) {
    const a = lows[lows.length - 2];
    const b = lows[lows.length - 1];
    const rsiA = rsi[a.index];
    const rsiB = rsi[b.index];
    const spacing = b.index - a.index;
    // RSI must be in genuinely weak territory (not mid-range noise) and the
    // reclaim must already be underway — a divergence that is still falling
    // is a prediction, not yet a trade.
    if (
      typeof rsiA === "number" &&
      typeof rsiB === "number" &&
      b.price < a.price &&
      rsiB > rsiA &&
      rsiB < 45 &&
      spacing >= 5 &&
      spacing <= 60 &&
      lastIndex - b.index <= 5 &&
      lastClose > candles[b.index].close
    ) {
      return vote(
        "rsi_divergence",
        "long",
        60 + Math.min(20, Math.abs(rsiB - rsiA) * 1.5),
        `Price made a lower low while RSI14 made a higher low (${rsiA.toFixed(1)} -> ${rsiB.toFixed(1)}) — bullish divergence, reclaim underway.`,
      );
    }
  }

  const highs = swingsOfKind(swings, "high");
  if (highs.length >= 2) {
    const a = highs[highs.length - 2];
    const b = highs[highs.length - 1];
    const rsiA = rsi[a.index];
    const rsiB = rsi[b.index];
    const spacing = b.index - a.index;
    if (
      typeof rsiA === "number" &&
      typeof rsiB === "number" &&
      b.price > a.price &&
      rsiB < rsiA &&
      rsiB > 55 &&
      spacing >= 5 &&
      spacing <= 60 &&
      lastIndex - b.index <= 5 &&
      lastClose < candles[b.index].close
    ) {
      return vote(
        "rsi_divergence",
        "short",
        60 + Math.min(20, Math.abs(rsiB - rsiA) * 1.5),
        `Price made a higher high while RSI14 made a lower high (${rsiA.toFixed(1)} -> ${rsiB.toFixed(1)}) — bearish divergence, rejection underway.`,
      );
    }
  }
  return null;
}

function evaluateMacdDivergence(candles: SignalEngineCandle[], atr: number): StrategyVote | null {
  const swings = findSwingPoints(candles, 2);
  const closes = candles.map((candle) => candle.close);
  // Reads the MACD LINE (fast EMA - slow EMA), not the histogram — macd_hist
  // already keys on the histogram, so this stays a distinguishable reading
  // rather than a second vote for the same thing.
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  const macd = closes.map((_, index) => fast[index] - slow[index]);
  const lastIndex = candles.length - 1;
  const lastClose = candles[lastIndex].close;

  const lows = swingsOfKind(swings, "low");
  if (lows.length >= 2) {
    const a = lows[lows.length - 2];
    const b = lows[lows.length - 1];
    const spacing = b.index - a.index;
    // Below the zero line: this is a bottom, not a pullback inside an
    // uptrend where the line never left positive territory.
    if (
      b.price < a.price &&
      macd[b.index] > macd[a.index] &&
      macd[b.index] < 0 &&
      spacing >= 5 &&
      spacing <= 60 &&
      lastIndex - b.index <= 5 &&
      lastClose > candles[b.index].close
    ) {
      return vote(
        "macd_divergence",
        "long",
        60 + Math.min(20, (Math.abs(macd[b.index] - macd[a.index]) / atr) * 60),
        "Price made a lower low while the MACD line made a higher low below the zero line — bullish divergence.",
      );
    }
  }

  const highs = swingsOfKind(swings, "high");
  if (highs.length >= 2) {
    const a = highs[highs.length - 2];
    const b = highs[highs.length - 1];
    const spacing = b.index - a.index;
    if (
      b.price > a.price &&
      macd[b.index] < macd[a.index] &&
      macd[b.index] > 0 &&
      spacing >= 5 &&
      spacing <= 60 &&
      lastIndex - b.index <= 5 &&
      lastClose < candles[b.index].close
    ) {
      return vote(
        "macd_divergence",
        "short",
        60 + Math.min(20, (Math.abs(macd[b.index] - macd[a.index]) / atr) * 60),
        "Price made a higher high while the MACD line made a lower high above the zero line — bearish divergence.",
      );
    }
  }
  return null;
}

function evaluateClimaxExhaustion(candles: SignalEngineCandle[], atr: number): StrategyVote | null {
  const latest = candles.at(-1)!;
  const range = latest.high - latest.low;
  const rangeWindow = candles.slice(-50).map((candle) => candle.high - candle.low);
  const sortedRanges = [...rangeWindow].sort((left, right) => left - right);
  const p90 = sortedRanges[Math.floor(0.9 * (sortedRanges.length - 1))];
  if (range <= 0 || range < p90) return null;

  const priorTwenty = candles.slice(-21, -1);
  // Volume only confirms the climax when the feed actually reports it — many
  // feeds omit it, and the range condition alone is still meaningful.
  if (typeof latest.volume === "number" && priorTwenty.length === 20) {
    const averageVolume = average(priorTwenty.map((candle) => candle.volume ?? 0));
    if (latest.volume < averageVolume * 1.5) return null;
  }

  const priorHigh = Math.max(...priorTwenty.map((candle) => candle.high));
  const priorLow = Math.min(...priorTwenty.map((candle) => candle.low));
  const lowerThird = latest.low + range / 3;
  const upperThird = latest.low + (range * 2) / 3;

  if (latest.high > priorHigh && latest.close <= lowerThird) {
    return vote(
      "climax_exhaustion",
      "short",
      58 + Math.min(22, (range / atr - 1) * 12),
      `Range expanded to ${(range / atr).toFixed(2)}x ATR on a new 20-bar high and closed near the low — climax rejected the top.`,
    );
  }
  if (latest.low < priorLow && latest.close >= upperThird) {
    return vote(
      "climax_exhaustion",
      "long",
      58 + Math.min(22, (range / atr - 1) * 12),
      `Range expanded to ${(range / atr).toFixed(2)}x ATR on a new 20-bar low and closed near the high — climax rejected the bottom.`,
    );
  }
  return null;
}

function evaluateStopRunReversal(candles: SignalEngineCandle[], atr: number): StrategyVote | null {
  const sweepBar = candles.at(-2)!;
  const confirmBar = candles.at(-1)!;
  const prior = candles.slice(-22, -2);
  if (prior.length !== 20) return null;
  const priorHigh = Math.max(...prior.map((candle) => candle.high));
  const priorLow = Math.min(...prior.map((candle) => candle.low));
  // Stricter than liquidity_sweep's single-bar version: a wick through the
  // level is only a guess, the NEXT bar closing back inside on a real body
  // (not a doji) is what actually makes this tradeable.
  const body = Math.abs(confirmBar.close - confirmBar.open);
  if (body < atr * 0.25) return null;

  if (
    sweepBar.high > priorHigh &&
    confirmBar.close < priorHigh &&
    confirmBar.close < confirmBar.open
  ) {
    const excursion = sweepBar.high - priorHigh;
    return vote(
      "stop_run_reversal",
      "short",
      60 + Math.min(20, (excursion / atr) * 15),
      "The prior 20-bar high was swept, then the next bar closed back below it on a real body — stop run reversed short.",
    );
  }
  if (
    sweepBar.low < priorLow &&
    confirmBar.close > priorLow &&
    confirmBar.close > confirmBar.open
  ) {
    const excursion = priorLow - sweepBar.low;
    return vote(
      "stop_run_reversal",
      "long",
      60 + Math.min(20, (excursion / atr) * 15),
      "The prior 20-bar low was swept, then the next bar closed back above it on a real body — stop run reversed long.",
    );
  }
  return null;
}

function evaluateFailedBreakout(candles: SignalEngineCandle[], atr: number): StrategyVote | null {
  const latest = candles.at(-1)!;
  const lastIndex = candles.length - 1;
  // Walk backward from the most recent bar first so the freshest qualifying
  // failure wins — a fresher trap is the stronger, more tradeable signal.
  for (let i = lastIndex - 1; i >= lastIndex - 10; i -= 1) {
    const window = candles.slice(i - 20, i);
    if (window.length < 20) continue;
    const windowHigh = Math.max(...window.map((candle) => candle.high));
    const windowLow = Math.min(...window.map((candle) => candle.low));
    const barsSince = lastIndex - i;
    if (candles[i].close > windowHigh && latest.close < windowHigh - atr * 0.25) {
      return vote(
        "failed_breakout",
        "short",
        58 + clamp(20 - barsSince * 1.5, 4, 20),
        `Breakout above the prior 20-bar high failed; price closed back inside ${barsSince} bars later.`,
      );
    }
    if (candles[i].close < windowLow && latest.close > windowLow + atr * 0.25) {
      return vote(
        "failed_breakout",
        "long",
        58 + clamp(20 - barsSince * 1.5, 4, 20),
        `Breakdown below the prior 20-bar low failed; price closed back inside ${barsSince} bars later.`,
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Macro-aware strategies — read the calendar / COT overlay threaded in by
// scanCandlesForSignal. In walk-forward (no macro) they abstain and stay
// neutral, so their weight is never distorted by the candle-only test window.
// ---------------------------------------------------------------------------

const PAIR_CURRENCIES_ENGINE: Record<string, [string, string]> = {
  EURUSD: ["EUR", "USD"],
  GBPUSD: ["GBP", "USD"],
  USDJPY: ["USD", "JPY"],
  AUDUSD: ["AUD", "USD"],
  USDCAD: ["USD", "CAD"],
  NZDUSD: ["NZD", "USD"],
  USDCHF: ["USD", "CHF"],
  EURGBP: ["EUR", "GBP"],
  EURJPY: ["EUR", "JPY"],
  GBPJPY: ["GBP", "JPY"],
  AUDJPY: ["AUD", "JPY"],
  XAUUSD: ["USD", "USD"], // gold is USD-priced
};

// Exported for signals.functions.ts (buildArmedContext's minutesToHighImpact
// input): the null-signal branch needs the SAME currency-relevance filter
// macroConfluenceAdjustment applies below, not a re-derivation of it from the
// pair string alone (XAUUSD is the case that would silently diverge — gold
// is USD-priced, not "XAU"-priced, the way a naive substring split would read it).
export function pairCurrencies(pair: string): string[] {
  return PAIR_CURRENCIES_ENGINE[pair] ?? ["USD", "USD"];
}

/**
 * Minutes from `now` to the event's real UTC release timestamp. Positive: the
 * release is still ahead. Negative: it already printed. Everything reads this
 * instead of comparing a bare HH:MM against the clock — that discarded the
 * event's date entirely, so a wrapped ±720-minute window matched an event on
 * any day the calendar happened to list one, not just today.
 */
function minutesUntilRelease(event: { timestamp: number }, now: number): number {
  return (event.timestamp - now) / 60_000;
}

function evaluateNewsReactive(
  candles: SignalEngineCandle[],
  atr: number,
  pair: string,
  macro?: EngineMacroContext,
  now: number = Date.now(),
): StrategyVote | null {
  const currencies = pairCurrencies(pair);
  // Up to an hour ahead of the release, or up to half an hour after it —
  // outside that band this is just a calendar entry, not a reactive setup.
  const imminent = (macro?.events ?? []).find((event) => {
    if (event.impact !== "High" || !currencies.includes(event.currency)) return false;
    const minutesUntil = minutesUntilRelease(event, now);
    return minutesUntil > -30 && minutesUntil <= 60;
  });
  if (!imminent) return null;
  // Momentum into the event window — the directional impulse of the last 3 bars.
  const closes = candles.map((candle) => candle.close);
  const impulse = closes.at(-1)! - closes.at(-4)!;
  if (Math.abs(impulse) < atr * 0.2) return null;
  const direction: SignalDirection = impulse > 0 ? "long" : "short";
  return vote(
    "news_reactive",
    direction,
    Math.min(75, 58 + (Math.abs(impulse) / atr) * 10),
    `High-impact ${imminent.currency} release (${imminent.title}) — momentum leaning ${direction} into the window.`,
  );
}

function evaluateAiConfluence(
  candles: SignalEngineCandle[],
  atr: number,
  pair: string,
  macro?: EngineMacroContext,
  now: number = Date.now(),
): StrategyVote | null {
  const cot = macro?.cot;
  if (!cot || Math.abs(cot.netPct) < 8) return null;
  // CFTC COT is Tuesday data published Friday — routinely 3-8 days old, and by
  // the following Thursday it's stale for over a week while the raw netPct
  // still looks exactly as confident as the day it printed. Ages beyond two
  // weeks are not "current positioning" any more; inside that window the
  // strength BONUS (not the base vote — the position itself is still real)
  // decays on a five-day half-life.
  const ageDays = (now - Date.parse(cot.reportDate)) / (24 * 60 * 60 * 1000);
  if (ageDays > 14) return null;
  const decay = 0.5 ** (ageDays / 5);
  // COT is quoted for the pair's futures market. JPY pairs quote JPY (net long
  // JPY => bearish the pair); everything else quotes the base currency (net
  // long base => bullish the pair); XAUUSD quotes GOLD (net long gold => long).
  const direction: SignalDirection = pair.endsWith("JPY")
    ? cot.net >= 0
      ? "short"
      : "long"
    : cot.net >= 0
      ? "long"
      : "short";
  const catalyst = (macro?.events ?? []).some(
    (event) => event.impact === "High" && pairCurrencies(pair).includes(event.currency),
  );
  const strength = Math.min(
    80,
    58 + ((Math.abs(cot.netPct) / 100) * 16 + (catalyst ? 8 : 0)) * decay,
  );
  return vote(
    "ai_confluence",
    direction,
    strength,
    `COT positioning ${cot.net >= 0 ? "net long" : "net short"} (${cot.netPct}%)${catalyst ? " + high-impact catalyst" : ""} — positioning overlay, report ${ageDays.toFixed(1)}d old.`,
  );
}

/**
 * Confluence penalty for a pending or just-released High-impact event on
 * either of the pair's currencies. Proximity only ever subtracts — a pending
 * CPI print makes a technical setup less reliable, not more, and a
 * post-release momentum bonus would need fitted reaction profiles this
 * engine does not have.
 */
export function macroConfluenceAdjustment<
  Event extends { impact: string; timestamp: number; currency: string },
>(
  events: Event[],
  pair: string,
  now: number,
): { adjustment: number; risk: "high" | "elevated" | "none"; event: Event | null } {
  const currencies = pairCurrencies(pair);
  const candidates = events.filter(
    (event) => event.impact === "High" && currencies.includes(event.currency),
  );
  if (candidates.length === 0) return { adjustment: 0, risk: "none", event: null };

  // The event closest to right now, whether it's still ahead or just printed
  // — that's the one actually driving tape risk at this instant.
  const nearest = candidates.reduce((closest, event) =>
    Math.abs(event.timestamp - now) < Math.abs(closest.timestamp - now) ? event : closest,
  );
  const minutesUntil = (nearest.timestamp - now) / 60_000;

  if (minutesUntil >= 0 && minutesUntil <= 60) {
    // Linear ramp from -8 at the release down to 0 a full hour out.
    const magnitude = Math.round(8 * (1 - minutesUntil / 60));
    return { adjustment: magnitude === 0 ? 0 : -magnitude, risk: "high", event: nearest };
  }
  if (minutesUntil >= -30 && minutesUntil < 0) {
    return { adjustment: -4, risk: "high", event: nearest };
  }
  if (minutesUntil > 60 && minutesUntil <= 240) {
    return { adjustment: 0, risk: "elevated", event: nearest };
  }
  return { adjustment: 0, risk: "none", event: null };
}

export function evaluateStrategy(
  strategyId: string,
  candles: SignalEngineCandle[],
  atr: number,
  mode: SignalMode = "intraday",
  context?: { pair?: string; macro?: EngineMacroContext; now?: number },
  variant: StrategyTriggerVariant = "standard",
): StrategyVote | null {
  const pair = context?.pair ?? "EURUSD";
  const macro = context?.macro;
  // Injectable clock. The two macro-aware strategies compare event timestamps
  // and COT report ages against "now" — and during a REPLAY, now is the bar
  // being replayed, not the wall clock. Reading Date.now() internally made a
  // backtest ask "is there a release imminent today?" while walking bars from
  // two years ago, which is both wrong and untestable.
  const now = context?.now ?? Date.now();
  switch (strategyId) {
    case "ema_trend":
      return evaluateEmaTrend(candles, atr, mode);
    case "supertrend":
      return evaluateSupertrend(candles, mode, variant === "relaxed");
    case "ma_ribbon":
      return evaluateMaRibbon(candles, atr);
    case "ichimoku":
      return evaluateIchimoku(candles, atr);
    case "rsi_momo":
      return evaluateRsiMomentum(candles);
    case "macd_hist":
      return evaluateMacd(candles, atr);
    case "stoch_rsi":
      return evaluateStochRsi(candles, mode);
    case "cci_extreme":
      return evaluateCci(candles);
    case "bollinger_squeeze":
      return evaluateBollingerBreakout(candles, atr, mode, variant === "relaxed");
    case "keltner_break":
      return evaluateKeltnerBreak(candles, atr);
    case "donchian_break":
      return evaluateDonchianBreak(candles, atr);
    case "atr_expansion":
      return evaluateAtrExpansion(candles, atr, mode);
    case "liquidity_sweep":
      return evaluateLiquiditySweep(candles, atr);
    case "fvg":
      return evaluateFvg(candles, atr);
    case "order_block":
      return evaluateOrderBlock(candles, atr);
    case "bos_choch":
      return evaluateBosChoch(candles, atr);
    case "vwap_mean_rev":
      return evaluateVwapMeanReversion(candles, atr, mode);
    case "sr_confluence":
      return evaluateSrConfluence(candles, atr);
    case "london_killzone":
      return evaluateLondonKillzone(candles, atr);
    case "opening_range_breakout":
      return evaluateOpeningRangeBreakout(candles, atr);
    case "heiken_ashi_scalp":
      return evaluateHeikenAshiScalp(candles, atr);
    case "qullamaggie_breakout":
      return evaluateQullamaggieBreakout(candles, atr, variant === "relaxed");
    case "trendline_break":
      return evaluateTrendlineBreak(candles, atr);
    case "fib_retracement":
      return evaluateFibRetracement(candles, atr);
    case "ny_killzone":
      return evaluateNyKillzone(candles, atr);
    case "asian_range":
      return evaluateAsianRange(candles, atr);
    case "gartley":
      return evaluateHarmonic(candles, atr, HARMONIC_PATTERNS[0]);
    case "bat_pattern":
      return evaluateHarmonic(candles, atr, HARMONIC_PATTERNS[1]);
    case "butterfly_pattern":
      return evaluateHarmonic(candles, atr, HARMONIC_PATTERNS[2]);
    case "news_reactive":
      return evaluateNewsReactive(candles, atr, pair, macro, now);
    case "ai_confluence":
      return evaluateAiConfluence(candles, atr, pair, macro, now);
    case "rsi_divergence":
      return evaluateRsiDivergence(candles);
    case "macd_divergence":
      return evaluateMacdDivergence(candles, atr);
    case "climax_exhaustion":
      return evaluateClimaxExhaustion(candles, atr);
    case "stop_run_reversal":
      return evaluateStopRunReversal(candles, atr);
    case "failed_breakout":
      return evaluateFailedBreakout(candles, atr);
    default:
      return null;
  }
}

function precisionForPair(pair: string) {
  if (pair === "XAUUSD" || pair.endsWith("JPY")) return 3;
  return 5;
}

function roundForPair(value: number, pair: string) {
  return Number(value.toFixed(precisionForPair(pair)));
}

export function buildRiskLevels({
  pair,
  mode,
  direction,
  quote,
  candles,
  atr,
}: {
  pair: string;
  mode: SignalMode;
  direction: SignalDirection;
  quote: SignalEngineQuote;
  candles: SignalEngineCandle[];
  atr: number;
}): RiskLevels {
  const completed = candles.filter((candle) => candle.complete);
  if (completed.length < 12)
    throw new Error("At least 12 complete candles are required for risk placement.");
  const entry = direction === "long" ? quote.ask : quote.bid;
  const spread = Math.max(0, quote.ask - quote.bid);
  const recent = completed.slice(-12);
  const structureStop =
    direction === "long"
      ? Math.min(...recent.map((candle) => candle.low)) - atr * 0.15
      : Math.max(...recent.map((candle) => candle.high)) + atr * 0.15;
  const structureDistance = direction === "long" ? entry - structureStop : structureStop - entry;
  const volatilityFloor = atr * (mode === "scalper" ? 1.6 : 1.8);
  const spreadFloor = spread * 4;
  const distances = [
    { basis: "structure" as const, value: Math.max(0, structureDistance) },
    { basis: "volatility" as const, value: volatilityFloor },
    { basis: "spread" as const, value: spreadFloor },
  ];
  const chosen = distances.reduce((widest, candidate) =>
    candidate.value > widest.value ? candidate : widest,
  );
  const rawStop = direction === "long" ? entry - chosen.value : entry + chosen.value;
  const rawTp1 = direction === "long" ? entry + chosen.value * 1.25 : entry - chosen.value * 1.25;
  const rawTp2 = direction === "long" ? entry + chosen.value * 2 : entry - chosen.value * 2;
  const roundedEntry = roundForPair(entry, pair);
  const stopLoss = roundForPair(rawStop, pair);

  return {
    entry: roundedEntry,
    stopLoss,
    takeProfit1: roundForPair(rawTp1, pair),
    takeProfit2: roundForPair(rawTp2, pair),
    atr: roundForPair(atr, pair),
    riskDistance: Math.abs(stopLoss - roundedEntry),
    structureDistance,
    volatilityFloor,
    spreadFloor,
    basis: chosen.basis,
  };
}

export function scanCandlesForSignal({
  pair,
  mode,
  timeframe,
  quote,
  candles,
  enabledStrategyIds,
  strategyWeights,
  macro,
  regimeOverride,
  clusterMap = DEFAULT_CLUSTERS,
  variants,
}: {
  pair: string;
  mode: SignalMode;
  /** Explicit chart timeframe (defaults to the mode's classic resolution). */
  timeframe?: SignalTimeframe;
  quote: SignalEngineQuote;
  candles: SignalEngineCandle[];
  enabledStrategyIds: string[];
  /** Walk-forward trust weights (0.15..1.15) per strategy; votes from heavily downweighted strategies are excluded. */
  strategyWeights?: Record<string, number>;
  /** Macro overlay (calendar + COT) for news_reactive / ai_confluence. */
  macro?: EngineMacroContext;
  /**
   * Pin the regime instead of reading it from the candles.
   *
   * `"none"` disables regime weighting entirely (every category weighs 1.0)
   * and reports a null regime, which is the pre-W3.2 behaviour. Two uses:
   * a backtest can measure what regime routing is actually worth by running
   * the same window with and without it, and a test can isolate the
   * DIRECTION_MARGIN logic from regime damping — otherwise a fixture built to
   * produce an exact strength tie stops being a tie the moment the regime
   * table touches one side, and the property under test silently stops being
   * tested. Same reasoning as `halfSpread: 0` in the outcome resolvers.
   */
  regimeOverride?: MarketRegime | "none";
  /**
   * Override the correlated-vote cluster map. Defaults to DEFAULT_CLUSTERS.
   * Pass a map giving every strategy its own cluster to reproduce pre-W3.1
   * confluence, which is how the size of this change stays measurable.
   */
  clusterMap?: Record<string, string>;
  /**
   * Per-strategy trigger strictness. Absent (the live path) = standard for
   * every strategy — production behavior is unchanged. The backtest harness
   * passes `{ supertrend: "relaxed", ... }` to measure whether loosening a
   * rare strategy's gates would fire more without degrading outcomes.
   */
  variants?: Partial<Record<string, StrategyTriggerVariant>>;
}): SignalEngineResult {
  const resolvedTimeframe: SignalTimeframe = timeframe ?? (mode === "scalper" ? "M5" : "H1");
  const timeframeForGating: SignalTimeframe = resolvedTimeframe;
  const complete = candles.filter((candle) => candle.complete);
  if (complete.length < 60) {
    throw new Error(`At least 60 complete ${timeframeForGating} candles are required.`);
  }

  const catalogOnlyStrategyIds = enabledStrategyIds.filter(
    (strategyId) => !IMPLEMENTED_STRATEGIES[strategyId],
  );
  const incompatibleStrategyIds = enabledStrategyIds.filter((strategyId) => {
    const definition = IMPLEMENTED_STRATEGIES[strategyId];
    return definition && !definition.timeframes.includes(timeframeForGating);
  });
  const evaluatedStrategyIds = enabledStrategyIds.filter((strategyId) =>
    IMPLEMENTED_STRATEGIES[strategyId]?.timeframes.includes(timeframeForGating),
  );
  // Walk-forward downweighting: a strategy whose recent out-of-sample accuracy
  // is poor (weight < 0.4) is flagged so it cannot contribute to a signal even
  // if it fires — the engine only leans on strategies that hold up.
  const downweightedStrategyIds = evaluatedStrategyIds.filter((strategyId) => {
    const weight = strategyWeights?.[strategyId] ?? 1;
    return weight < DOWNWEIGHT_FLOOR;
  });
  const activeStrategyIds = evaluatedStrategyIds.filter((strategyId) => {
    const weight = strategyWeights?.[strategyId] ?? 1;
    return weight >= DOWNWEIGHT_FLOOR;
  });
  const atr = latestAtr(complete);
  // Computed once, not per vote: every strategy on this scan is reading the
  // SAME market at the SAME instant, so the regime read is one fact about
  // this scan, not something that varies vote to vote. Null (too little
  // history) is handled below by falling back to a neutral 1.0 weight.
  const regime =
    regimeOverride === "none"
      ? null
      : regimeOverride
        ? { ...(readRegime(complete) ?? EMPTY_REGIME_READ), regime: regimeOverride }
        : readRegime(complete);
  // "Now" for the macro-aware strategies is the close of the last complete
  // candle, not the wall clock. Live, those coincide. In a replay they do not,
  // and using the wall clock would have a 2023 bar asking whether a release is
  // imminent TODAY. Falls back to the wall clock when the timestamp is
  // unparseable rather than silently passing NaN.
  const lastBarMs = Date.parse(complete.at(-1)!.time);
  const strategyContext = {
    pair,
    macro,
    now: Number.isFinite(lastBarMs) ? lastBarMs : Date.now(),
  };
  const votes = activeStrategyIds.flatMap((strategyId) => {
    const variant = variants?.[strategyId] ?? "standard";
    const vote = evaluateStrategy(strategyId, complete, atr, mode, strategyContext, variant);
    if (!vote) return [];
    const weight = strategyWeights?.[strategyId] ?? 1;
    // Regime is a second, independent re-weighting stacked on top of trust:
    // trust damps a mediocre strategy, regime damps a strategy voting
    // against what the market is doing right now. Either can reduce a vote;
    // neither can zero one out. A null regime (not enough history) leaves
    // this at exactly the pre-regime behaviour.
    const regimeWeight = regime ? regimeWeightFor(vote.category, regime.regime) : 1.0;
    // Weighted votes keep their identity; strength is scaled by trust and
    // regime so neither a mediocre strategy nor a mismatched-regime one can
    // dominate the confluence average.
    return [{ ...vote, strength: vote.strength * weight * regimeWeight }];
  });
  const longVotes = votes.filter((item) => item.direction === "long");
  const shortVotes = votes.filter((item) => item.direction === "short");
  // Direction is decided by summed weighted STRENGTH, not raw vote count —
  // two strong votes should beat three weak ones, and a strength tie must
  // never default long the way a `>=` count comparison used to.
  const longStrength = longVotes.reduce((sum, item) => sum + item.strength, 0);
  const shortStrength = shortVotes.reduce((sum, item) => sum + item.strength, 0);
  const totalStrength = longStrength + shortStrength;
  const winningVotes = longStrength >= shortStrength ? longVotes : shortVotes;
  const winningStrength = winningVotes === longVotes ? longStrength : shortStrength;
  const categories = new Set(winningVotes.map((item) => item.category));

  const diagnosticsBase = {
    evaluatedStrategyIds,
    downweightedStrategyIds,
    incompatibleStrategyIds,
    catalogOnlyStrategyIds,
    votes,
  };
  if (winningVotes.length < 2 || categories.size < 2) {
    return {
      signal: null,
      diagnostics: {
        ...diagnosticsBase,
        downweightedStrategyIds,
        reason: "No signal: at least two agreeing, independent strategy votes are required.",
      },
    };
  }
  // Count alone is not conviction: neither side holds a clear enough edge in
  // weighted strength, so there is no directional edge to trade.
  if (totalStrength === 0 || winningStrength / totalStrength < DIRECTION_MARGIN) {
    return {
      signal: null,
      diagnostics: {
        ...diagnosticsBase,
        downweightedStrategyIds,
        reason: "No signal: neither side holds a clear majority of weighted vote strength.",
      },
    };
  }

  const direction = winningVotes[0].direction;
  const risk = buildRiskLevels({ pair, mode, direction, quote, candles: complete, atr });
  // Longer timeframes tolerate wider structure stops; scalps stay tight.
  const maximumRiskAtr =
    mode === "scalper" ? 4 : resolvedTimeframe === "D1" ? 8 : resolvedTimeframe === "H4" ? 6 : 5;
  if (risk.riskDistance > atr * maximumRiskAtr) {
    return {
      signal: null,
      diagnostics: {
        ...diagnosticsBase,
        downweightedStrategyIds,
        reason: `No signal: the structure stop is wider than ${maximumRiskAtr} ATR.`,
      },
    };
  }

  // Confluence counts CLUSTERS, not raw votes. Six moving averages agreeing is
  // one opinion held six ways — the old `winningVotes.length / votes.length`
  // plus `categories.size * 5` counted it as six independent confirmations and
  // is the mechanism behind uncalibrated 80%+ readings. See
  // strategy-clusters.ts for the map and the reasoning behind each group.
  //
  // Within a cluster the STRONGEST member is taken rather than the mean:
  // averaging would punish breadth inside one idea, while the old code rewarded
  // it. Neither is right — breadth within a cluster carries almost no extra
  // information, so it earns a small saturating bonus and nothing more.
  const winningRollups = rollupByCluster(winningVotes, clusterMap);
  const losingRollups = rollupByCluster(
    winningVotes === longVotes ? shortVotes : longVotes,
    clusterMap,
  );
  const clusterStrength = average(winningRollups.map((rollup) => rollup.strength));
  const clusterAgreement =
    winningRollups.length / Math.max(1, winningRollups.length + losingRollups.length);
  const baseConfluence = Math.round(
    clamp(
      clusterStrength * 0.55 +
        clusterAgreement * 25 +
        winningRollups.length * 5 +
        clusterDepthBonus(winningRollups),
      0,
      95,
    ),
  );
  // Location prices WHERE this entry sits in its own recent range: the same
  // indicator confluence at the bottom of a range and at the top of one is
  // not the same trade. A continuous multiplier, never a gate — a great
  // setup at a bad location still fires, just visibly discounted, so the
  // gates above (vote count, categories, DIRECTION_MARGIN, stop width) stay
  // the only thing that can veto a signal.
  const location = readLocation(complete, direction, atr);
  const confluence = Math.round(clamp(baseConfluence * (location?.multiplier ?? 1), 0, 95));
  const contributingStrategies = winningVotes.map((item) => item.strategyId);
  const baseRationale = `${winningVotes.length} verified ${timeframeForGating} strategy votes across ${categories.size} categories. ${direction === "long" ? "Ask" : "Bid"} entry; stop uses the widest of recent 12-candle structure, ${mode === "scalper" ? "1.6" : "1.8"} ATR, and 4× spread (${risk.basis} selected).`;
  const withLocation = location
    ? `${baseRationale} ${describeLocation(location, direction)}`
    : baseRationale;
  const rationale = regime ? `${withLocation} ${describeRegime(regime)}` : withLocation;

  return {
    signal: {
      direction,
      timeframe: timeframeForGating,
      entry: risk.entry,
      stopLoss: risk.stopLoss,
      takeProfit1: risk.takeProfit1,
      takeProfit2: risk.takeProfit2,
      atr: risk.atr,
      confluence,
      contributingStrategies,
      rationale,
      risk,
      location,
      regime,
    },
    diagnostics: {
      ...diagnosticsBase,
      reason: "Signal generated from real candle evaluations.",
    },
  };
}
