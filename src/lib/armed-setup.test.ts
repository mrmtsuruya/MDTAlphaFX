import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArmedSetup,
  buildArmedContext,
  describeArmedSetup,
  type ArmedSetup,
} from "./armed-setup.ts";
import { findSwingPoints, type SignalEngineCandle } from "./signal-engine.ts";
import type { MarketRegime, RegimeRead } from "./regime.ts";
import type { LocationRead } from "./location.ts";

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

/** Chained rise/fall legs through each pivot in turn, so interior pivots
 *  land as real fractal swing highs/lows (same construction as
 *  location.test.ts's riseThenFallSeries, just repeated leg over leg). The
 *  final bar sits at the last pivot, which the tests below deliberately
 *  place between the outer highs and lows so both a swing high above and a
 *  swing low below the final close exist on the very same series. */
function zigzagSeries(pivots: number[], perLeg = 8): SignalEngineCandle[] {
  const rows: Bar[] = [];
  for (let leg = 0; leg < pivots.length - 1; leg += 1) {
    const from = pivots[leg];
    const to = pivots[leg + 1];
    for (let i = 0; i < perLeg; i += 1) {
      const close = from + ((to - from) * i) / perLeg;
      rows.push({ close, high: close + 0.1, low: close - 0.1 });
    }
  }
  const last = pivots.at(-1)!;
  rows.push({ close: last, high: last + 0.1, low: last - 0.1 });
  return buildSeries(rows);
}

/** Two peaks (106, 110) and two troughs (96, 94) around a close that ends
 *  at 101 — comfortably below both peaks and above both troughs, so a long
 *  trigger has two candidate swing highs to choose the nearer of, and a
 *  short trigger has two candidate swing lows to choose the nearer of. */
function candlesWithSwingsOnBothSides(): SignalEngineCandle[] {
  return zigzagSeries([100, 106, 96, 110, 94, 101]);
}

/** Strictly increasing highs and lows throughout — no interior bar can ever
 *  beat BOTH neighbors on both sides, so findSwingPoints reports zero
 *  pivots (same reasoning as location.test.ts's monotonicRiseSeries). */
function monotonicRiseCandles(bars = 60): SignalEngineCandle[] {
  const rows: Bar[] = Array.from({ length: bars }, (_, i) => {
    const close = 1.0 + i * 0.001;
    return { close, high: close + 0.0002, low: close - 0.0002 };
  });
  return buildSeries(rows);
}

/** One bar early in the series (well outside any 60-bar tail window) dips
 *  to an extreme low; the remaining 80 bars oscillate in a moderate band.
 *  90 bars total means the last 60 are entirely inside the moderate band,
 *  so a correct implementation must never see the early extreme. */
function extremeThenModerateCandles(): SignalEngineCandle[] {
  const rows: Bar[] = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push({ close: 100, high: 100.2, low: i === 5 ? 50 : 99.8 });
  }
  for (let i = 0; i < 80; i += 1) {
    const close = 100 + Math.sin(i * 0.3) * 3;
    rows.push({ close, high: close + 0.5, low: close - 0.5 });
  }
  return buildSeries(rows);
}

/** A clean, near-noiseless trend — same construction as regime.test.ts's own
 *  steadyTrendSeries, reproduced locally rather than imported (each test
 *  file owns its fixtures the same way regime.test.ts / location.test.ts
 *  do): reaches strong_trend almost immediately, direction set by the sign. */
function steadyTrendCandles(direction: 1 | -1, bars = 80): SignalEngineCandle[] {
  const rows: Bar[] = [];
  for (let i = 0; i < bars; i += 1) {
    const mid = 100 + direction * i;
    rows.push({ close: mid, high: mid + 0.5, low: mid - 0.5 });
  }
  return buildSeries(rows);
}

/** Bounded, non-trending oscillation — same construction as regime.test.ts's
 *  own oscillatingRangeSeries: low ADX/efficiency by construction, so this
 *  classifies as a range regime with no trend direction either way. */
