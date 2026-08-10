import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_TRADES_FOR_DIAGNOSIS,
  analyseReplay,
  diagnoseLevels,
  excursionProfile,
  percentile,
  type ReplayTrade,
} from "./replay-analytics.ts";

function trade(overrides: Partial<ReplayTrade> = {}): ReplayTrade {
  return {
    confluence: 72,
    outcome: "hit_tp2",
    r: 2,
    maeR: 0.2,
    mfeR: 2.1,
    barsHeld: 5,
    ...overrides,
  };
}

function many(count: number, overrides: Partial<ReplayTrade> = {}): ReplayTrade[] {
  return Array.from({ length: count }, () => trade(overrides));
}

// --- percentile -------------------------------------------------------------

test("percentile returns null on an empty set rather than NaN", () => {
  assert.equal(percentile([], 0.5), null);
});

test("percentile of a single value is that value", () => {
  assert.equal(percentile([1.5], 0.9), 1.5);
});

test("percentile interpolates linearly between neighbours", () => {
  // p50 of [0,1,2,3] sits at position 1.5 => 1.5
  assert.equal(percentile([0, 1, 2, 3], 0.5), 1.5);
  assert.equal(percentile([0, 10], 0.25), 2.5);
});

test("percentile does not depend on input order", () => {
  assert.equal(percentile([3, 1, 0, 2], 0.5), percentile([0, 1, 2, 3], 0.5));
});

test("percentile clamps p outside [0,1]", () => {
  assert.equal(percentile([1, 2, 3], -5), 1);
  assert.equal(percentile([1, 2, 3], 5), 3);
});

// --- excursion profile ------------------------------------------------------

test("open trades are excluded from every statistic", () => {
  const profile = excursionProfile([
    ...many(MIN_TRADES_FOR_DIAGNOSIS, { outcome: "hit_tp2" }),
    ...many(10, { outcome: "open", r: 0.3 }),
  ]);
  assert.equal(profile.trades, MIN_TRADES_FOR_DIAGNOSIS);
  assert.equal(profile.winners, MIN_TRADES_FOR_DIAGNOSIS);
});

test("a thin sample reports insufficient and withholds every percentile", () => {
  const profile = excursionProfile(many(MIN_TRADES_FOR_DIAGNOSIS - 1));
  assert.equal(profile.sufficient, false);
  assert.equal(profile.loserMfe.p50, null);
  assert.equal(profile.winnerMae.p50, null);
  assert.equal(profile.losersReaching1R, null);
  assert.equal(profile.medianBarsHeld, null);
});

test("exactly MIN_TRADES_FOR_DIAGNOSIS flips it to sufficient", () => {
  assert.equal(excursionProfile(many(MIN_TRADES_FOR_DIAGNOSIS)).sufficient, true);
});

test("outcome buckets are counted separately", () => {
  const profile = excursionProfile([
    ...many(15, { outcome: "hit_tp2" }),
    ...many(10, { outcome: "hit_tp1", r: 0 }),
    ...many(12, { outcome: "hit_sl", r: -1 }),
  ]);
  assert.equal(profile.winners, 15);
  assert.equal(profile.scratches, 10);
  assert.equal(profile.losers, 12);
  assert.equal(profile.trades, 37);
});

test("loser MFE percentiles are drawn from stopped-out trades only", () => {
  const profile = excursionProfile([
    // Winners with huge MFE must not leak into the loser distribution.
    ...many(20, { outcome: "hit_tp2", mfeR: 9 }),
    ...many(20, { outcome: "hit_sl", r: -1, mfeR: 0.5 }),
  ]);
  assert.equal(profile.loserMfe.p50, 0.5);
});

test("winner MAE percentiles are drawn from winning trades only", () => {
  const profile = excursionProfile([
    ...many(20, { outcome: "hit_tp2", maeR: 0.3 }),
    ...many(20, { outcome: "hit_sl", r: -1, maeR: 1 }),
  ]);
  assert.equal(profile.winnerMae.p50, 0.3);
});

