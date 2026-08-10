import test from "node:test";
import assert from "node:assert/strict";
import { buildOverlays, buildLocationOverlay, type OverlayCandle } from "./chart-overlays.ts";
import { ALL_ENGINE_STRATEGY_IDS } from "./strategy-weights.ts";

/** A deterministic uptrend with enough range for ATR-based patterns to exist. */
function candles(count = 200): OverlayCandle[] {
  const out: OverlayCandle[] = [];
  let price = 3300;
  for (let i = 0; i < count; i += 1) {
    // Repeating saw so highs/lows form real swings rather than a straight line.
    const drift = Math.sin(i / 7) * 6 + i * 0.05;
    const open = price;
    const close = 3300 + drift;
    const high = Math.max(open, close) + 1.5;
    const low = Math.min(open, close) - 1.5;
    out.push({ time: 1_700_000_000 + i * 60, open, high, low, close, volume: 100 + (i % 13) });
    price = close;
  }
  return out;
}

test("draws nothing when no strategy voted", () => {
  const overlays = buildOverlays(candles(), [], "long");
  assert.equal(overlays.lines.length, 0);
  assert.equal(overlays.levels.length, 0);
  assert.equal(overlays.zones.length, 0);
  assert.equal(overlays.drawn.length, 0);
});

test("draws nothing when there are too few candles", () => {
  const overlays = buildOverlays(candles(10), ["ema_trend"], "long");
  assert.equal(overlays.lines.length, 0);
});

test("only voted strategies produce overlays", () => {
  const overlays = buildOverlays(candles(), ["ema_trend"], "long");
  const ids = overlays.lines.map((line) => line.id);
  assert.deepEqual(ids, ["ema_21", "ema_55"]);
  // ma_ribbon did not vote, so its 8/13/34 lines must be absent.
  assert.ok(!ids.includes("ema_8"));
  assert.ok(!ids.includes("ema_34"));
});

test("ribbon draws all four ribbon periods", () => {
  const overlays = buildOverlays(candles(), ["ma_ribbon"], "long");
  assert.deepEqual(
    overlays.lines.map((line) => line.id),
    ["ema_8", "ema_13", "ema_21", "ema_34"],
  );
});

test("every drawn strategy is reported in the legend", () => {
  const overlays = buildOverlays(candles(), ["ema_trend", "donchian_break"], "long");
  const reported = overlays.drawn.map((item) => item.strategyId);
  assert.ok(reported.includes("ema_trend"));
  assert.ok(reported.includes("donchian_break"));
});

test("oscillator strategies are reported as having no geometry, not drawn", () => {
  const overlays = buildOverlays(candles(), ["rsi_momo", "macd_hist", "cci_extreme"], "long");
  assert.equal(overlays.lines.length, 0);
  assert.equal(overlays.drawn.length, 0);
  assert.deepEqual(overlays.noGeometry.sort(), ["cci_extreme", "macd_hist", "rsi_momo"]);
});

test("donchian channel lines never contain a null or NaN point", () => {
  const overlays = buildOverlays(candles(), ["donchian_break"], "long");
  for (const line of overlays.lines) {
    assert.ok(line.points.length > 1, `${line.id} should have points`);
    assert.ok(
      line.points.every((point) => Number.isFinite(point.value)),
      `${line.id} has a non-finite value`,
    );
  }
});

test("bollinger upper band sits above the lower band at every shared point", () => {
  const overlays = buildOverlays(candles(), ["bollinger_squeeze"], "long");
  const upper = overlays.lines.find((line) => line.id === "bb_upper");
  const lower = overlays.lines.find((line) => line.id === "bb_lower");
  assert.ok(upper && lower);
  const lowerByTime = new Map(lower.points.map((point) => [point.time, point.value]));
  for (const point of upper.points) {
    const other = lowerByTime.get(point.time);
    if (other != null) assert.ok(point.value >= other, `band inverted at ${point.time}`);
  }
});

test("zones always have top above bottom", () => {
  for (const direction of ["long", "short"] as const) {
    const overlays = buildOverlays(
      candles(),
      ["order_block", "fvg", "fib_retracement", "asian_range"],
      direction,
    );
    for (const zone of overlays.zones) {
      assert.ok(zone.top >= zone.bottom, `${zone.id} inverted on ${direction}`);
    }
  }
});