function oscillatingRangeCandles(bars = 90): SignalEngineCandle[] {
  const rows: Bar[] = [];
  for (let i = 0; i < bars; i += 1) {
    const close = 100 + Math.sin(i * 0.9) * 0.4 + Math.sin(i * 0.37) * 0.15;
    rows.push({ close, high: close + 0.1, low: close - 0.1 });
  }
  return buildSeries(rows);
}

function regimeFixture(overrides: Partial<RegimeRead> = {}): RegimeRead {
  return {
    regime: "strong_trend",
    adx: 30,
    trendDirection: "long",
    atrPercentile: 0.5,
    efficiencyRatio: 0.5,
    ...overrides,
  };
}

function locationFixture(overrides: Partial<LocationRead> = {}): LocationRead {
  return {
    swingPosition: 0.4,
    meanDistanceAtr: 0,
    headroomAtr: null,
    score: 0.7,
    multiplier: 1.05,
    label: "discount",
    chasing: false,
    swing: { highIndex: 10, highPrice: 1.1, lowIndex: 0, lowPrice: 1.0 },
    ...overrides,
  };
}

const genericCandles = candlesWithSwingsOnBothSides();

// --- tests: conditions ----------------------------------------------------

test("all five conditions met", () => {
  const setup = buildArmedSetup({
    candles: genericCandles,
    direction: "long",
    atr: 0.5,
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: locationFixture({ chasing: false }),
    mtf: { confirmed: "long", alignment: 0.8 },
    votes: [
      { direction: "long", category: "trend" },
      { direction: "long", category: "momentum" },
    ],
  });
  assert.ok(setup);
  assert.equal(setup!.metCount, 5);
  assert.equal(setup!.totalCount, 5);
  assert.ok(setup!.conditions.every((condition) => condition.met));
});

test("absent mtf yields an unevaluated, unmet condition", () => {
  const setup = buildArmedSetup({
    candles: genericCandles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [],
  });
  assert.ok(setup);
  assert.equal(setup!.conditions[0].label, "Higher-timeframe tide (not evaluated)");
  assert.equal(setup!.conditions[0].met, false);

  // Explicit null reads the same as omitted entirely.
  const withExplicitNull = buildArmedSetup({
    candles: genericCandles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    mtf: null,
    votes: [],
  });
  assert.equal(withExplicitNull!.conditions[0].label, "Higher-timeframe tide (not evaluated)");
  assert.equal(withExplicitNull!.conditions[0].met, false);
});

test("mtf present but not confirming this direction is evaluated and unmet, with the ordinary label", () => {
  const setup = buildArmedSetup({
    candles: genericCandles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    mtf: { confirmed: "short", alignment: 0.6 },
    votes: [],
  });
  assert.ok(setup);
  assert.equal(setup!.conditions[0].label, "Higher-timeframe tide agrees");
  assert.equal(setup!.conditions[0].met, false);
});

test("location.chasing === true fails the location condition", () => {
  const setup = buildArmedSetup({
    candles: genericCandles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: locationFixture({ chasing: true }),
    votes: [],
  });
  assert.ok(setup);
  assert.equal(setup!.conditions[2].label, "Price at a favourable location");
  assert.equal(setup!.conditions[2].met, false);
});

test("one agreeing vote leaves both vote conditions unmet", () => {
  const setup = buildArmedSetup({
    candles: genericCandles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [{ direction: "long", category: "trend" }],
  });
  assert.ok(setup);
  assert.equal(setup!.conditions[3].met, false);
  assert.equal(setup!.conditions[4].met, false);
});

test("two agreeing votes in the same category satisfy the count but not the category spread", () => {
  const setup = buildArmedSetup({
    candles: genericCandles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [
      { direction: "long", category: "trend" },
      { direction: "long", category: "trend" },
      { direction: "short", category: "momentum" }, // disagreeing vote must not count either way
    ],
  });
  assert.ok(setup);
  assert.equal(setup!.conditions[3].met, true);
  assert.equal(setup!.conditions[4].met, false);
});

