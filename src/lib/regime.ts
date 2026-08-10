// Regime classification: what the market is doing RIGHT NOW, independent of
// which strategy is asking. Strategies today are gated only by which
// timeframes they are meaningful on — a mean-reversion strategy votes at full
// strength in the middle of a strong trend, and a trend-follower votes at
// full strength inside a dead range. A professional lets the regime decide
// which tools are even relevant; this module is that read.
//
// A RE-WEIGHTING, never a filter — every entry in REGIME_WEIGHTS below sits
// in [0.65, 1.25] and can never reach zero. A mean-reversion vote in a strong
// trend is damped, not silenced, for the same reason location.ts never gates
// on where price sits in its range: the rare case where the "wrong" tool
// fires anyway should stay visible, just discounted, not hidden.
//
// Client-safe: no server imports, no I/O. Imported by signal-engine.ts, so
// this uses a relative "./"-prefixed import with an explicit .ts extension —
// same reason location.ts does: this module is exercised under `node --test`,
// which resolves neither the "@/" alias nor extensionless imports. Circular
// with signal-engine.ts (which imports back from here) the same safe way
// location.ts is: every name crossing the boundary is a hoisted
// function/type declaration, never a value read at module-evaluation time.
import {
  atrSeries,
  clamp,
  type SignalEngineCandle,
  type StrategyCategory,
} from "./signal-engine.ts";

export type MarketRegime = "strong_trend" | "weak_trend" | "range" | "expansion" | "contraction";

export type RegimeRead = {
  regime: MarketRegime;
  /** Wilder ADX(14) on the latest bar. */
  adx: number;
  /** Trend direction from DI+ vs DI-; null when the regime is not a trend. */
  trendDirection: "long" | "short" | null;
  /** Current ATR's percentile rank within its own last 100 values, 0..1. */
  atrPercentile: number;
  /** Kaufman efficiency ratio over 20 bars, 0..1. Directional move / path length. */
  efficiencyRatio: number;
};

const ADX_PERIOD = 14;
const EFFICIENCY_PERIOD = 20;
const ATR_PERCENTILE_WINDOW = 100;
const MIN_CANDLES = 60;

// Mirrors atrSeries' private trueRange in signal-engine.ts exactly. That
// helper isn't exported, so ADX (which needs the same per-bar true range
// atrSeries computes internally) duplicates the three-line formula rather
// than widening signal-engine's public surface for it.
function trueRange(current: SignalEngineCandle, previous: SignalEngineCandle): number {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previous.close),
    Math.abs(current.low - previous.close),
  );
}

// Wilder's own smoothing, in the "running sum" form he originally published:
// seed on the sum of the first `period` raw values, then bleed 1/period of
// the running total each step and replace it with the new raw value. This is
// proportional to the "running average" form atrSeries uses elsewhere (sum =
// period * average at every step, seed included) — but +DI/-DI below are
// RATIOS of two series smoothed this same way, so that constant factor
// cancels and only the shared form matters. Written out literally here so
// ADX matches the textbook definition on its own, rather than leaning on
// atrSeries' differently-scaled internals.
function wilderSum(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0);
  const result = [seed];
  for (let index = period; index < values.length; index += 1) {
    const prior = result[result.length - 1];
    result.push(prior - prior / period + values[index]);
  }
  return result;
}

// The DX -> ADX step is Wilder's OTHER smoothing convention: a running
// average (seeded on the simple mean, not the sum). Kept distinct from
// wilderSum above rather than unified, because that is how Wilder actually
// defined it and how every reference implementation checks it.
function wilderAverage(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const result = [seed];
  for (let index = period; index < values.length; index += 1) {
    const prior = result[result.length - 1];
    result.push((prior * (period - 1) + values[index]) / period);
  }
  return result;
}

