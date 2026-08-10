import test from "node:test";
import assert from "node:assert/strict";
import {
  describeRegime,
  readRegime,
  regimeWeightFor,
  type MarketRegime,
  type RegimeRead,
} from "./regime.ts";
import type { SignalEngineCandle, StrategyCategory } from "./signal-engine.ts";

// --- fixture builders --------------------------------------------------------

type Bar = { open?: number; high: number; low: number; close: number; complete?: boolean };

function buildSeries(bars: Bar[]): SignalEngineCandle[] {
  return bars.map((bar, index) => ({
    time: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
    open: bar.open ?? bar.close,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    complete: bar.complete ?? true,
  }));
}

/** A clean, near-noiseless trend: close/high/low all move by the same
 *  constant step every bar. A constant +DM/-DM/TR input hits Wilder's fixed
 *  point at the very first smoothed value (the seed IS the steady state for
 *  a constant series), so this reaches ADX's theoretical ceiling almost
 *  immediately — the cleanest possible hand-checkable case. */
function steadyTrendSeries(direction: 1 | -1, bars = 80): SignalEngineCandle[] {
  const rows: Bar[] = [];
  for (let i = 0; i < bars; i += 1) {
    const mid = 100 + direction * i;
    rows.push({ close: mid, high: mid + 0.5, low: mid - 0.5 });
  }
  return buildSeries(rows);
}

/** Two superimposed sine waves (incommensurate periods) around a fixed
 *  center: bounded, non-periodic-looking, and never trends for more than a
 *  few bars in either direction — low ADX/efficiency by construction, with
 *  the fast+slow mix keeping ATR from decaying to a flat line (which would
 *  wrongly read as contraction; see narrowingRangeSeries for that case). */
function oscillatingRangeSeries(bars = 90): SignalEngineCandle[] {
  const rows: Bar[] = [];
  for (let i = 0; i < bars; i += 1) {
    const close = 100 + Math.sin(i * 0.9) * 0.4 + Math.sin(i * 0.37) * 0.15;
    rows.push({ close, high: close + 0.1, low: close - 0.1 });
  }
  return buildSeries(rows);
}

/** A quiet base (tiny range every bar) followed by a burst of large,
 *  ALTERNATING-direction bars. Alternating direction keeps net displacement
 *  (and so ADX/efficiency) low — this is "suddenly loud", not a breakout —
 *  while the burst bars' size dominates the ATR(14) window enough to push
 *  the latest reading to the top of its own last-100 history. */
function quietThenBurstSeries(quietBars = 70, burstBars = 10): SignalEngineCandle[] {
  const rows: Bar[] = [];
  let price = 100;
  for (let i = 0; i < quietBars; i += 1) {
    const close = 100 + Math.sin(i * 0.5) * 0.05;
    rows.push({ close, high: close + 0.08, low: close - 0.08 });
    price = close;
  }
  for (let i = 0; i < burstBars; i += 1) {
    price += i % 2 === 0 ? 3 : -2.6;
    rows.push({ close: price, high: price + 1.5, low: price - 1.5 });
  }
  return buildSeries(rows);
}

/** Bar range decays exponentially from 0.6 toward ~0.02 over ~90 bars, with
 *  only a token wiggle in price (not a trend). The latest ATR ends up below
 *  virtually every prior reading in its own last-100 window. */
function narrowingRangeSeries(bars = 90): SignalEngineCandle[] {
  const rows: Bar[] = [];
  for (let i = 0; i < bars; i += 1) {
    const amplitude = Math.max(0.02, 0.6 * Math.exp(-i / 20));
    const close = 100 + (i % 2 === 0 ? amplitude : -amplitude) * 0.3;
    rows.push({ close, high: close + amplitude, low: close - amplitude });
  }
  return buildSeries(rows);
}

/** 50 flat warm-up bars (irrelevant filler, just to clear the 60-candle
 *  floor) then an exact 20-bar integer round trip: +1 ten times, -1 ten
 *  times. Integer arithmetic keeps both the direction and volatility sums
 *  exact, so efficiencyRatio lands on precisely 0, not merely close to it. */
