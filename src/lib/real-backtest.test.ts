import assert from "node:assert/strict";
import test from "node:test";
import { resolveSignalOutcome, runRealBacktest } from "./real-backtest.ts";
import type { SignalEngineCandle } from "./signal-engine.ts";
import { replaySignalPath } from "./signal-scorer.ts";
import { ALL_ENGINE_STRATEGY_IDS } from "./strategy-weights.ts";

/**
 * A zigzag market: alternating up/down legs so trend-following strategies
 * fire repeatedly across the WHOLE series (both the in-sample majority and
 * the out-of-sample tail), not just once at the start. Deterministic (no
 * Math.random) so the test is stable.
 */
function buildWalkForwardCandles(totalBars: number): SignalEngineCandle[] {
  const candles: SignalEngineCandle[] = [];
  let price = 100;
  let legDirection: 1 | -1 = 1;
  const legLength = 40;
  let index = 0;
  while (candles.length < totalBars) {
    for (let i = 0; i < legLength && candles.length < totalBars; i += 1, index += 1) {
      const drift = legDirection * 0.06;
      const wiggle = Math.sin(index * 0.7) * 0.04;
      const open = price;
      const close = price + drift + wiggle;
      const high = Math.max(open, close) + 0.08;
      const low = Math.min(open, close) - 0.08;
      candles.push({
        time: new Date(Date.UTC(2025, 0, 1, index, 0, 0)).toISOString(),
        open,
        high,
        low,
        close,
        complete: true,
        volume: 1_000 + index,
      });
      price = close;
    }
    legDirection = legDirection === 1 ? -1 : 1;
  }
  return candles;
}

test("resolveSignalOutcome matches replaySignalPath's first-touch semantics (TP1 then TP2)", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 98,
    takeProfit1: 102.5,
    takeProfit2: 104,
  };
  const forward: SignalEngineCandle[] = [
    {
      time: "2025-01-01T01:00:00.000Z",
      open: 100,
      high: 100.5,
      low: 99.5,
      close: 100.2,
      complete: true,
    },
    {
      time: "2025-01-01T02:00:00.000Z",
      open: 100.2,
      high: 101,
      low: 99.8,
      close: 100.8,
      complete: true,
    },
    {
      time: "2025-01-01T03:00:00.000Z",
      open: 100.8,
      high: 103,
      low: 100.5,
      close: 102.8,
      complete: true,
    },
    {
      time: "2025-01-01T04:00:00.000Z",
      open: 102.8,
      high: 104.5,
      low: 102,
      close: 104.2,
      complete: true,
    },
  ];

  // Explicit zero halfSpread: this test's purpose is bar-for-bar first-touch
  // sequencing (TP1 before TP2, non-lookahead), not spread precision — that
  // is covered separately below. Pinning halfSpread: 0 keeps this a
  // zero-cost baseline, equivalent to the original mid-only assertions.
  // `all_out` for the same reason: the sequencing under test predates B-single,
  // where a TP1 touch arms a breakeven stop instead of closing the trade.
  const viaHarness = resolveSignalOutcome(signal, forward, {
    halfSpread: 0,
    policy: "all_out",
  });
  const viaScorer = replaySignalPath(
    {
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry,
      stop_loss: signal.stopLoss,
      take_profit_1: signal.takeProfit1,
      take_profit_2: signal.takeProfit2,
      created_at: "2025-01-01T00:00:00.000Z",
    },
    forward.map((candle) => ({
      time: candle.time,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })),
    { halfSpread: 0, policy: "all_out" },
  );

  assert.equal(viaHarness.status, viaScorer.status);
  assert.equal(viaHarness.r, viaScorer.r);
  assert.equal(viaHarness.status, "hit_tp1");
  // The MAE/MFE/barsHeld additions are independently computed by each
  // function too — they must never silently drift apart either.
  assert.equal(viaHarness.maeR, viaScorer.maeR);
  assert.equal(viaHarness.mfeR, viaScorer.mfeR);
  assert.equal(viaHarness.barsHeld, viaScorer.barsHeld);
});