// The guard that matters. Written against the ENGINE'S OWN catalog rather than
// a hand-listed set, so adding a 32nd strategy to signal-engine.ts fails here
// until the overlay layer either draws it or declares it undrawable. The first
// version of this module silently dropped five strategies (trendline_break,
// ichimoku and the three harmonics) precisely because the coverage list was
// maintained by hand.
test("every engine strategy is accounted for on both directions", () => {
  const bars = candles();
  for (const direction of ["long", "short"] as const) {
    const overlays = buildOverlays(bars, [...ALL_ENGINE_STRATEGY_IDS], direction);
    const accounted = new Set([
      ...overlays.drawn.map((item) => item.strategyId),
      ...overlays.noGeometry,
    ]);
    const missing = ALL_ENGINE_STRATEGY_IDS.filter((id) => !accounted.has(id));
    assert.deepEqual(
      missing,
      [],
      `${direction}: unaccounted strategies — draw them or add them to NO_GEOMETRY`,
    );
  }
});

test("a voted strategy is either drawn or explained, never silently dropped", () => {
  const voted = [
    "ema_trend",
    "donchian_break",
    "rsi_momo",
    "order_block",
    "sr_confluence",
    "bos_choch",
  ];
  const overlays = buildOverlays(candles(), voted, "long");
  const accounted = new Set([...overlays.drawn.map((d) => d.strategyId), ...overlays.noGeometry]);
  for (const strategyId of voted) {
    assert.ok(accounted.has(strategyId), `${strategyId} was neither drawn nor explained`);
  }
});

// ---------------------------------------------------------------------------
// W3.4: sharp-reversal strategy pack overlays — rsi_divergence,
// macd_divergence, climax_exhaustion, stop_run_reversal, failed_breakout.
// Each needs its own targeted fixture: the shared saw-wave candles() above
// chains open = previous close, which ties every turning point's high/low
// with its neighbor and makes findSwingPoints report zero pivots — fine for
// the "accounted for" guard above (noGeometry still counts), but useless for
// proving these five actually draw something when they DO have geometry.
// ---------------------------------------------------------------------------

function overlayBar(
  index: number,
  bar: { open: number; high: number; low: number; close: number; volume?: number },
): OverlayCandle {
  return { time: 1_700_000_000 + index * 300, ...bar };
}

/** A quiet, rangebound base — identical bars so no swing, sweep, or breakout
 *  can accidentally form inside it; only bars appended after it can draw. */
function flatOverlayCandles(count = 60): OverlayCandle[] {
  return Array.from({ length: count }, (_, index) =>
    overlayBar(index, { open: 100, high: 100.3, low: 99.7, close: 100 }),
  );
}

/** Appends explicit bars after a flat base, continuing the same time series. */
function afterFlatOverlay(
  bars: { open: number; high: number; low: number; close: number; volume?: number }[],
  flatCount = 60,
): OverlayCandle[] {
  const base = flatOverlayCandles(flatCount);
  return [...base, ...bars.map((bar, offset) => overlayBar(flatCount + offset, bar))];
}

/** Same shape as signal-engine.test.ts's divergenceLongCandles: 40 bars
 *  declining, a 6-bar bounce (swing low A), an 8-bar decline to a lower low
 *  (swing low B), then a 4-bar reclaim. findSwingPoints reports exactly the
 *  two low pivots the divergence line should connect. High/low are close
 *  +/- a fixed wick, never derived from open, so the turning-point bars
 *  never tie with their neighbor on low/high. */
function divergenceLongOverlayCandles(): OverlayCandle[] {
  const candles: OverlayCandle[] = [];
  let prevClose = 120;
  let index = 0;
  const push = (close: number) => {
    candles.push(
      overlayBar(index, { open: prevClose, high: close + 0.15, low: close - 0.15, close }),
    );
    prevClose = close;
    index += 1;
  };
  for (let i = 0; i < 40; i += 1) push(120 - i * 0.8);
  for (let j = 1; j <= 6; j += 1) push(88 + j * 0.9);
  for (let j = 1; j <= 8; j += 1) push(93.4 - j * 0.75);
  for (let j = 1; j <= 4; j += 1) push(87.4 + j * 1.1);
  return candles;
}

