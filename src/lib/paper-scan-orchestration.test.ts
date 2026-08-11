import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveEnabledPaperStrategies,
  scanCompletedTimeframes,
} from "./paper-scan-orchestration.ts";
import { ALL_ENGINE_STRATEGY_IDS } from "./strategy-weights.ts";
import type { NativeXauusdQuote, PaperTimeframe, TwoSidedCandle } from "./xauusd-market-data.ts";

const QUOTE: NativeXauusdQuote = {
  provider: "OANDA_V20_PRACTICE",
  instrument: "XAU_USD",
  bid: 3400.1,
  ask: 3400.3,
  providerTime: "2026-08-11T07:42:10.000Z",
  receivedAt: "2026-08-11T07:42:11.000Z",
  tradeable: true,
};

const INTERVAL_MS: Record<PaperTimeframe, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

/** Deterministic monotonic trend that reliably fires the trend/breakout/momentum engines. */
function trendCandles(
  timeframe: PaperTimeframe,
  direction: 1 | -1 = 1,
  count = 220,
): TwoSidedCandle[] {
  const start = Date.parse("2026-08-11T00:00:00Z");
  return Array.from({ length: count }, (_, i) => {
    const drift = direction * 0.05;
    const wiggle = Math.sin(i * 0.7) * 0.02;
    const open = 3400 + direction * i * 0.05;
    const close = open + drift + wiggle;
    const bidHigh = Math.max(open, close) + 0.08;
    const bidLow = Math.min(open, close) - 0.08;
    return {
      instrument: "XAU_USD",
      timeframe,
      time: new Date(start + i * INTERVAL_MS[timeframe]).toISOString(),
      bid: { open, high: bidHigh, low: bidLow, close },
      ask: { open: open + 0.2, high: bidHigh + 0.2, low: bidLow + 0.2, close: close + 0.2 },
      volume: 1_000 + i,
      complete: true,
    };
  });
}

test("engine registry holds exactly 36 strategies", () => {
  assert.equal(ALL_ENGINE_STRATEGY_IDS.length, 36);
});

test("resolveEnabledPaperStrategies returns registry order filtered by explicit disables", () => {
  const allCatalogRows = ALL_ENGINE_STRATEGY_IDS.map((id) => ({ id }));
  const allEnabledRows = ALL_ENGINE_STRATEGY_IDS.map((strategyId) => ({
    strategyId,
    enabled: true,
  }));
  assert.deepEqual(resolveEnabledPaperStrategies(allCatalogRows, allEnabledRows), [
    ...ALL_ENGINE_STRATEGY_IDS,
  ]);
  assert.equal(
    resolveEnabledPaperStrategies(allCatalogRows, [
      { strategyId: "ema_trend", enabled: false },
    ]).includes("ema_trend"),
    false,
  );
  // A missing or unknown catalog ID is drift and must refuse to resolve.
  assert.throws(
    () => resolveEnabledPaperStrategies(allCatalogRows.slice(1), allEnabledRows),
    /strategy_catalog_drift/,
  );
  assert.throws(
    () => resolveEnabledPaperStrategies([...allCatalogRows, { id: "bogus" }], allEnabledRows),
    /strategy_catalog_drift/,
  );
});

