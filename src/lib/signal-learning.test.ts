import assert from "node:assert/strict";
import test from "node:test";
import { buildLearningReport, buildSignalAutopsy } from "./signal-learning.ts";

const base = {
  pair: "XAUUSD",
  direction: "long" as const,
  mode: "intraday",
  timeframe: "H1",
  confluence: 70,
  contributing_strategies: ["ema_trend"],
  created_at: "2026-08-01T00:00:00.000Z",
};

test("B-single scratch is resolved but never counted as a win or loss", () => {
  const report = buildLearningReport(
    [
      { ...base, id: "tp2", status: "hit_tp2" },
      { ...base, id: "be", status: "hit_tp1" },
      { ...base, id: "sl", status: "hit_sl" },
    ],
    Date.parse("2026-08-02T00:00:00.000Z"),
  );
  assert.equal(report.resolved, 3);
  assert.equal(report.wins, 1);
  assert.equal(report.losses, 1);
  assert.equal(report.winRate, 33);
  assert.equal(report.totalR, 1);
});

test("B-single scratch autopsy says breakeven and 0R", () => {
  const autopsy = buildSignalAutopsy({ ...base, id: "be", status: "hit_tp1" });
  assert.equal(autopsy?.r, 0);
  assert.match(autopsy?.headline ?? "", /breakeven|scratch/i);
  assert.doesNotMatch(JSON.stringify(autopsy), /1\.25R|winner/i);
});