test("losersReaching1R measures the share that ran to target before dying", () => {
  const profile = excursionProfile([
    ...many(15, { outcome: "hit_sl", r: -1, mfeR: 1.2 }),
    ...many(15, { outcome: "hit_sl", r: -1, mfeR: 0.1 }),
  ]);
  assert.equal(profile.losersReaching1R, 0.5);
});

test("losersReaching1R is null when there are no losers to measure", () => {
  const profile = excursionProfile(many(40, { outcome: "hit_tp2" }));
  assert.equal(profile.losersReaching1R, null);
});

// --- findings ---------------------------------------------------------------

test("a thin sample yields exactly one insufficient-data finding", () => {
  const findings = diagnoseLevels(excursionProfile(many(5)));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "insufficient_data");
  assert.match(findings[0].message, /need 30/);
});

test("losers routinely reaching 1R raises tp1_too_far", () => {
  const findings = diagnoseLevels(
    excursionProfile([
      ...many(25, { outcome: "hit_sl", r: -1, mfeR: 1.15 }),
      ...many(10, { outcome: "hit_tp2", maeR: 0.1 }),
    ]),
  );
  const finding = findings.find((f) => f.id === "tp1_too_far");
  assert.ok(finding, `expected tp1_too_far, got ${findings.map((f) => f.id).join(",")}`);
  assert.equal(finding!.severity, "warn");
});

test("winners routinely dipping deep raises stop_inside_noise", () => {
  const findings = diagnoseLevels(
    excursionProfile([
      ...many(30, { outcome: "hit_tp2", maeR: 0.9 }),
      ...many(5, { outcome: "hit_sl", r: -1, mfeR: 0.1 }),
    ]),
  );
  assert.ok(findings.some((f) => f.id === "stop_inside_noise"));
});

test("healthy distributions report that the levels look reasonable", () => {
  const findings = diagnoseLevels(
    excursionProfile([
      ...many(20, { outcome: "hit_tp2", maeR: 0.15, mfeR: 2.2 }),
      ...many(20, { outcome: "hit_sl", r: -1, maeR: 1, mfeR: 0.2 }),
    ]),
  );
  assert.deepEqual(
    findings.map((f) => f.id),
    ["targets_look_reasonable"],
  );
});

test("both problems can be reported at once", () => {
  const findings = diagnoseLevels(
    excursionProfile([
      ...many(20, { outcome: "hit_sl", r: -1, mfeR: 1.3 }),
      ...many(20, { outcome: "hit_tp2", maeR: 0.95 }),
    ]),
  );
  const ids = findings.map((f) => f.id).sort();
  assert.deepEqual(ids, ["stop_inside_noise", "tp1_too_far"]);
});

// --- end to end -------------------------------------------------------------

test("analyseReplay calibrates on the same outcome labels the live record uses", () => {
  const analytics = analyseReplay([
    ...many(20, { confluence: 82, outcome: "hit_tp2" }),
    ...many(20, { confluence: 62, outcome: "hit_sl", r: -1 }),
  ]);
  const high = analytics.calibration.bins.find((bin) => bin.lower === 80)!;
  const low = analytics.calibration.bins.find((bin) => bin.lower === 60)!;
  assert.equal(high.observedRate, 1);
  assert.equal(low.observedRate, 0);
  assert.equal(analytics.excursions.trades, 40);
  assert.ok(analytics.findings.length > 0);
});

test("analyseReplay excludes open trades from calibration too", () => {
  const analytics = analyseReplay([
    ...many(20, { confluence: 72, outcome: "hit_tp2" }),
    ...many(50, { confluence: 72, outcome: "open", r: 0.4 }),
  ]);
  assert.equal(analytics.calibration.totalResolved, 20);
});

test("an empty replay produces empty analytics rather than throwing", () => {
  const analytics = analyseReplay([]);
  assert.equal(analytics.calibration.totalResolved, 0);
  assert.equal(analytics.excursions.trades, 0);
  assert.equal(analytics.findings[0].id, "insufficient_data");
});
