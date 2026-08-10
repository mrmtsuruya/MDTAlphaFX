import assert from "node:assert/strict";
import test from "node:test";
import { buildPerformanceReport, outcomeFromStatus, replaySignalPath } from "./signal-scorer.ts";

const CREATED_AT = "2025-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Side-aware touch detection: candles are mid prices, but a long's stop and
// target fill on the bid and a short's fill on the ask. These cases pin an
// explicit opts.halfSpread so the assertions are exact and independent of
// the costs.ts seed table.
// ---------------------------------------------------------------------------

test("1. core bug, long side: mid low sits above the stop but the bid low breaches it", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 99,
    take_profit_1: 101.25,
    take_profit_2: 102,
    created_at: CREATED_AT,
  };
  // Mid low (99.03) never trades through the 99 stop.
  const candles = [{ time: "2025-01-01T01:00:00.000Z", high: 99.5, low: 99.03, close: 99.2 }];

  const withSpread = replaySignalPath(signal, candles, { halfSpread: 0.05 });
  assert.equal(withSpread.status, "hit_sl");
  assert.equal(withSpread.r, -1);

  // Regression guard: the same bar under zero spread (equivalent to the old
  // mid-only rule) must NOT stop out. This is the bug that must never come back.
  const zeroSpread = replaySignalPath(signal, candles, { halfSpread: 0 });
  assert.notEqual(zeroSpread.status, "hit_sl");
});

test("2. core bug, short side: mid high sits below the stop but the ask high breaches it", () => {
  const signal = {
    pair: "EURUSD",
    direction: "short" as const,
    entry: 100,
    stop_loss: 101,
    take_profit_1: 98.75,
    take_profit_2: 98,
    created_at: CREATED_AT,
  };
  // Mid high (100.97) never trades through the 101 stop.
  const candles = [{ time: "2025-01-01T01:00:00.000Z", high: 100.97, low: 100.5, close: 100.8 }];

  const withSpread = replaySignalPath(signal, candles, { halfSpread: 0.05 });
  assert.equal(withSpread.status, "hit_sl");
  assert.equal(withSpread.r, -1);

  const zeroSpread = replaySignalPath(signal, candles, { halfSpread: 0 });
  assert.notEqual(zeroSpread.status, "hit_sl");
});

test("3. target under-fills: mid high clears TP1 but the bid high does not", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 99,
    take_profit_1: 101,
    take_profit_2: 102,
    created_at: CREATED_AT,
  };
  // Mid high (101.03) clears TP1 (101), but bid high = 101.03 - 0.05 = 100.98 does not.
  const candles = [{ time: "2025-01-01T01:00:00.000Z", high: 101.03, low: 100.5, close: 100.9 }];

  const withSpread = replaySignalPath(signal, candles, { halfSpread: 0.05 });
  assert.notEqual(withSpread.status, "hit_tp1");
  assert.equal(withSpread.status, "open");

  // Contrast: at zero spread the same bar DOES print TP1 — proves the
  // under-fill above is caused by the spread adjustment, not the fixture.
  const zeroSpread = replaySignalPath(signal, candles, { halfSpread: 0, policy: "all_out" });
  assert.equal(zeroSpread.status, "hit_tp1");
});

test("4. same-bar stop and target still resolves as the stop with spread applied", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 99,
    take_profit_1: 101,
    take_profit_2: 102,
    created_at: CREATED_AT,
  };
  const candles = [{ time: "2025-01-01T01:00:00.000Z", high: 103, low: 98, close: 100.5 }];

  const outcome = replaySignalPath(signal, candles, { halfSpread: 0.05 });
  assert.equal(outcome.status, "hit_sl");
  assert.equal(outcome.r, -1);
});

test("5. TP2 and TP1 touched on the same bar resolves as TP2", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 99,
    take_profit_1: 101,
    take_profit_2: 102,
    created_at: CREATED_AT,
  };
  const candles = [{ time: "2025-01-01T01:00:00.000Z", high: 102.5, low: 99.5, close: 102.3 }];

  const outcome = replaySignalPath(signal, candles, { halfSpread: 0.05 });
  assert.equal(outcome.status, "hit_tp2");
  assert.equal(outcome.r, 2);
});

// ---------------------------------------------------------------------------
// MAE / MFE and barsHeld.
// ---------------------------------------------------------------------------

test("6. maeR/mfeR on a clean winner: small maeR, mfeR at least the target's R", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 99,
    take_profit_1: 101.25,
    take_profit_2: 102,
    created_at: CREATED_AT,
  };
  const candles = [
    // Small pullback, nothing touched.
    { time: "2025-01-01T01:00:00.000Z", high: 100.3, low: 99.7, close: 100.2 },
    // Clean rally straight through TP2.
    { time: "2025-01-01T02:00:00.000Z", high: 102.5, low: 100.1, close: 102.3 },
  ];

  const outcome = replaySignalPath(signal, candles, { halfSpread: 0.02 });
  assert.equal(outcome.status, "hit_tp2");
  assert.ok(outcome.maeR < 0.5, `expected a small maeR, got ${outcome.maeR}`);
  assert.ok(outcome.mfeR >= 2, `expected mfeR at least the 2R target, got ${outcome.mfeR}`);
});