function roundTripSeries(bars = 70): SignalEngineCandle[] {
  const rows: Bar[] = [];
  for (let i = 0; i < bars - 20; i += 1) rows.push({ close: 100, high: 100.2, low: 99.8 });
  let price = 100;
  for (let i = 0; i < 10; i += 1) {
    price += 1;
    rows.push({ close: price, high: price + 0.2, low: price - 0.2 });
  }
  for (let i = 0; i < 10; i += 1) {
    price -= 1;
    rows.push({ close: price, high: price + 0.2, low: price - 0.2 });
  }
  return buildSeries(rows);
}

/** Identical OHLC every bar: zero movement in any direction, so every DM/TR
 *  input is zero and ADX has nothing to smooth. */
function flatSeries(bars = 70): SignalEngineCandle[] {
  return buildSeries(Array.from({ length: bars }, () => ({ close: 100, high: 100.3, low: 99.7 })));
}

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A bounded random walk with wicks — plausible OHLC, never inverted (high <
 *  low) — for the atrPercentile bounds sweep. Mirrors location.test.ts's
 *  randomSeries so both modules are swept the same way. */
function randomSeries(rng: () => number, length: number): SignalEngineCandle[] {
  const rows: Bar[] = [];
  let price = 1.1 + (rng() - 0.5) * 0.05;
  for (let i = 0; i < length; i += 1) {
    const open = price;
    const drift = (rng() - 0.5) * 0.004;
    const close = Math.max(0.2, open + drift);
    const high = Math.max(open, close) + rng() * 0.0015;
    const low = Math.max(0.01, Math.min(open, close) - rng() * 0.0015);
    rows.push({ open, close, high, low });
    price = close;
  }
  return buildSeries(rows);
}

// --- classification tests ----------------------------------------------------

test("a clean, steady uptrend classifies as strong_trend, long, with efficiency above 0.4", () => {
  const read = readRegime(steadyTrendSeries(1));
  assert.ok(read);
  assert.equal(read!.regime, "strong_trend");
  assert.equal(read!.trendDirection, "long");
  assert.ok(read!.efficiencyRatio > 0.4, `expected efficiency > 0.4, got ${read!.efficiencyRatio}`);
  assert.ok(read!.adx >= 25, `expected adx >= 25, got ${read!.adx}`);
});

test("a clean downtrend classifies as strong_trend, short", () => {
  const read = readRegime(steadyTrendSeries(-1));
  assert.ok(read);
  assert.equal(read!.regime, "strong_trend");
  assert.equal(read!.trendDirection, "short");
});

test("a tight oscillating series classifies as range, with efficiency near zero and no trend direction", () => {
  const read = readRegime(oscillatingRangeSeries());
  assert.ok(read);
  assert.equal(read!.regime, "range");
  assert.equal(read!.trendDirection, null);
  assert.ok(
    read!.efficiencyRatio < 0.05,
    `expected efficiency near 0, got ${read!.efficiencyRatio}`,
  );
});

test("a quiet series followed by a sudden volatility burst classifies as expansion", () => {
  const read = readRegime(quietThenBurstSeries());
  assert.ok(read);
  assert.equal(read!.regime, "expansion");
  assert.ok(
    read!.atrPercentile >= 0.85,
    `expected atrPercentile >= 0.85, got ${read!.atrPercentile}`,
  );
});

test("a series whose range steadily narrows classifies as contraction", () => {
  const read = readRegime(narrowingRangeSeries());
  assert.ok(read);
  assert.equal(read!.regime, "contraction");
  assert.ok(
    read!.atrPercentile <= 0.2,
    `expected atrPercentile <= 0.2, got ${read!.atrPercentile}`,
  );
});

test("fewer than 60 complete candles returns null", () => {
  assert.equal(readRegime(steadyTrendSeries(1, 59)), null);
  // Sanity check the boundary the other direction, so "null" above is really
  // about the 60-candle floor and not some other property of the fixture.
  assert.ok(readRegime(steadyTrendSeries(1, 60)) !== null);
});