test("regime condition: range regime supports either direction; a matching trend also supports", () => {
  const rangeSetup = buildArmedSetup({
    candles: genericCandles,
    direction: "short",
    atr: 0.5,
    regime: regimeFixture({ regime: "range", trendDirection: null }),
    location: null,
    votes: [],
  });
  assert.equal(rangeSetup!.conditions[1].met, true);

  const mismatchedTrend = buildArmedSetup({
    candles: genericCandles,
    direction: "short",
    atr: 0.5,
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: null,
    votes: [],
  });
  assert.equal(mismatchedTrend!.conditions[1].met, false);
});

// --- tests: trigger / invalidation -----------------------------------------

test("trigger sits above the close for a long and below it for a short, both real swing points", () => {
  const candles = candlesWithSwingsOnBothSides();
  const complete = candles.filter((candle) => candle.complete);
  const close = complete.at(-1)!.close;
  const swings = findSwingPoints(complete, 2);

  const above = swings.filter((swing) => swing.kind === "high" && swing.price > close);
  const below = swings.filter((swing) => swing.kind === "low" && swing.price < close);
  assert.ok(
    above.length >= 2,
    "fixture must offer at least two candidate swing highs above the close",
  );
  assert.ok(
    below.length >= 2,
    "fixture must offer at least two candidate swing lows below the close",
  );
  const expectedLongTrigger = Math.min(...above.map((swing) => swing.price));
  const expectedShortTrigger = Math.max(...below.map((swing) => swing.price));

  const longSetup = buildArmedSetup({
    candles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [],
  });
  assert.ok(longSetup?.trigger);
  assert.equal(longSetup!.trigger!.price, expectedLongTrigger);
  assert.ok(longSetup!.trigger!.price > close);
  assert.equal(longSetup!.trigger!.description, `close above ${expectedLongTrigger.toFixed(5)}`);

  const shortSetup = buildArmedSetup({
    candles,
    direction: "short",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [],
  });
  assert.ok(shortSetup?.trigger);
  assert.equal(shortSetup!.trigger!.price, expectedShortTrigger);
  assert.ok(shortSetup!.trigger!.price < close);
  assert.equal(shortSetup!.trigger!.description, `close below ${expectedShortTrigger.toFixed(5)}`);
});

test("no qualifying swing level leaves trigger null, and the setup is still returned", () => {
  const candles = monotonicRiseCandles();
  const setup = buildArmedSetup({
    candles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [],
  });
  assert.ok(setup, "a null trigger must not prevent a setup from being returned");
  assert.equal(setup!.trigger, null);
});

test("invalidation reads only the last 60 bars, never an older extreme outside that window", () => {
  const candles = extremeThenModerateCandles();
  const complete = candles.filter((candle) => candle.complete);
  const expectedLow = Math.min(...complete.slice(-60).map((candle) => candle.low));

  const setup = buildArmedSetup({
    candles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [],
  });
  assert.ok(setup);
  assert.equal(setup!.invalidation!.price, expectedLow);
  assert.ok(
    setup!.invalidation!.price > 90,
    "must not pick up the older extreme low (50) outside the 60-bar window",
  );
  assert.equal(setup!.invalidation!.description, `close below ${expectedLow.toFixed(5)}`);

  const expectedHigh = Math.max(...complete.slice(-60).map((candle) => candle.high));
  const shortSetup = buildArmedSetup({
    candles,
    direction: "short",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [],
  });
  assert.equal(shortSetup!.invalidation!.price, expectedHigh);
  assert.equal(shortSetup!.invalidation!.description, `close above ${expectedHigh.toFixed(5)}`);
});

// --- tests: expiresInBars / candle floor ------------------------------------