/** Wilder ADX(14), +DI and -DI on the latest bar of `candles`. */
function computeAdx(candles: SignalEngineCandle[]): {
  adx: number;
  plusDi: number;
  minusDi: number;
} {
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const tr: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const upMove = candles[index].high - candles[index - 1].high;
    const downMove = candles[index - 1].low - candles[index].low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(trueRange(candles[index], candles[index - 1]));
  }

  const smoothedPlusDm = wilderSum(plusDm, ADX_PERIOD);
  const smoothedMinusDm = wilderSum(minusDm, ADX_PERIOD);
  const smoothedTr = wilderSum(tr, ADX_PERIOD);

  const dx: number[] = [];
  const plusDiSeries: number[] = [];
  const minusDiSeries: number[] = [];
  for (let index = 0; index < smoothedTr.length; index += 1) {
    const trValue = smoothedTr[index];
    const plusDi = trValue === 0 ? 0 : (100 * smoothedPlusDm[index]) / trValue;
    const minusDi = trValue === 0 ? 0 : (100 * smoothedMinusDm[index]) / trValue;
    plusDiSeries.push(plusDi);
    minusDiSeries.push(minusDi);
    const diSum = plusDi + minusDi;
    dx.push(diSum === 0 ? 0 : (100 * Math.abs(plusDi - minusDi)) / diSum);
  }

  const adxSeries = wilderAverage(dx, ADX_PERIOD);
  return {
    adx: adxSeries.at(-1) ?? 0,
    plusDi: plusDiSeries.at(-1) ?? 0,
    minusDi: minusDiSeries.at(-1) ?? 0,
  };
}

/** Kaufman efficiency ratio over the last 20 bars: net directional move over
 *  total path length travelled to get there. 1 = a straight line, 0 = price
 *  went nowhere net of its own back-and-forth. */
function computeEfficiencyRatio(candles: SignalEngineCandle[]): number {
  const closes = candles.map((candle) => candle.close);
  const last = closes.length - 1;
  const direction = Math.abs(closes[last] - closes[last - EFFICIENCY_PERIOD]);
  let volatility = 0;
  for (let index = last - EFFICIENCY_PERIOD + 1; index <= last; index += 1) {
    volatility += Math.abs(closes[index] - closes[index - 1]);
  }
  return clamp(volatility === 0 ? 0 : direction / volatility, 0, 1);
}

/** Where the latest ATR(14) ranks against its own last 100 readings, 0..1 —
 *  a relative "is this instrument loud or quiet right now", since a raw ATR
 *  number means nothing without the pair's own recent scale to compare it to. */
function computeAtrPercentile(candles: SignalEngineCandle[]): number {
  const window = atrSeries(candles, 14)
    .filter((value): value is number => typeof value === "number")
    .slice(-ATR_PERCENTILE_WINDOW);
  if (window.length === 0) return 0;
  const latest = window.at(-1)!;
  const below = window.filter((value) => value < latest).length;
  return below / window.length;
}

/**
 * Classifies the market `candles` are currently in. Returns null when there
 * are fewer than 60 complete candles — ADX/efficiency need real warmup, not
 * just the bare minimum that avoids a division by zero.
 */
export function readRegime(candles: SignalEngineCandle[]): RegimeRead | null {
  const complete = candles.filter((candle) => candle.complete);
  if (complete.length < MIN_CANDLES) return null;

  const { adx, plusDi, minusDi } = computeAdx(complete);
  const efficiencyRatio = computeEfficiencyRatio(complete);
  const atrPercentile = computeAtrPercentile(complete);
  const rawTrendDirection: "long" | "short" | null =
    plusDi === minusDi ? null : plusDi > minusDi ? "long" : "short";

  // Trend checks run FIRST, deliberately. adx/efficiencyRatio measure
  // directional persistence; atrPercentile only measures how big bars are
  // right now, which says nothing about whether they're all pulling the same
  // way. A trend that is currently also expanding — a breakout accelerating
  // a move already in progress — is still, first and foremost, a trend:
  // reordering this so volatility wins would reclassify the strongest,
  // most tradeable trends as "expansion" at the exact moment they
  // accelerate, which is backwards from what this module exists to do.
  let regime: MarketRegime;
  if (adx >= 25 && efficiencyRatio >= 0.4) regime = "strong_trend";
  else if (adx >= 20 && efficiencyRatio >= 0.25) regime = "weak_trend";
  else if (atrPercentile >= 0.85) regime = "expansion";
  else if (atrPercentile <= 0.2) regime = "contraction";
  else regime = "range";

  const isTrend = regime === "strong_trend" || regime === "weak_trend";
  return {
    regime,
    adx,
    trendDirection: isTrend ? rawTrendDirection : null,
    atrPercentile,
    efficiencyRatio,
  };
}