test("resolveSignalOutcome: a same-candle stop-and-target touch resolves as the stop, matching replaySignalPath", () => {
  const signal = {
    pair: "EURUSD",
    direction: "short" as const,
    entry: 100,
    stopLoss: 102,
    takeProfit1: 97.5,
    takeProfit2: 96,
  };
  const forward: SignalEngineCandle[] = [
    {
      time: "2025-01-01T01:00:00.000Z",
      open: 100,
      high: 103,
      low: 95,
      close: 99,
      complete: true,
    },
  ];

  // Same rationale as above: zero halfSpread keeps this a spread-agnostic
  // baseline for the "stop wins the same-candle tie" rule specifically.
  const viaHarness = resolveSignalOutcome(signal, forward, { halfSpread: 0 });
  const viaScorer = replaySignalPath(
    {
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry,
      stop_loss: signal.stopLoss,
      take_profit_1: signal.takeProfit1,
      take_profit_2: signal.takeProfit2,
      created_at: "2025-01-01T00:00:00.000Z",
    },
    forward.map((candle) => ({
      time: candle.time,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })),
    { halfSpread: 0 },
  );

  assert.equal(viaHarness.status, "hit_sl");
  assert.equal(viaHarness.status, viaScorer.status);
  assert.equal(viaHarness.r, viaScorer.r);
  assert.equal(viaHarness.maeR, viaScorer.maeR);
  assert.equal(viaHarness.mfeR, viaScorer.mfeR);
  assert.equal(viaHarness.barsHeld, viaScorer.barsHeld);
});

test("resolveSignalOutcome: no forward candles resolves open with zero R, matching replaySignalPath", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 98,
    takeProfit1: 102,
    takeProfit2: 104,
  };
  const viaHarness = resolveSignalOutcome(signal, [], { halfSpread: 0 });
  const viaScorer = replaySignalPath(
    {
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry,
      stop_loss: signal.stopLoss,
      take_profit_1: signal.takeProfit1,
      take_profit_2: signal.takeProfit2,
      created_at: "2025-01-01T00:00:00.000Z",
    },
    [],
    { halfSpread: 0 },
  );
  // Shape grew three fields in Part 3 (MAE/MFE/barsHeld): with no forward
  // candles there are no bars to examine, so both excursions and barsHeld
  // are all 0 per spec ("if there are no bars to examine, both are 0").
  assert.deepEqual(viaHarness, {
    status: "open",
    r: 0,
    resolutionIndexOffset: null,
    maeR: 0,
    mfeR: 0,
    barsHeld: 0,
  });
  assert.equal(viaScorer.status, "open");
  assert.equal(viaScorer.r, 0);
  assert.equal(viaScorer.maeR, 0);
  assert.equal(viaScorer.mfeR, 0);
  assert.equal(viaScorer.barsHeld, 0);
});

// ---------------------------------------------------------------------------
// Side-aware touch detection and MAE/MFE, directly on resolveSignalOutcome.
// Every case is cross-checked against replaySignalPath on the same inputs —
// this file's whole reason to exist is making sure the two independently
// written functions can never silently drift apart, and that guarantee has
// to cover the new side-aware/MAE/MFE logic too, not just the pre-existing
// first-touch sequencing. Explicit opts.halfSpread throughout so the exact
// cases are pinned and independent of the costs.ts seed table.
// ---------------------------------------------------------------------------

const RESOLVE_CREATED_AT = "2025-01-01T00:00:00.000Z";

function crossCheck(
  signal: {
    pair: string;
    direction: "long" | "short";
    entry: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
  },
  forward: SignalEngineCandle[],
  opts?: { halfSpread?: number; policy?: "b_single" | "all_out" },
) {
  const viaHarness = resolveSignalOutcome(signal, forward, opts);
  const viaScorer = replaySignalPath(
    {
      pair: signal.pair,
      direction: signal.direction,
      entry: signal.entry,
      stop_loss: signal.stopLoss,
      take_profit_1: signal.takeProfit1,
      take_profit_2: signal.takeProfit2,
      created_at: RESOLVE_CREATED_AT,
    },
    forward.map((candle) => ({
      time: candle.time,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })),
    opts,
  );
  return { viaHarness, viaScorer };
}