test("expiresInBars maps from the regime, and falls back to 8 for a null regime", () => {
  const cases: [MarketRegime | null, number][] = [
    ["strong_trend", 12],
    ["weak_trend", 10],
    ["range", 6],
    ["expansion", 4],
    ["contraction", 8],
    [null, 8],
  ];
  for (const [marketRegime, expected] of cases) {
    const regime = marketRegime ? regimeFixture({ regime: marketRegime }) : null;
    const setup = buildArmedSetup({
      candles: genericCandles,
      direction: "long",
      atr: 0.5,
      regime,
      location: null,
      votes: [],
    });
    assert.equal(setup!.expiresInBars, expected, `regime=${marketRegime}`);
  }
});

test("fewer than 30 complete candles returns null", () => {
  const candles = buildSeries(
    Array.from({ length: 25 }, () => ({ close: 100, high: 100.2, low: 99.8 })),
  );
  const setup = buildArmedSetup({
    candles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [],
  });
  assert.equal(setup, null);
});

test("incomplete candles don't count toward the 30-candle floor", () => {
  const candles = buildSeries(
    Array.from({ length: 35 }, () => ({ close: 100, high: 100.2, low: 99.8 })),
  ).map((candle, index) => (index < 10 ? { ...candle, complete: false } : candle));
  // Only 25 complete candles remain — short of the 30 floor even though the
  // array itself has 35 entries.
  const setup = buildArmedSetup({
    candles,
    direction: "long",
    atr: 0.5,
    regime: null,
    location: null,
    votes: [],
  });
  assert.equal(setup, null);
});

// --- tests: describeArmedSetup ----------------------------------------------

test("describeArmedSetup renders the documented block format", () => {
  const setup: ArmedSetup = {
    direction: "long",
    conditions: [
      { label: "Higher-timeframe tide agrees", met: true },
      { label: "Regime supports the direction", met: true },
      { label: "Price at a favourable location", met: true },
      { label: "At least two agreeing strategy votes", met: false },
      { label: "At least two independent categories", met: false },
    ],
    metCount: 3,
    totalCount: 5,
    trigger: { price: 4358.2, description: "close above 4358.20000" },
    invalidation: { price: 4331.0, description: "close below 4331.00000" },
    expiresInBars: 12,
  };
  const text = describeArmedSetup(setup, "XAUUSD", "H1");
  const lines = text.split("\n");
  assert.equal(lines[0], "XAUUSD · H1 · LONG · ARMED — 3 of 5 conditions met");
  assert.equal(lines[1], "  [x] Higher-timeframe tide agrees");
  assert.equal(lines[2], "  [x] Regime supports the direction");
  assert.equal(lines[3], "  [x] Price at a favourable location");
  assert.equal(lines[4], "  [ ] At least two agreeing strategy votes");
  assert.equal(lines[5], "  [ ] At least two independent categories");
  assert.equal(lines[6], "  Trigger: close above 4358.20000");
  assert.equal(lines[7], "  Invalidates: close below 4331.00000");
  assert.equal(lines[8], "  Expires in 12 bars");
  assert.equal(lines.length, 9);
  assert.ok(
    !text.includes("\u{1F7E2}") && !/\p{Emoji_Presentation}/u.test(text),
    "no emoji in the block",
  );
});

test("describeArmedSetup handles a null trigger without breaking the block", () => {
  const setup: ArmedSetup = {
    direction: "short",
    conditions: [{ label: "Higher-timeframe tide (not evaluated)", met: false }],
    metCount: 0,
    totalCount: 1,
    trigger: null,
    invalidation: { price: 1.2345, description: "close above 1.23450" },
    expiresInBars: 6,
  };
  const text = describeArmedSetup(setup, "EURUSD", "M15");
  assert.match(text, /^EURUSD · M15 · SHORT · ARMED — 0 of 1 conditions met$/m);
  assert.ok(text.includes("Trigger:"));
  assert.ok(text.includes("Invalidates: close above 1.23450"));
  assert.ok(text.includes("Expires in 6 bars"));
});