test("7. maeR on a trade that dipped hard against and still won is a positive magnitude", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 95,
    take_profit_1: 103.75,
    take_profit_2: 105,
    created_at: CREATED_AT,
  };
  const candles = [
    // Hard dip against the trade — well inside the wide stop, but a big adverse move.
    { time: "2025-01-01T01:00:00.000Z", high: 100.2, low: 96, close: 96.5 },
    // Recovers all the way to TP2.
    { time: "2025-01-01T02:00:00.000Z", high: 105.3, low: 100, close: 105.1 },
  ];

  const outcome = replaySignalPath(signal, candles, { halfSpread: 0.05 });
  assert.equal(outcome.status, "hit_tp2");
  // The key assertion: a trade that moved hard against the entry still
  // reports maeR as a POSITIVE magnitude, never negative.
  assert.ok(outcome.maeR > 0, `expected a positive maeR, got ${outcome.maeR}`);
  // The dip ran 4.05 of the 5-point stop distance: 4.05 / 5 = 0.81R adverse.
  assert.ok(outcome.maeR > 0.5, `expected the hard dip to register, got ${outcome.maeR}`);
});

test("8. maeR and mfeR are 0 when no forward candles exist", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 99,
    take_profit_1: 101.25,
    take_profit_2: 102,
    created_at: CREATED_AT,
  };
  const outcome = replaySignalPath(signal, [], { halfSpread: 0.05 });
  assert.equal(outcome.status, "open");
  assert.equal(outcome.maeR, 0);
  assert.equal(outcome.mfeR, 0);
  assert.equal(outcome.barsHeld, 0);
});

test("9. excursion after the resolution bar is excluded from mfeR", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 99,
    take_profit_1: 101.25,
    take_profit_2: 102,
    created_at: CREATED_AT,
  };
  const candles = [
    // Stops out on the first bar.
    { time: "2025-01-01T01:00:00.000Z", high: 99.5, low: 98.9, close: 99 },
    // Unremarkable filler bar the walk never reaches.
    { time: "2025-01-01T02:00:00.000Z", high: 99.6, low: 99.1, close: 99.4 },
    // Huge favourable spike two bars after the stop-out — must be ignored.
    { time: "2025-01-01T03:00:00.000Z", high: 150, low: 98, close: 140 },
  ];

  const outcome = replaySignalPath(signal, candles, { halfSpread: 0.05 });
  assert.equal(outcome.status, "hit_sl");
  assert.equal(outcome.barsHeld, 1);
  // If the spike leaked in, mfeR would be roughly (150 - h - 100) / 1 ≈ 49.9.
  assert.ok(
    outcome.mfeR < 1,
    `expected the post-resolution spike to be ignored, got ${outcome.mfeR}`,
  );
});

test("10. barsHeld counts correctly for a trade resolving on the third bar", () => {
  const signal = {
    pair: "EURUSD",
    direction: "long" as const,
    entry: 100,
    stop_loss: 99,
    take_profit_1: 101.25,
    take_profit_2: 102,
    created_at: CREATED_AT,
  };
  const candles = [
    { time: "2025-01-01T01:00:00.000Z", high: 100.3, low: 99.7, close: 100.1 },
    { time: "2025-01-01T02:00:00.000Z", high: 100.5, low: 99.6, close: 100.3 },
    { time: "2025-01-01T03:00:00.000Z", high: 101.4, low: 100.2, close: 101.3 },
  ];

  const outcome = replaySignalPath(signal, candles, { halfSpread: 0.02, policy: "all_out" });
  assert.equal(outcome.status, "hit_tp1");
  assert.equal(outcome.barsHeld, 3);
});

// ---------------------------------------------------------------------------
// Worked example: the exact size of the bias removed, using the real
// XAUUSD seed spread from costs.ts (no opts override — the default
// halfSpread(pair) lookup path).
// ---------------------------------------------------------------------------

test("worked example: an XAUUSD long the old mid-price rule scores a win, the new bid-aware rule scores a loss", () => {
  const signal = {
    pair: "XAUUSD",
    direction: "long" as const,
    entry: 3400,
    stop_loss: 3390,
    take_profit_1: 3412.5,
    take_profit_2: 3420,
    created_at: CREATED_AT,
  };
  const candles = [
    // Mid low (3390.05) sits just above the stop — the bid (mid - halfSpread)
    // trades straight through it. This is the exact defect being fixed.
    { time: "2025-01-01T01:00:00.000Z", high: 3395, low: 3390.05, close: 3391 },
    // Two bars later mid rallies to clear TP1 outright.
    { time: "2025-01-01T02:00:00.000Z", high: 3413, low: 3391, close: 3412.8 },
  ];

  // Old rule: equivalent to mid-only comparison (zero spread).
  const oldRule = replaySignalPath(signal, candles, { halfSpread: 0, policy: "all_out" });
  assert.equal(oldRule.status, "hit_tp1");
  assert.equal(oldRule.r, 1.25);

  // New rule: default lookup, costsFor("XAUUSD") = 0.20 spread => halfSpread 0.10.
  const newRule = replaySignalPath(signal, candles);
  assert.equal(newRule.status, "hit_sl");
  assert.equal(newRule.r, -1);
  assert.equal(newRule.barsHeld, 1);
});