/** Mirror of divergenceLongOverlayCandles: two swing highs, the second
 *  higher than the first. */
function divergenceShortOverlayCandles(): OverlayCandle[] {
  const candles: OverlayCandle[] = [];
  let prevClose = 80;
  let index = 0;
  const push = (close: number) => {
    candles.push(
      overlayBar(index, { open: prevClose, high: close + 0.15, low: close - 0.15, close }),
    );
    prevClose = close;
    index += 1;
  };
  for (let i = 0; i < 40; i += 1) push(80 + i * 0.8);
  for (let j = 1; j <= 6; j += 1) push(112 - j * 0.9);
  for (let j = 1; j <= 8; j += 1) push(106.6 + j * 0.75);
  for (let j = 1; j <= 4; j += 1) push(112.6 - j * 1.1);
  return candles;
}

test("rsi_divergence and macd_divergence draw a dashed line + markers at the same two swing-low pivots (long)", () => {
  const candles = divergenceLongOverlayCandles();
  const overlays = buildOverlays(candles, ["rsi_divergence", "macd_divergence"], "long");
  const rsiLine = overlays.lines.find((line) => line.id === "rsi_divergence_line");
  const macdLine = overlays.lines.find((line) => line.id === "macd_divergence_line");
  assert.ok(rsiLine, "expected an RSI divergence line");
  assert.ok(macdLine, "expected a MACD divergence line");
  assert.equal(rsiLine.dashed, true);
  assert.equal(macdLine.dashed, true);
  assert.equal(rsiLine.points.length, 2);
  assert.equal(macdLine.points.length, 2);
  // Both strategies vote on the SAME findSwingPoints pivots — same geometry,
  // distinguishable only by id/label/colour.
  assert.deepEqual(rsiLine.points, macdLine.points);
  assert.notEqual(rsiLine.color, macdLine.color);
  assert.notEqual(rsiLine.label, macdLine.label);
  assert.ok(
    rsiLine.points[1].value < rsiLine.points[0].value,
    "the newer low should be lower (price divergence)",
  );
  const reported = overlays.drawn.map((item) => item.strategyId);
  assert.ok(reported.includes("rsi_divergence"));
  assert.ok(reported.includes("macd_divergence"));
  assert.ok(overlays.markers.filter((m) => m.text === "RSI DIV").length >= 2);
  assert.ok(overlays.markers.filter((m) => m.text === "MACD DIV").length >= 2);
  assert.ok(
    overlays.markers.filter((m) => m.text === "RSI DIV").every((m) => m.position === "belowBar"),
  );
});

test("rsi_divergence and macd_divergence draw at the two swing-high pivots (short)", () => {
  const candles = divergenceShortOverlayCandles();
  const overlays = buildOverlays(candles, ["rsi_divergence", "macd_divergence"], "short");
  const rsiLine = overlays.lines.find((line) => line.id === "rsi_divergence_line");
  assert.ok(rsiLine);
  assert.equal(rsiLine.points.length, 2);
  assert.ok(
    rsiLine.points[1].value > rsiLine.points[0].value,
    "the newer high should be higher (price divergence)",
  );
  const reported = overlays.drawn.map((item) => item.strategyId);
  assert.ok(reported.includes("rsi_divergence"));
  assert.ok(reported.includes("macd_divergence"));
  assert.ok(
    overlays.markers.filter((m) => m.text === "RSI DIV").every((m) => m.position === "aboveBar"),
  );
});

test("rsi_divergence / macd_divergence draw nothing when not in the voted list", () => {
  const candles = divergenceLongOverlayCandles();
  const overlays = buildOverlays(candles, ["ema_trend"], "long");
  assert.ok(!overlays.lines.some((line) => line.id === "rsi_divergence_line"));
  assert.ok(!overlays.lines.some((line) => line.id === "macd_divergence_line"));
  assert.ok(!overlays.drawn.some((item) => item.strategyId === "rsi_divergence"));
  assert.ok(!overlays.drawn.some((item) => item.strategyId === "macd_divergence"));
});