test("candles marked incomplete don't count toward the 60-candle floor", () => {
  const candles = steadyTrendSeries(1, 65).map((candle, index) =>
    index < 10 ? { ...candle, complete: false } : candle,
  );
  // Only 55 complete candles remain even though the array itself has 65.
  assert.equal(readRegime(candles), null);
});

test("efficiencyRatio is exactly 1 for a perfectly monotonic advance, and exactly 0 for a series that returns to where it started", () => {
  const monotonic = readRegime(steadyTrendSeries(1));
  assert.ok(monotonic);
  assert.equal(monotonic!.efficiencyRatio, 1);

  const roundTrip = readRegime(roundTripSeries());
  assert.ok(roundTrip);
  assert.equal(roundTrip!.efficiencyRatio, 0);
});

test("atrPercentile sits in [0, 1] across a seeded randomized sweep of at least 200 series", () => {
  const rng = mulberry32(20260810);
  let checked = 0;
  for (let trial = 0; trial < 250; trial += 1) {
    const length = 60 + Math.floor(rng() * 90);
    const series = randomSeries(rng, length);
    const read = readRegime(series);
    if (!read) continue;
    checked += 1;
    assert.ok(
      read.atrPercentile >= 0 && read.atrPercentile <= 1,
      `trial ${trial}: atrPercentile ${read.atrPercentile} out of [0, 1]`,
    );
    assert.ok(
      read.efficiencyRatio >= 0 && read.efficiencyRatio <= 1,
      `trial ${trial}: efficiencyRatio ${read.efficiencyRatio} out of [0, 1]`,
    );
  }
  assert.ok(
    checked >= 200,
    `expected at least 200 of 250 trials to produce a result, got ${checked}`,
  );
});

test("the ADX implementation is sane: a strong trend yields ADX above 25, a flat series yields ADX below 20", () => {
  const trending = readRegime(steadyTrendSeries(1));
  const flat = readRegime(flatSeries());
  assert.ok(trending);
  assert.ok(flat);
  assert.ok(trending!.adx > 25, `expected trending adx > 25, got ${trending!.adx}`);
  assert.ok(flat!.adx < 20, `expected flat adx < 20, got ${flat!.adx}`);
});

// --- regimeWeightFor ----------------------------------------------------------

// Transcribed directly from the spec table (not from regime.ts's own
// constant) so this validates the SHIPPED numbers, not just internal
// self-consistency.
const EXPECTED_WEIGHTS: Record<StrategyCategory, Record<MarketRegime, number>> = {
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
const CATEGORIES = Object.keys(EXPECTED_WEIGHTS) as StrategyCategory[];
const REGIMES: MarketRegime[] = ["strong_trend", "weak_trend", "range", "expansion", "contraction"];

test("regimeWeightFor matches the spec table exactly across the full category x regime cross-product, and every value is bounded in [0.65, 1.25]", () => {
  for (const category of CATEGORIES) {
    for (const regime of REGIMES) {
      const expected = EXPECTED_WEIGHTS[category][regime];
      const actual = regimeWeightFor(category, regime);
      assert.equal(
        actual,
        expected,
        `${category} x ${regime}: expected ${expected}, got ${actual}`,
      );
      assert.ok(
        actual >= 0.65 && actual <= 1.25,
        `${category} x ${regime}: weight ${actual} outside [0.65, 1.25]`,
      );
      // Damping is the design, silencing is not — this is the one invariant
      // the whole feature depends on.
      assert.notEqual(actual, 0, `${category} x ${regime}: weight must never be 0`);
    }
  }
});

test("regimeWeightFor returns 1.0 for an unknown category", () => {
  assert.equal(regimeWeightFor("nonexistent_category" as StrategyCategory, "range"), 1.0);
  assert.equal(regimeWeightFor("nonexistent_category" as StrategyCategory, "strong_trend"), 1.0);
});

// --- describeRegime ------------------------------------------------------------

test("describeRegime formats the documented one-line summary", () => {
  const read: RegimeRead = {
    regime: "strong_trend",
    adx: 31.4,
    trendDirection: "long",
    atrPercentile: 0.78,
    efficiencyRatio: 0.62,
  };
  assert.equal(describeRegime(read), "Strong trend (ADX 31, efficiency 0.62, ATR 78th pct)");
});