// Every value below is a PRIOR — a reasonable hand-set starting point — not a
// measurement; none of it has been fit to the resolved-trade record yet. P4
// (learned strategy weighting, the same shape signal-learning.ts /
// strategy-weights.ts already apply to trust) replaces this table with
// values derived from how each category actually performed per regime once
// there is enough resolved history to ask that question honestly.
//
// Every value sits in [0.65, 1.25]: a re-weighting, never a filter. Even the
// most mismatched pairing (mean_reversion inside a strong trend) still votes
// at 65% strength, not 0 — the rare case where the "wrong" tool fires anyway
// should stay visible, just discounted, the same reasoning location.ts
// applies to its own confluence multiplier.
const REGIME_WEIGHTS: Record<StrategyCategory, Record<MarketRegime, number>> = {
  trend: { strong_trend: 1.2, weak_trend: 1.1, range: 0.7, expansion: 1.0, contraction: 0.8 },
  momentum: {
    strong_trend: 1.1,
    weak_trend: 1.05,
    range: 0.85,
    expansion: 1.05,
    contraction: 0.85,
  },
  mean_reversion: {
    strong_trend: 0.65,
    weak_trend: 0.85,
    range: 1.25,
    expansion: 0.75,
    contraction: 1.1,
  },
  breakout: { strong_trend: 1.05, weak_trend: 1.0, range: 0.85, expansion: 1.2, contraction: 1.15 },
  volatility: {
    strong_trend: 1.0,
    weak_trend: 1.0,
    range: 0.95,
    expansion: 1.15,
    contraction: 0.85,
  },
  orderflow: { strong_trend: 1.0, weak_trend: 1.0, range: 1.1, expansion: 1.05, contraction: 0.95 },
  sr: { strong_trend: 0.9, weak_trend: 1.0, range: 1.15, expansion: 0.9, contraction: 1.05 },
  session: { strong_trend: 1.0, weak_trend: 1.0, range: 1.0, expansion: 1.0, contraction: 1.0 },
  harmonic: {
    strong_trend: 0.85,
    weak_trend: 0.95,
    range: 1.15,
    expansion: 0.85,
    contraction: 1.05,
  },
  ai: { strong_trend: 1.0, weak_trend: 1.0, range: 1.0, expansion: 1.0, contraction: 1.0 },
};

/** Unknown category (should never happen from the live catalog) reads as
 *  neutral rather than throwing — a re-weighting layer should never be the
 *  reason a scan crashes. */
export function regimeWeightFor(category: StrategyCategory, regime: MarketRegime): number {
  return REGIME_WEIGHTS[category]?.[regime] ?? 1.0;
}

const REGIME_LABELS: Record<MarketRegime, string> = {
  strong_trend: "Strong trend",
  weak_trend: "Weak trend",
  range: "Range",
  expansion: "Expansion",
  contraction: "Contraction",
};

/** One-line summary for signal cards / rationale text. */
export function describeRegime(read: RegimeRead): string {
  const percentile = Math.round(read.atrPercentile * 100);
  return `${REGIME_LABELS[read.regime]} (ADX ${Math.round(read.adx)}, efficiency ${read.efficiencyRatio.toFixed(2)}, ATR ${percentile}th pct)`;
}