function bar(time: string, high: number, low: number, close: number): SignalEngineCandle {
  return { time, open: close, high, low, close, complete: true };
}

test("1. resolveSignalOutcome: core bug, long side — mid low sits above the stop but the bid low breaches it", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 99,
    takeProfit1: 101.25,
    takeProfit2: 102,
  };
  const forward = [bar("2025-01-01T01:00:00.000Z", 99.5, 99.03, 99.2)];

  const { viaHarness: withSpread, viaScorer } = crossCheck(signal, forward, { halfSpread: 0.05 });
  assert.equal(withSpread.status, "hit_sl");
  assert.equal(withSpread.r, -1);
  assert.equal(withSpread.status, viaScorer.status);

  // Regression guard: the same bar under zero spread must NOT stop out.
  const { viaHarness: zeroSpread } = crossCheck(signal, forward, { halfSpread: 0 });
  assert.notEqual(zeroSpread.status, "hit_sl");
});

test("2. resolveSignalOutcome: core bug, short side — mid high sits below the stop but the ask high breaches it", () => {
  const signal = {
    pair: "EURUSD",
    direction: "short" as const,
    entry: 100,
    stopLoss: 101,
    takeProfit1: 98.75,
    takeProfit2: 98,
  };
  const forward = [bar("2025-01-01T01:00:00.000Z", 100.97, 100.5, 100.8)];

  const { viaHarness: withSpread, viaScorer } = crossCheck(signal, forward, { halfSpread: 0.05 });
  assert.equal(withSpread.status, "hit_sl");
  assert.equal(withSpread.r, -1);
  assert.equal(withSpread.status, viaScorer.status);

  const { viaHarness: zeroSpread } = crossCheck(signal, forward, { halfSpread: 0 });
  assert.notEqual(zeroSpread.status, "hit_sl");
});

test("3. resolveSignalOutcome: target under-fills — mid high clears TP1 but the bid high does not", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 99,
    takeProfit1: 101,
    takeProfit2: 102,
  };
  const forward = [bar("2025-01-01T01:00:00.000Z", 101.03, 100.5, 100.9)];

  const { viaHarness: withSpread, viaScorer } = crossCheck(signal, forward, { halfSpread: 0.05 });
  assert.notEqual(withSpread.status, "hit_tp1");
  assert.equal(withSpread.status, viaScorer.status);

  // Contrast: at zero spread the same bar DOES print TP1.
  const { viaHarness: zeroSpread } = crossCheck(signal, forward, {
    halfSpread: 0,
    policy: "all_out",
  });
  assert.equal(zeroSpread.status, "hit_tp1");
});

test("4. resolveSignalOutcome: same-bar stop and target still resolves as the stop with spread applied", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 99,
    takeProfit1: 101,
    takeProfit2: 102,
  };
  const forward = [bar("2025-01-01T01:00:00.000Z", 103, 98, 100.5)];

  const { viaHarness, viaScorer } = crossCheck(signal, forward, { halfSpread: 0.05 });
  assert.equal(viaHarness.status, "hit_sl");
  assert.equal(viaHarness.r, -1);
  assert.equal(viaHarness.status, viaScorer.status);
});

test("5. resolveSignalOutcome: TP2 and TP1 touched on the same bar resolves as TP2", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 99,
    takeProfit1: 101,
    takeProfit2: 102,
  };
  const forward = [bar("2025-01-01T01:00:00.000Z", 102.5, 99.5, 102.3)];

  const { viaHarness, viaScorer } = crossCheck(signal, forward, { halfSpread: 0.05 });
  assert.equal(viaHarness.status, "hit_tp2");
  assert.equal(viaHarness.r, 2);
  assert.equal(viaHarness.status, viaScorer.status);
});

