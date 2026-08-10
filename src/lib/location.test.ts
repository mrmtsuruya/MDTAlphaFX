import test from "node:test";
import assert from "node:assert/strict";
import { readLocation, describeLocation, type LocationRead } from "./location.ts";
import type { SignalEngineCandle } from "./signal-engine.ts";

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

/** Rises from `low` to `high` then falls back toward `endFraction` of the
 *  range, so the latest bar can be parked anywhere inside a clean range with
 *  a real fractal swing high at the turn. */
function riseThenFallSeries(
  endFraction: number,
  { bars = 60, low = 1.0, high = 1.01 }: { bars?: number; low?: number; high?: number } = {},
): SignalEngineCandle[] {
  const rise = Math.floor(bars / 2);
  const fall = bars - rise - 1;
  const rows: Bar[] = [];
  for (let i = 0; i < rise; i += 1) {
    const close = low + ((high - low) * i) / (rise - 1);
    rows.push({ close, high: close + 0.0002, low: close - 0.0002 });
  }
  for (let i = 0; i < fall; i += 1) {
    const close = high - ((high - low) * i) / (fall - 1);
    rows.push({ close, high: close + 0.0002, low: close - 0.0002 });
  }
  const finalClose = low + (high - low) * endFraction;
  rows.push({ close: finalClose, high: finalClose + 0.0002, low: finalClose - 0.0002 });
  return buildSeries(rows);
}

/** Mirror of riseThenFallSeries: falls first, then rises back toward
 *  `endFraction` of the range — a topping-out shape with a real fractal
 *  swing low at the turn. */
function fallThenRiseSeries(
  endFraction: number,
  { bars = 60, low = 1.0, high = 1.01 }: { bars?: number; low?: number; high?: number } = {},
): SignalEngineCandle[] {
  const fall = Math.floor(bars / 2);
  const rise = bars - fall - 1;
  const rows: Bar[] = [];
  for (let i = 0; i < fall; i += 1) {
    const close = high - ((high - low) * i) / (fall - 1);
    rows.push({ close, high: close + 0.0002, low: close - 0.0002 });
  }
  for (let i = 0; i < rise; i += 1) {
    const close = low + ((high - low) * i) / (rise - 1);
    rows.push({ close, high: close + 0.0002, low: close - 0.0002 });
  }
  const finalClose = low + (high - low) * endFraction;
  rows.push({ close: finalClose, high: finalClose + 0.0002, low: finalClose - 0.0002 });
  return buildSeries(rows);
}

/** A flat run at `base` with one final bar extended `extensionAtr` ATR above
 *  it, and high pinned to that bar's own close — the window's high is then
 *  literally the current close, so swingPosition is exactly 1 regardless of
 *  how far the extension runs. Isolates meanTerm from swingPosition. */
function flatWithExtension(extensionAtr: number, atr: number, flatBars = 89): SignalEngineCandle[] {
  const base = 1.1;
  const rows: Bar[] = Array.from({ length: flatBars }, () => ({
    close: base,
    high: base,
    low: base,
  }));
  const extendedClose = base + extensionAtr * atr;
  rows.push({ close: extendedClose, high: extendedClose, low: base });
  return buildSeries(rows);
}

/** Strictly increasing highs and lows throughout — no interior bar can ever
 *  beat BOTH neighbors on both sides, so findSwingPoints reports zero
 *  pivots and there is no swing high on record above the latest close. */
function monotonicRiseSeries(bars = 60): SignalEngineCandle[] {
  const rows: Bar[] = Array.from({ length: bars }, (_, i) => {
    const close = 1.0 + i * 0.0005;
    return { close, high: close + 0.0001, low: close - 0.0001 };
  });
  return buildSeries(rows);
}

/** Places the latest close at an exact `percent` (0..100) of a 0..100 swing
 *  range via a single integer division, so swingPosition lands on the same
 *  double as the literal boundary constants in location.ts — no compounding
 *  float error to worry about at an exact 0.2/0.4/0.6/0.8 edge. */