test("climax_exhaustion draws a level at the climax bar's extreme plus a marker on that bar", () => {
  const shortCandles = afterFlatOverlay([
    { open: 100, high: 112, low: 99, close: 100.5, volume: 5000 },
  ]);
  const shortOverlays = buildOverlays(shortCandles, ["climax_exhaustion"], "short");
  const shortLevel = shortOverlays.levels.find((level) => level.id === "climax");
  assert.ok(shortLevel, "expected a climax level for the short case");
  assert.equal(shortLevel.price, 112); // the climax bar's HIGH for a short
  assert.ok(shortOverlays.markers.some((m) => m.text === "CLIMAX" && m.position === "aboveBar"));
  assert.ok(shortOverlays.drawn.some((item) => item.strategyId === "climax_exhaustion"));

  const longCandles = afterFlatOverlay([
    { open: 100, high: 101, low: 88, close: 99.5, volume: 5000 },
  ]);
  const longOverlays = buildOverlays(longCandles, ["climax_exhaustion"], "long");
  const longLevel = longOverlays.levels.find((level) => level.id === "climax");
  assert.ok(longLevel, "expected a climax level for the long case");
  assert.equal(longLevel.price, 88); // the climax bar's LOW for a long
  assert.ok(longOverlays.markers.some((m) => m.text === "CLIMAX" && m.position === "belowBar"));
});

test("climax_exhaustion draws nothing when not in the voted list", () => {
  const candles = afterFlatOverlay([{ open: 100, high: 112, low: 99, close: 100.5, volume: 5000 }]);
  const overlays = buildOverlays(candles, ["ema_trend"], "short");
  assert.ok(!overlays.levels.some((level) => level.id === "climax"));
  assert.ok(!overlays.drawn.some((item) => item.strategyId === "climax_exhaustion"));
});

test("stop_run_reversal draws a level at the swept prior extreme plus a marker on the sweep bar (not the confirm bar)", () => {
  const shortCandles = afterFlatOverlay([
    { open: 100, high: 106, low: 99.8, close: 105 },
    { open: 105, high: 105.2, low: 99, close: 99.3 },
  ]);
  const shortOverlays = buildOverlays(shortCandles, ["stop_run_reversal"], "short");
  const level = shortOverlays.levels.find((l) => l.id === "stop_run");
  assert.ok(level, "expected a stop-run level");
  assert.equal(level.price, 100.3); // the flat prior 20-bar high that got swept
  const sweepBarTime = shortCandles.at(-2)!.time;
  assert.ok(shortOverlays.markers.some((m) => m.text === "SWEEP" && m.time === sweepBarTime));
  assert.ok(shortOverlays.drawn.some((item) => item.strategyId === "stop_run_reversal"));

  const longCandles = afterFlatOverlay([
    { open: 100, high: 100.2, low: 94, close: 95 },
    { open: 95, high: 101, low: 94.8, close: 100.7 },
  ]);
  const longOverlays = buildOverlays(longCandles, ["stop_run_reversal"], "long");
  const longLevel = longOverlays.levels.find((l) => l.id === "stop_run");
  assert.ok(longLevel);
  assert.equal(longLevel.price, 99.7); // the flat prior 20-bar low that got swept
});

test("stop_run_reversal draws nothing when not in the voted list", () => {
  const candles = afterFlatOverlay([
    { open: 100, high: 106, low: 99.8, close: 105 },
    { open: 105, high: 105.2, low: 99, close: 99.3 },
  ]);
  const overlays = buildOverlays(candles, ["ema_trend"], "short");
  assert.ok(!overlays.levels.some((level) => level.id === "stop_run"));
  assert.ok(!overlays.drawn.some((item) => item.strategyId === "stop_run_reversal"));
});