test("6. resolveSignalOutcome: maeR/mfeR on a clean winner — small maeR, mfeR at least the target's R", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 99,
    takeProfit1: 101.25,
    takeProfit2: 102,
  };
  const forward = [
    bar("2025-01-01T01:00:00.000Z", 100.3, 99.7, 100.2),
    bar("2025-01-01T02:00:00.000Z", 102.5, 100.1, 102.3),
  ];

  const { viaHarness, viaScorer } = crossCheck(signal, forward, { halfSpread: 0.02 });
  assert.equal(viaHarness.status, "hit_tp2");
  assert.ok(viaHarness.maeR < 0.5, `expected a small maeR, got ${viaHarness.maeR}`);
  assert.ok(viaHarness.mfeR >= 2, `expected mfeR at least the 2R target, got ${viaHarness.mfeR}`);
  assert.equal(viaHarness.maeR, viaScorer.maeR);
  assert.equal(viaHarness.mfeR, viaScorer.mfeR);
});

test("7. resolveSignalOutcome: maeR on a trade that dipped hard against and still won is a positive magnitude", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 95,
    takeProfit1: 103.75,
    takeProfit2: 105,
  };
  const forward = [
    bar("2025-01-01T01:00:00.000Z", 100.2, 96, 96.5),
    bar("2025-01-01T02:00:00.000Z", 105.3, 100, 105.1),
  ];

  const { viaHarness, viaScorer } = crossCheck(signal, forward, { halfSpread: 0.05 });
  assert.equal(viaHarness.status, "hit_tp2");
  assert.ok(viaHarness.maeR > 0, `expected a positive maeR, got ${viaHarness.maeR}`);
  assert.ok(viaHarness.maeR > 0.5, `expected the hard dip to register, got ${viaHarness.maeR}`);
  assert.equal(viaHarness.maeR, viaScorer.maeR);
});

test("8. resolveSignalOutcome: maeR and mfeR are 0 when no forward candles exist", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 99,
    takeProfit1: 101.25,
    takeProfit2: 102,
  };
  const viaHarness = resolveSignalOutcome(signal, [], { halfSpread: 0.05 });
  assert.equal(viaHarness.status, "open");
  assert.equal(viaHarness.maeR, 0);
  assert.equal(viaHarness.mfeR, 0);
  assert.equal(viaHarness.barsHeld, 0);
});

test("9. resolveSignalOutcome: excursion after the resolution bar is excluded from mfeR", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 99,
    takeProfit1: 101.25,
    takeProfit2: 102,
  };
  const forward = [
    bar("2025-01-01T01:00:00.000Z", 99.5, 98.9, 99),
    bar("2025-01-01T02:00:00.000Z", 99.6, 99.1, 99.4),
    // Huge favourable spike two bars after the stop-out — must be ignored.
    bar("2025-01-01T03:00:00.000Z", 150, 98, 140),
  ];

  const { viaHarness, viaScorer } = crossCheck(signal, forward, { halfSpread: 0.05 });
  assert.equal(viaHarness.status, "hit_sl");
  assert.equal(viaHarness.barsHeld, 1);
  assert.ok(
    viaHarness.mfeR < 1,
    `expected the post-resolution spike to be ignored, got ${viaHarness.mfeR}`,
  );
  assert.equal(viaHarness.mfeR, viaScorer.mfeR);
});

test("10. resolveSignalOutcome: barsHeld counts correctly for a trade resolving on the third bar", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stopLoss: 99,
    takeProfit1: 101.25,
    takeProfit2: 102,
  };
  const forward = [
    bar("2025-01-01T01:00:00.000Z", 100.3, 99.7, 100.1),
    bar("2025-01-01T02:00:00.000Z", 100.5, 99.6, 100.3),
    bar("2025-01-01T03:00:00.000Z", 101.4, 100.2, 101.3),
  ];

  const { viaHarness, viaScorer } = crossCheck(signal, forward, {
    halfSpread: 0.02,
    policy: "all_out",
  });
  assert.equal(viaHarness.status, "hit_tp1");
  assert.equal(viaHarness.barsHeld, 3);
  assert.equal(viaHarness.barsHeld, viaScorer.barsHeld);
});