function seriesAtSwingPercent(percent: number): SignalEngineCandle[] {
  const low = 0;
  const high = 100;
  const mid = 50;
  const rows: Bar[] = Array.from({ length: 57 }, () => ({
    close: mid,
    high: mid + 1,
    low: mid - 1,
  }));
  rows.push({ close: mid, high, low: mid }); // plants the range high
  rows.push({ close: mid, high: mid, low }); // plants the range low
  rows.push({ close: percent, high: Math.max(percent, mid), low: Math.min(percent, mid) });
  return buildSeries(rows);
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

/** A bounded random walk with wicks — plausible OHLC, never flat, never
 *  inverted (high < low), for the multiplier-bounds sweep. */
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

// --- tests --------------------------------------------------------------

test("long at the bottom of a clean range scores high, and the SAME candles score low with chasing for short (symmetry)", () => {
  const candles = riseThenFallSeries(0.05); // settles 5% up from the low
  const atr = 0.001;
  const long = readLocation(candles, "long", atr);
  const short = readLocation(candles, "short", atr);
  assert.ok(long, "expected a long read");
  assert.ok(short, "expected a short read");

  assert.ok(
    1 - long!.swingPosition > 0.85,
    `expected f near 1, got swingPosition=${long!.swingPosition}`,
  );
  assert.equal(long!.chasing, false);
  assert.ok(long!.multiplier > 1.0, `expected multiplier > 1.0, got ${long!.multiplier}`);

  // The identical candles read for the OPPOSITE direction: same market
  // geometry (same swingPosition), opposite favourability — the heart of
  // the module is that this single read serves both sides honestly.
  assert.equal(short!.swingPosition, long!.swingPosition);
  assert.ok(
    short!.swingPosition < 0.3,
    `expected a low swingPosition, got ${short!.swingPosition}`,
  );
  assert.equal(short!.chasing, true);
  assert.ok(short!.multiplier < 1.0, `expected a discounted multiplier, got ${short!.multiplier}`);
  assert.ok(
    short!.multiplier < long!.multiplier,
    "short must score lower than long on the same candles",
  );
});

test("a short at the top of a range scores high", () => {
  const candles = fallThenRiseSeries(0.95); // settles 95% up toward the high
  const atr = 0.001;
  const short = readLocation(candles, "short", atr);
  assert.ok(short);
  assert.ok(
    short!.swingPosition > 0.85,
    `expected position near the top, got ${short!.swingPosition}`,
  );
  assert.equal(short!.chasing, false);
  assert.ok(short!.multiplier > 1.0, `expected multiplier > 1.0, got ${short!.multiplier}`);
});

test("multiplier never leaves [0.6, 1.25] across a seeded randomized sweep", () => {
  const rng = mulberry32(20260810);
  let checked = 0;
  for (let trial = 0; trial < 220; trial += 1) {
    const length = 60 + Math.floor(rng() * 90);
    const series = randomSeries(rng, length);
    const direction = rng() < 0.5 ? "long" : "short";
    const atr = 0.0004 + rng() * 0.003;
    const result = readLocation(series, direction, atr);
    if (!result) continue;
    checked += 1;
    assert.ok(
      result.multiplier >= 0.6 && result.multiplier <= 1.25,
      `trial ${trial}: multiplier ${result.multiplier} out of [0.6, 1.25]`,
    );
  }
  assert.ok(checked >= 150, `expected most of 220 trials to produce a result, got ${checked}`);
});

test("price far above EMA21 on a long drags the score down via meanTerm, location held constant", () => {
  const atr = 0.001;
  const near = readLocation(flatWithExtension(0.5, atr), "long", atr);
  const far = readLocation(flatWithExtension(5, atr), "long", atr);
  assert.ok(near && far);
  // Both series peg swingPosition to exactly 1 (high === the extended bar's
  // own close) and find no swing points at all, so headroomTerm is neutral
  // in both — isolating the difference to distance from the mean.
  assert.equal(near!.swingPosition, far!.swingPosition);
  assert.equal(near!.headroomAtr, null);
  assert.equal(far!.headroomAtr, null);
  assert.ok(near!.meanDistanceAtr < far!.meanDistanceAtr);
  assert.ok(
    near!.score > far!.score,
    `expected near-EMA score (${near!.score}) > far-EMA score (${far!.score})`,
  );
});

test("headroomAtr is null with no swing high on record above price, contributing the neutral 0.5", () => {
  const atr = 0.002;
  const result = readLocation(monotonicRiseSeries(), "long", atr);
  assert.ok(result);
  assert.equal(result!.headroomAtr, null);

  // Recompute the composite from the module's own formula using the
  // returned raw fields, forcing headroomTerm to the documented neutral
  // 0.5 — proves the null case contributes exactly that, not 0 or 1.
  const f = 1 - result!.swingPosition;
  const adverse = Math.max(0, result!.meanDistanceAtr);
  const meanTerm = Math.min(1, Math.max(0, 1 - adverse / 3));
  const expected = Math.round((0.55 * f + 0.25 * meanTerm + 0.2 * 0.5) * 1000) / 1000;
  assert.ok(
    Math.abs(result!.score - expected) < 0.003,
    `expected score ~${expected} (headroomTerm=0.5), got ${result!.score}`,
  );
});

test("fewer than lookback complete candles returns null", () => {
  const candles = riseThenFallSeries(0.5, { bars: 40 });
  assert.equal(readLocation(candles, "long", 0.001), null);
});

test("candles marked incomplete don't count toward the lookback", () => {
  const candles = riseThenFallSeries(0.5, { bars: 60 }).map((candle, index) =>
    index < 5 ? { ...candle, complete: false } : candle,
  );
  // Only 55 complete candles remain — short of the default 60 lookback even
  // though the array itself has 60 entries.
  assert.equal(readLocation(candles, "long", 0.001), null);
});

test("a dead-flat window (zero swing range) returns null", () => {
  const flat = buildSeries(Array.from({ length: 60 }, () => ({ close: 1.2, high: 1.2, low: 1.2 })));
  assert.equal(readLocation(flat, "long", 0.001), null);
  assert.equal(readLocation(flat, "short", 0.001), null);
});

test("labels map correctly at each documented boundary", () => {
  const atr = 1;
  const cases: [number, LocationRead["label"]][] = [
    [0, "deep discount"],
    [20, "deep discount"],
    [40, "discount"],
    [50, "equilibrium"],
    [60, "premium"], // < 0.6 is required for "equilibrium"; exactly 0.6 falls to premium
    [70, "premium"],
    [80, "extended premium"], // < 0.8 is required for "premium"; exactly 0.8 falls to extended
    [100, "extended premium"],
  ];
  for (const [percent, label] of cases) {
    const result = readLocation(seriesAtSwingPercent(percent), "long", atr);
    assert.ok(result, `expected a result at ${percent}%`);
    assert.equal(
      result!.label,
      label,
      `${percent}% should be "${label}", got "${result!.label}" (swingPosition=${result!.swingPosition})`,
    );
  }
});

test("describeLocation matches the documented sentence format, mentioning chasing only when true", () => {
  const chasingRead: LocationRead = {
    swingPosition: 0.81,
    meanDistanceAtr: 1.2,
    headroomAtr: 0.4,
    score: 0.5,
    multiplier: 0.925,
    label: "extended premium",
    chasing: true,
    swing: { highIndex: 10, highPrice: 1.1, lowIndex: 0, lowPrice: 1.0 },
  };
  assert.equal(
    describeLocation(chasingRead, "long"),
    "LONG at 0.81 of the swing range (extended premium) — chasing extension, 0.4 ATR of headroom.",
  );

  const goodRead: LocationRead = {
    ...chasingRead,
    swingPosition: 0.24,
    label: "discount",
    chasing: false,
    headroomAtr: 2.8,
  };
  assert.equal(
    describeLocation(goodRead, "long"),
    "LONG at 0.24 of the swing range (discount) — 2.8 ATR of headroom.",
  );
});

test("describeLocation reports unclear headroom when null", () => {
  const read: LocationRead = {
    swingPosition: 0.5,
    meanDistanceAtr: 0,
    headroomAtr: null,
    score: 0.5,
    multiplier: 0.925,
    label: "equilibrium",
    chasing: false,
    swing: { highIndex: 10, highPrice: 1.1, lowIndex: 0, lowPrice: 1.0 },
  };
  assert.match(
    describeLocation(read, "short"),
    /^SHORT at 0\.50 of the swing range \(equilibrium\) — headroom unclear/,
  );
});
