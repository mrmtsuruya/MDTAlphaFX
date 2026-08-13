// buildAuditRunRows regression fixture: the edge function wrote ZERO rows in
// production because the report keys are inSample/outOfSample while the DB
// segment enum is in_sample/out_of_sample — and the mapping lived inside I/O
// code where no test could see it. This pins the mapping: segments map, both
// sides write, insufficient reports write nothing, and the window comes from
// the trades.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAuditRunRows } from "./strategy-audit-mapper.ts";
import type { RealBacktestReport } from "./real-backtest.ts";

function stat(label: string, trades: number, wins: number, losses: number, totalR: number) {
  return {
    label,
    trades,
    wins,
    scratches: 0,
    losses,
    open: 0,
    winRate: trades > 0 ? (wins / trades) * 100 : null,
    totalR,
    expectancyR: trades > 0 ? totalR / trades : null,
    maxDrawdownR: 0,
  };
}

function report(over: Partial<RealBacktestReport> = {}): RealBacktestReport {
  return {
    pair: "XAUUSD",
    mode: "scalper",
    timeframe: "M15",
    strategyIdsEvaluated: ["ema_trend", "donchian_break"],
    totalCandles: 720,
    completeCandles: 718,
    splitBarIndex: 430,
    sufficientData: true,
    insufficiencyReason: null,
    inSample: {
      segment: "in_sample",
      fromBarIndex: 0,
      toBarIndex: 430,
      overall: stat("overall", 10, 3, 5, 1.0),
      byStrategy: [stat("ema_trend", 6, 2, 3, 1.0), stat("donchian_break", 2, 2, 0, 4.0)],
    },
    outOfSample: {
      segment: "out_of_sample",
      fromBarIndex: 431,
      toBarIndex: 717,
      overall: stat("overall", 10, 3, 6, -1.0),
      byStrategy: [stat("ema_trend", 4, 1, 3, -1.0)],
    },
    trades: [
      { signalTime: "2026-08-01T00:00:00Z" } as never,
      { signalTime: "2026-08-13T12:00:00Z" } as never,
    ],
    analytics: {} as never,
    generatedAt: "2026-08-14T00:00:00.000Z",
    notes: ["fixture"],
    ...over,
  };
}

const RUN_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

describe("buildAuditRunRows", () => {
  it("maps both segments with the DB enum and the correct strategy stats", () => {
    const rows = buildAuditRunRows({ report: report(), runId: RUN_ID, userId: USER_ID });
    assert.equal(rows.length, 3); // 2 in-sample + 1 out-of-sample
    const inSample = rows.filter((r) => r.segment === "in_sample");
    const outOfSample = rows.filter((r) => r.segment === "out_of_sample");
    assert.equal(inSample.length, 2);
    assert.equal(outOfSample.length, 1);
    const ema = inSample.find((r) => r.strategy_id === "ema_trend")!;
    assert.equal(ema.run_id, RUN_ID);
    assert.equal(ema.user_id, USER_ID);
    assert.equal(ema.resolved, 6);
    assert.equal(ema.wins, 2);
    assert.equal(ema.losses, 3);
    assert.equal(ema.win_rate, (2 / 6) * 100);
    assert.equal(ema.total_r, 1.0);
    assert.equal(ema.window_start, "2026-08-01T00:00:00Z");
    assert.equal(ema.window_end, "2026-08-13T12:00:00Z");
    assert.deepEqual(ema.notes, ["fixture"]);
  });

  it("an insufficient report (null segments) writes no rows", () => {
    const rows = buildAuditRunRows({
      report: report({ inSample: null, outOfSample: null, sufficientData: false }),
      runId: RUN_ID,
      userId: USER_ID,
    });
    assert.equal(rows.length, 0);
  });

  it("a strategy with zero resolved trades still writes its row with a null rate", () => {
    const fixture = report();
    fixture.inSample!.byStrategy = [stat("qullamaggie_breakout", 0, 0, 0, 0)];
    const rows = buildAuditRunRows({ report: fixture, runId: RUN_ID, userId: USER_ID });
    const row = rows.find((r) => r.strategy_id === "qullamaggie_breakout")!;
    assert.ok(row);
    assert.equal(row.resolved, 0);
    assert.equal(row.win_rate, null);
    assert.equal(row.expectancy_r, null);
  });
});