test("failed_breakout draws a level at the broken 20-bar boundary plus a marker on the bar that broke it and failed", () => {
  const shortCandles = afterFlatOverlay([
    { open: 100, high: 108, low: 100, close: 107 },
    { open: 107, high: 107, low: 96, close: 96.5 },
  ]);
  const shortOverlays = buildOverlays(shortCandles, ["failed_breakout"], "short");
  const level = shortOverlays.levels.find((l) => l.id === "failed_breakout");
  assert.ok(level, "expected a failed-breakout level");
  assert.equal(level.price, 100.3); // the flat prior 20-bar high that was broken
  const breakBarTime = shortCandles.at(-2)!.time;
  assert.ok(shortOverlays.markers.some((m) => m.text === "FAILED" && m.time === breakBarTime));
  assert.ok(shortOverlays.drawn.some((item) => item.strategyId === "failed_breakout"));

  const longCandles = afterFlatOverlay([
    { open: 100, high: 100, low: 92, close: 93 },
    { open: 93, high: 104, low: 93, close: 103.5 },
  ]);
  const longOverlays = buildOverlays(longCandles, ["failed_breakout"], "long");
  const longLevel = longOverlays.levels.find((l) => l.id === "failed_breakout");
  assert.ok(longLevel);
  assert.equal(longLevel.price, 99.7); // the flat prior 20-bar low that was broken
});

test("failed_breakout draws nothing when not in the voted list", () => {
  const candles = afterFlatOverlay([
    { open: 100, high: 108, low: 100, close: 107 },
    { open: 107, high: 107, low: 96, close: 96.5 },
  ]);
  const overlays = buildOverlays(candles, ["ema_trend"], "short");
  assert.ok(!overlays.levels.some((level) => level.id === "failed_breakout"));
  assert.ok(!overlays.drawn.some((item) => item.strategyId === "failed_breakout"));
});

// ---------------------------------------------------------------------------
// W3.3: buildLocationOverlay — separately exported from buildOverlays on
// purpose (see the function's own doc comment): location is not a strategy
// vote, so it must not touch the strategy-keyed guard test at line ~109
// above. Verified against the live output rather than hand-derived: the
// saw-wave candles() fixture's last-60-bar swing puts the latest close at
// swingPosition 0.51 (just inside the premium half).
// ---------------------------------------------------------------------------

test("buildLocationOverlay (long): draws a discount zone, a premium zone, an equilibrium level, and a position marker", () => {
  const overlay = buildLocationOverlay(candles(), "long");
  assert.ok(overlay);
  const { zones, levels, markers } = overlay!;

  assert.equal(zones.length, 2);
  const discount = zones.find((z) => z.id === "location_discount")!;
  const premium = zones.find((z) => z.id === "location_premium")!;
  assert.ok(discount && premium, "expected both a discount and a premium zone");
  assert.notEqual(discount.color, premium.color, "the two zones must be visually distinct");
  // Discount spans swing low -> equilibrium; premium spans equilibrium ->
  // swing high. Both zones share the equilibrium boundary, and top >= bottom
  // holds the same way it does for every other zone buildOverlays draws.
  assert.ok(discount.top >= discount.bottom);
  assert.ok(premium.top >= premium.bottom);
  assert.equal(discount.top, premium.bottom, "the zones must share the equilibrium boundary");

  assert.equal(levels.length, 1);
  const eq = levels[0];
  assert.equal(eq.price, discount.top);
  assert.match(eq.label, /^EQ /, "the equilibrium level must be labelled with its price");

  assert.equal(markers.length, 1);
  const marker = markers[0];
  assert.equal(marker.time, candles().at(-1)!.time);
  assert.equal(marker.text, "0.51 premium");
  assert.equal(marker.position, "aboveBar"); // premium half -> marker sits above the bar
});

test("buildLocationOverlay (short): draws the SAME market geometry as long — location describes the market, not the direction", () => {
  const bars = candles();
  const long = buildLocationOverlay(bars, "long");
  const short = buildLocationOverlay(bars, "short");
  assert.ok(long && short);
  // Every field here (swing high/low, equilibrium, swingPosition, the
  // marker) is a property of the CANDLES, not the trade direction — unlike
  // readLocation's score/multiplier/chasing, which the signal-engine wiring
  // reads directly and are direction-aware by design.
  assert.deepEqual(short, long);
});

test("buildLocationOverlay: null when there isn't enough history, and when the range is dead flat", () => {
  assert.equal(buildLocationOverlay(candles(30), "long"), null); // short of readLocation's 60-bar lookback
  const flat: OverlayCandle[] = Array.from({ length: 60 }, (_, i) => ({
    time: 1_700_000_000 + i * 60,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
  }));
  assert.equal(buildLocationOverlay(flat, "long"), null); // zero swing range
  assert.equal(buildLocationOverlay(flat, "short"), null);
});