test("worked example: an XAUUSD long the old mid-price rule scores a win, the new bid-aware rule scores a loss", () => {
  const signal = {
    pair: "XAUUSD",
    direction: "long" as const,
    entry: 3400,
    stopLoss: 3390,
    takeProfit1: 3412.5,
    takeProfit2: 3420,
  };
  const forward = [
    bar("2025-01-01T01:00:00.000Z", 3395, 3390.05, 3391),
    bar("2025-01-01T02:00:00.000Z", 3413, 3391, 3412.8),
  ];

  // Old rule: equivalent to mid-only comparison (zero spread).
  const oldRule = resolveSignalOutcome(signal, forward, { halfSpread: 0, policy: "all_out" });
  assert.equal(oldRule.status, "hit_tp1");
  assert.equal(oldRule.r, 1.25);

  // New rule: default lookup, costsFor("XAUUSD") = 0.20 spread => halfSpread 0.10.
  const newRule = resolveSignalOutcome(signal, forward);
  assert.equal(newRule.status, "hit_sl");
  assert.equal(newRule.r, -1);
  assert.equal(newRule.barsHeld, 1);
});

test("insufficient real data: the harness says so instead of emitting a rate", () => {
  const candles = buildWalkForwardCandles(80);
  const report = runRealBacktest({
    pair: "BTCUSD",
    mode: "intraday",
    timeframe: "H1",
    candles,
    strategyIds: ["ema_trend", "atr_expansion"],
  });

  assert.equal(report.sufficientData, false);
  assert.match(report.insufficiencyReason ?? "", /80 complete candles/);
  assert.equal(report.inSample, null);
  assert.equal(report.outOfSample, null);
  assert.deepEqual(report.trades, []);
});

test("walk-forward backtest: trades are non-overlapping, segmented correctly, and every rate carries a sample size", () => {
  const candles = buildWalkForwardCandles(400);
  const report = runRealBacktest({
    pair: "BTCUSD",
    mode: "intraday",
    timeframe: "H1",
    candles,
    strategyIds: [...ALL_ENGINE_STRATEGY_IDS],
  });

  assert.equal(report.sufficientData, true);
  assert.equal(report.completeCandles, 400);
  assert.equal(report.splitBarIndex, Math.floor(400 * 0.6));
  assert.ok(report.inSample);
  assert.ok(report.outOfSample);
  // A 400-bar zigzag with real trend/breakout strategies enabled should
  // produce at least a handful of signals to make the rest of this test
  // meaningful.
  assert.ok(report.trades.length > 0, "expected at least one recorded trade");

  // Every trade lands in the segment its own signal bar belongs to.
  for (const trade of report.trades) {
    if (trade.segment === "in_sample") {
      assert.ok(trade.signalBarIndex < report.splitBarIndex);
    } else {
      assert.ok(trade.signalBarIndex >= report.splitBarIndex);
    }
  }

  // Non-overlap invariant: sorted by signal bar, each trade starts strictly
  // after the previous trade resolved (or, if the previous trade was still
  // open when data ran out, the harness will have jumped the cursor forward
  // by the full lookahead window, which is likewise reflected here).
  const sorted = [...report.trades].sort((a, b) => a.signalBarIndex - b.signalBarIndex);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    assert.ok(current.signalBarIndex > previous.signalBarIndex);
    if (previous.resolutionBarIndex != null) {
      assert.ok(current.signalBarIndex > previous.resolutionBarIndex);
    }
  }

  // Confluence requires >= 2 agreeing strategies per signal (scanCandlesForSignal),
  // so the sum of per-strategy trade counts must be at least 2x the trade total.
  for (const segment of [report.inSample!, report.outOfSample!]) {
    const strategyTradeSum = segment.byStrategy.reduce((sum, entry) => sum + entry.trades, 0);
    assert.ok(strategyTradeSum >= segment.overall.trades * 2 || segment.overall.trades === 0);

    // Every rate is null (not a fabricated 0) when there is no resolved evidence.
    if (segment.overall.trades === 0) {
      assert.equal(segment.overall.winRate, null);
      assert.equal(segment.overall.expectancyR, null);
    }
    for (const entry of segment.byStrategy) {
      if (entry.wins + entry.losses === 0) {
        assert.equal(entry.winRate, null);
      } else {
        assert.ok(entry.winRate !== null && entry.winRate >= 0 && entry.winRate <= 100);
      }
      assert.equal(entry.trades, entry.wins + entry.losses + entry.open);
    }
  }

  assert.deepEqual(report.strategyIdsEvaluated, [...ALL_ENGINE_STRATEGY_IDS]);
});
