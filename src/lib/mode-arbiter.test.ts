import test from "node:test";
import assert from "node:assert/strict";
import { arbitrateMode } from "./mode-arbiter.ts";
import type { RegimeRead } from "./regime.ts";
import type { LocationRead } from "./location.ts";

// --- fixture builders --------------------------------------------------------

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
    swingPosition: 0.5,
    meanDistanceAtr: 0,
    headroomAtr: null,
    score: 0.5,
    multiplier: 0.925,
    label: "equilibrium",
    chasing: false,
    swing: { highIndex: 10, highPrice: 1.1, lowIndex: 0, lowPrice: 1.0 },
    ...overrides,
  };
}

// --- tests --------------------------------------------------------------

test("rule 1: a pending High-impact release stands down regardless of an otherwise clean trend", () => {
  const result = arbitrateMode({
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: locationFixture({ chasing: false }),
    direction: "long",
    minutesToHighImpact: 8,
  });
  assert.equal(result.verdict, "stand_down");
  assert.equal(result.bias, "long");
  assert.ok(result.reason.length > 0);
});

test("rule 1 boundary: -30 and 15 minutes both stand down; -31, 16 and null do not", () => {
  const base = {
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: null,
    direction: "long" as const,
  };
  assert.equal(arbitrateMode({ ...base, minutesToHighImpact: -30 }).verdict, "stand_down");
  assert.equal(arbitrateMode({ ...base, minutesToHighImpact: 15 }).verdict, "stand_down");
  assert.equal(arbitrateMode({ ...base, minutesToHighImpact: -31 }).verdict, "intraday");
  assert.equal(arbitrateMode({ ...base, minutesToHighImpact: 16 }).verdict, "intraday");
  assert.equal(arbitrateMode({ ...base, minutesToHighImpact: null }).verdict, "intraday");
  assert.equal(arbitrateMode({ ...base }).verdict, "intraday"); // minutesToHighImpact omitted entirely
});

test("rule 2: a null regime stands down with a null bias", () => {
  const result = arbitrateMode({
    regime: null,
    location: null,
    direction: "long",
    minutesToHighImpact: null,
  });
  assert.equal(result.verdict, "stand_down");
  assert.equal(result.bias, null);
  assert.ok(result.reason.length > 0);
});

test("rule 3: range and contraction regimes scalp the edges with no tide", () => {
  for (const marketRegime of ["range", "contraction"] as const) {
    const result = arbitrateMode({
      regime: regimeFixture({ regime: marketRegime, trendDirection: null }),
      location: locationFixture({ chasing: false }),
      direction: null,
      minutesToHighImpact: null,
    });
    assert.equal(result.verdict, "scalp", marketRegime);
    assert.equal(result.bias, null, marketRegime);
    assert.ok(result.reason.length > 0, marketRegime);
  }
});

test("rule 4: right direction but a chasing location waits for a pullback", () => {
  const result = arbitrateMode({
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: locationFixture({ chasing: true, swingPosition: 0.84 }),
    direction: "long",
    minutesToHighImpact: null,
  });
  assert.equal(result.verdict, "wait");
  assert.equal(result.bias, "long");
  assert.ok(
    result.reason.includes("0.84"),
    `expected the swing position quoted in the reason, got: ${result.reason}`,
  );
  assert.ok(result.reason.length > 0);
});

test("rule 5: trend with a non-chasing location goes intraday", () => {
  const result = arbitrateMode({
    regime: regimeFixture({ regime: "weak_trend", trendDirection: "short" }),
    location: locationFixture({ chasing: false }),
    direction: "short",
    minutesToHighImpact: null,
  });
  assert.equal(result.verdict, "intraday");
  assert.equal(result.bias, "short");
  assert.ok(result.reason.length > 0);
});

test("rule 5: trend with no location read at all also goes intraday", () => {
  const result = arbitrateMode({
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: null,
    direction: undefined,
    minutesToHighImpact: null,
  });
  assert.equal(result.verdict, "intraday");
  assert.equal(result.bias, "long");
  assert.ok(result.reason.length > 0);
});

test("rule 6: expansion regime scalps — loud but not settled", () => {
  const result = arbitrateMode({
    regime: regimeFixture({ regime: "expansion", trendDirection: null }),
    location: locationFixture({ chasing: false }),
    direction: null,
    minutesToHighImpact: null,
  });
  assert.equal(result.verdict, "scalp");
  assert.equal(result.bias, null);
  assert.ok(result.reason.length > 0);
});

test("rule 7: trend with a chasing location but no confirmed direction falls back to intraday", () => {
  const result = arbitrateMode({
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: locationFixture({ chasing: true }),
    direction: undefined,
    minutesToHighImpact: null,
  });
  assert.equal(result.verdict, "intraday");
  assert.equal(result.bias, "long");
  assert.ok(result.reason.length > 0);

  // Same gap, reached a different way: a direction WAS given but it fights
  // the trend rather than matching it, so rule 4 still can't apply.
  const counterTrend = arbitrateMode({
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: locationFixture({ chasing: true }),
    direction: "short",
    minutesToHighImpact: null,
  });
  assert.equal(counterTrend.verdict, "intraday");
  assert.equal(counterTrend.bias, "long");
});

test("rule order: a pending release beats a clean strong trend that would otherwise go intraday", () => {
  const result = arbitrateMode({
    regime: regimeFixture({ regime: "strong_trend", trendDirection: "long" }),
    location: locationFixture({ chasing: false }),
    direction: "long",
    minutesToHighImpact: 0,
  });
  assert.equal(result.verdict, "stand_down");
  assert.equal(result.bias, "long");
  assert.ok(result.reason.length > 0);
});