// ---------------------------------------------------------------------------
// W6.1 — B-single execution model.
//
// A 0.01 lot cannot be halved, so "take 50% off at TP1" is unexecutable on this
// account. TP1 instead arms a breakeven stop and the whole position runs to
// TP2. The consequence that matters: a trade that tags TP1 and gives it all
// back is a SCRATCH, not the +1.25R win the all-out model booked.
// ---------------------------------------------------------------------------

const BS = {
  pair: "EURUSD",
  direction: "long" as const,
  entry: 100,
  stop_loss: 99,
  take_profit_1: 101.25,
  take_profit_2: 102,
  created_at: "2025-01-01T00:00:00.000Z",
};
const bsBar = (n: number, high: number, low: number, close: number) => ({
  time: `2025-01-01T0${n}:00:00.000Z`,
  high,
  low,
  close,
});

test("B-single: TP1 then a retrace through breakeven scratches at 0R", () => {
  const candles = [bsBar(1, 101.3, 100.1, 101.2), bsBar(2, 101.2, 99.5, 99.6)];
  const out = replaySignalPath(BS, candles, { halfSpread: 0 });
  assert.equal(out.status, "hit_tp1");
  assert.equal(out.r, 0);
});

test("B-single: the same trade under the legacy all-out policy still books +1.25R", () => {
  const candles = [bsBar(1, 101.3, 100.1, 101.2), bsBar(2, 101.2, 99.5, 99.6)];
  const out = replaySignalPath(BS, candles, { halfSpread: 0, policy: "all_out" });
  assert.equal(out.status, "hit_tp1");
  assert.equal(out.r, 1.25);
});

test("B-single: TP1 then on to TP2 pays the full +2R", () => {
  const candles = [bsBar(1, 101.3, 100.1, 101.2), bsBar(2, 102.1, 101.0, 102.05)];
  const out = replaySignalPath(BS, candles, { halfSpread: 0 });
  assert.equal(out.status, "hit_tp2");
  assert.equal(out.r, 2);
});

test("B-single: stopped before ever reaching TP1 is unchanged at -1R", () => {
  const out = replaySignalPath(BS, [bsBar(1, 100.4, 98.9, 99.0)], { halfSpread: 0 });
  assert.equal(out.status, "hit_sl");
  assert.equal(out.r, -1);
});

test("B-single: one bar spanning TP1 and TP2 resolves TP2", () => {
  const out = replaySignalPath(BS, [bsBar(1, 102.5, 100.1, 102.2)], { halfSpread: 0 });
  assert.equal(out.status, "hit_tp2");
});

test("B-single: the arming bar dipping back to breakeven does not resolve on that bar", () => {
  // Bar 1 tags TP1 and returns to entry. Intrabar order is unknowable, so the
  // trade must survive; bar 2 then takes the breakeven stop.
  const candles = [bsBar(1, 101.3, 99.95, 100.0), bsBar(2, 100.1, 99.9, 99.95)];
  const out = replaySignalPath(BS, candles, { halfSpread: 0 });
  assert.equal(out.status, "hit_tp1");
  assert.equal(out.r, 0);
  assert.equal(out.barsHeld, 2, "must not resolve on the bar that armed the stop");
});

test("B-single: after arming, a bar spanning breakeven and TP2 gives the stop priority", () => {
  const candles = [bsBar(1, 101.3, 100.5, 101.2), bsBar(2, 102.2, 99.8, 102.1)];
  const out = replaySignalPath(BS, candles, { halfSpread: 0 });
  assert.equal(out.status, "hit_tp1");
  assert.equal(out.r, 0);
});

test("B-single: buildPerformanceReport treats a breakeven exit as neither win nor loss", () => {
  const mk = (id: string, status: string) => ({
    signal: {
      id,
      pair: "EURUSD",
      direction: "long" as const,
      entry: 100,
      stop_loss: 99,
      take_profit_1: 101.25,
      take_profit_2: 102,
      contributing_strategies: ["ema_trend"],
      status,
      created_at: "2025-01-01T00:00:00.000Z",
    },
    outcome: outcomeFromStatus(status)!,
  });
  const report = buildPerformanceReport([
    mk("a", "hit_tp2"),
    mk("b", "hit_tp1"),
    mk("c", "hit_sl"),
  ]);
  assert.equal(report.resolved, 3, "the scratch still resolved");
  assert.equal(report.wins, 1);
  assert.equal(report.losses, 1);
  const strategy = report.byStrategy.find((s) => s.strategyId === "ema_trend")!;
  assert.equal(strategy.wins, 1);
  assert.equal(strategy.losses, 1);
  assert.equal(strategy.open, 0, "a breakeven exit is resolved, not open");
});