test("a newly completed timeframe yields a candidate whose accounting partitions all 36 engines", async () => {
  const candidates = await scanCompletedTimeframes({
    quote: QUOTE,
    candlesByTimeframe: { H1: trendCandles("H1") },
    newlyCompleted: ["H1"],
    enabledStrategyIds: [...ALL_ENGINE_STRATEGY_IDS],
    engineVersion: "test-engine-v1",
    policyVersion: "test-policy-v1",
  });
  assert.equal(candidates.length, 1);
  const cand = candidates[0];
  assert.equal(cand.timeframe, "H1");
  assert.equal(cand.mode, "intraday");
  assert.equal(cand.direction, "long");
  assert.equal(cand.engineVersion, "test-engine-v1");

  const accounting = cand.accounting;
  assert.deepEqual(
    [
      ...accounting.evaluated,
      ...accounting.abstained,
      ...accounting.incompatible,
      ...accounting.excluded,
      ...accounting.failed.map((item) => item.strategyId),
    ].sort(),
    [...ALL_ENGINE_STRATEGY_IDS].sort(),
  );

  // Compatible macro strategies fail with the macro label; no signal cites them.
  const macroFailed = accounting.failed.filter(
    (f) => f.strategyId === "news_reactive" || f.strategyId === "ai_confluence",
  );
  assert.equal(macroFailed.length, 2);
  assert.ok(macroFailed.every((f) => f.code === "macro_context_unavailable"));
  for (const id of accounting.failed.map((f) => f.strategyId)) {
    assert.equal(cand.contributingStrategies.includes(id), false);
  }
  // Incompatible timeframes stay incompatible, never failed.
  assert.ok(
    accounting.incompatible.every((id) => id !== "news_reactive" && id !== "ai_confluence"),
  );

  // Validity minutes for H1 are exactly 90.
  assert.equal(Date.parse(cand.expiresAt) - Date.parse(cand.candleClosedAt), 90 * 60_000);
});

test("M1 maps to scalper mode with 10-minute validity", async () => {
  const candidates = await scanCompletedTimeframes({
    quote: QUOTE,
    candlesByTimeframe: { M1: trendCandles("M1") },
    newlyCompleted: ["M1"],
    enabledStrategyIds: [...ALL_ENGINE_STRATEGY_IDS],
    engineVersion: "e",
    policyVersion: "p",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mode, "scalper");
  assert.equal(
    Date.parse(candidates[0].expiresAt) - Date.parse(candidates[0].candleClosedAt),
    10 * 60_000,
  );
});

test("every newly completed timeframe is scanned exactly once, one candidate each", async () => {
  const candidates = await scanCompletedTimeframes({
    quote: QUOTE,
    candlesByTimeframe: {
      M1: trendCandles("M1"),
      M5: trendCandles("M5"),
    },
    newlyCompleted: ["M1", "M5"],
    enabledStrategyIds: [...ALL_ENGINE_STRATEGY_IDS],
    engineVersion: "e",
    policyVersion: "p",
  });
  assert.deepEqual(candidates.map((c) => c.timeframe).sort(), ["M1", "M5"]);
});

test("candidate carries mtf null when no direction candles are present", async () => {
  const candidates = await scanCompletedTimeframes({
    quote: QUOTE,
    candlesByTimeframe: { M5: trendCandles("M5") },
    newlyCompleted: ["M5"],
    enabledStrategyIds: [...ALL_ENGINE_STRATEGY_IDS],
    engineVersion: "e",
    policyVersion: "p",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mtf, null);
  assert.deepEqual(candidates[0].snapshotRoles, [{ timeframe: "M5", role: "entry" }]);
});

test("a confirmed opposing higher-timeframe tide rejects the entry candidate", async () => {
  const candidates = await scanCompletedTimeframes({
    quote: QUOTE,
    candlesByTimeframe: {
      // Entry on M5 trends UP, but the M15 tide confirms DOWN.
      M5: trendCandles("M5", 1),
      M15: trendCandles("M15", -1),
    },
    newlyCompleted: ["M5"],
    enabledStrategyIds: [...ALL_ENGINE_STRATEGY_IDS],
    engineVersion: "e",
    policyVersion: "p",
  });
  assert.equal(candidates.length, 0);
});

test("an aligning higher-timeframe tide is stamped into the candidate", async () => {
  const candidates = await scanCompletedTimeframes({
    quote: QUOTE,
    candlesByTimeframe: {
      M5: trendCandles("M5", 1),
      M15: trendCandles("M15", 1),
    },
    newlyCompleted: ["M5"],
    enabledStrategyIds: [...ALL_ENGINE_STRATEGY_IDS],
    engineVersion: "e",
    policyVersion: "p",
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].mtf?.confirmed, "long");
  assert.deepEqual(candidates[0].snapshotRoles, [
    { timeframe: "M5", role: "entry" },
    { timeframe: "M15", role: "mtf_direction" },
  ]);
});