// --- tests: buildArmedContext ------------------------------------------

test("buildArmedContext infers direction from regime.trendDirection when the trend is clear", () => {
  const context = buildArmedContext({
    candles: steadyTrendCandles(1),
    // A vote majority pointing the OTHER way — the regime's own trend read
    // must still win over it.
    votes: [
      { direction: "short", category: "trend" },
      { direction: "short", category: "momentum" },
    ],
  });
  assert.equal(context.direction, "long");
  assert.ok(context.armed, "enough candles and a clear direction should produce an armed setup");
  assert.equal(context.armed!.direction, "long");
  assert.equal(context.mode.bias, "long");
});

test("buildArmedContext infers direction from vote majority when the regime has no trend direction", () => {
  const context = buildArmedContext({
    candles: oscillatingRangeCandles(),
    votes: [
      { direction: "long", category: "trend" },
      { direction: "long", category: "momentum" },
      { direction: "short", category: "sr" },
    ],
  });
  assert.equal(context.direction, "long");
  assert.ok(context.armed, "enough candles and a clear direction should produce an armed setup");
  assert.equal(context.armed!.direction, "long");
});

test("an exact vote tie with no trend direction leaves nothing to infer, but the mode still resolves", () => {
  const context = buildArmedContext({
    candles: oscillatingRangeCandles(),
    votes: [
      { direction: "long", category: "trend" },
      { direction: "short", category: "momentum" },
    ],
  });
  assert.equal(context.direction, null);
  assert.equal(context.armed, null);
  // Range regime, no tide either way — rule 3 of arbitrateMode: the mode
  // still resolves to a real verdict rather than leaving the caller with
  // nothing just because there was no direction to arm.
  assert.equal(context.mode.verdict, "scalp");
  assert.equal(context.mode.bias, null);
  assert.ok(context.mode.reason.length > 0);
});

test("a too-short candle series leaves armed null but the mode still resolves", () => {
  const candles = buildSeries(
    Array.from({ length: 25 }, () => ({ close: 100, high: 100.2, low: 99.8 })),
  );
  const context = buildArmedContext({
    candles,
    votes: [
      { direction: "long", category: "trend" },
      { direction: "long", category: "momentum" },
      { direction: "short", category: "sr" },
    ],
  });
  // Vote majority still resolves a direction (regime needs 60 candles and
  // this series only has 25, so it reads null and falls through to votes).
  assert.equal(context.direction, "long");
  // 25 complete candles is short of buildArmedSetup's own 30-candle floor.
  assert.equal(context.armed, null);
  // No regime read at all (< 60 candles) — arbitrateMode's rule 2.
  assert.equal(context.mode.verdict, "stand_down");
  assert.ok(context.mode.reason.length > 0);
});

test("a pending High-impact release stands the mode down even when a healthy armed setup exists", () => {
  const context = buildArmedContext({
    candles: steadyTrendCandles(1),
    votes: [
      { direction: "long", category: "trend" },
      { direction: "long", category: "momentum" },
    ],
    mtf: { confirmed: "long", alignment: 0.8 },
    minutesToHighImpact: 5,
  });
  assert.equal(context.direction, "long");
  assert.ok(context.armed, "a clean trend with agreeing votes should still produce an armed setup");
  assert.ok(
    context.armed!.metCount >= 3,
    `expected a healthy armed setup, got ${context.armed!.metCount} of ${context.armed!.totalCount} conditions met`,
  );
  // The armed setup is healthy on its own terms, but a release 5 minutes out
  // overrides it — mode and armed are independent facts, and the release
  // must win regardless of how clean the setup underneath it looks.
  assert.equal(context.mode.verdict, "stand_down");
  assert.ok(context.mode.reason.includes("5 minute"));
});
