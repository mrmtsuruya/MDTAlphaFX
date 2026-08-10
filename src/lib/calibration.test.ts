import assert from "node:assert/strict";
import test from "node:test";
import {
  BIN_WIDTH,
  MIN_BIN_SAMPLES,
  buildCalibrationCurve,
  calibratedProbability,
  curveIsInformative,
  describeCalibration,
  poolAdjacentViolators,
  type ResolvedForCalibration,
} from "./calibration.ts";

/** n outcomes at one confluence level, `wins` of them reaching TP2. */
function batch(
  confluence: number,
  counts: { wins?: number; scratches?: number; losses?: number },
): ResolvedForCalibration[] {
  const out: ResolvedForCalibration[] = [];
  for (let i = 0; i < (counts.wins ?? 0); i += 1) out.push({ confluence, status: "hit_tp2" });
  for (let i = 0; i < (counts.scratches ?? 0); i += 1) out.push({ confluence, status: "hit_tp1" });
  for (let i = 0; i < (counts.losses ?? 0); i += 1) out.push({ confluence, status: "hit_sl" });
  return out;
}

// --- PAVA -------------------------------------------------------------------

test("poolAdjacentViolators leaves an already-monotone series untouched", () => {
  const fitted = poolAdjacentViolators([0.2, 0.4, 0.6], [10, 10, 10]);
  assert.deepEqual(fitted, [0.2, 0.4, 0.6]);
});

test("poolAdjacentViolators pools a violating pair into their weighted mean", () => {
  // 0.8 then 0.4 violates monotonicity; equal weights pool both to 0.6.
  const fitted = poolAdjacentViolators([0.8, 0.4], [10, 10]);
  assert.deepEqual(fitted, [0.6, 0.6]);
});

test("poolAdjacentViolators weights the pooled mean by sample size", () => {
  // 90 trades at 0.8 against 10 at 0.3 -> (0.8*90 + 0.3*10) / 100 = 0.75.
  const fitted = poolAdjacentViolators([0.8, 0.3], [90, 10]);
  assert.equal(+fitted[0].toFixed(4), 0.75);
  assert.equal(fitted[0], fitted[1]);
});

test("poolAdjacentViolators output is always non-decreasing", () => {
  const fitted = poolAdjacentViolators([0.9, 0.1, 0.5, 0.2, 0.95], [5, 20, 8, 30, 12]);
  for (let i = 1; i < fitted.length; i += 1) {
    assert.ok(fitted[i] >= fitted[i - 1] - 1e-9, `not monotone at ${i}: ${fitted.join(",")}`);
  }
});

test("poolAdjacentViolators handles an empty series", () => {
  assert.deepEqual(poolAdjacentViolators([], []), []);
});

// --- curve construction -----------------------------------------------------

test("bins are keyed by BIN_WIDTH and report their bounds", () => {
  const curve = buildCalibrationCurve(batch(72, { wins: 20, losses: 20 }));
  assert.equal(curve.bins.length, 1);
  assert.equal(curve.bins[0].lower, 70);
  assert.equal(curve.bins[0].upper, 70 + BIN_WIDTH - 1);
});

test("a thin bin reports insufficient and refuses to state a probability", () => {
  const curve = buildCalibrationCurve(batch(72, { wins: 3, losses: 1 }));
  const bin = curve.bins[0];
  assert.equal(bin.resolved, 4);
  assert.equal(bin.sufficient, false);
  assert.equal(bin.observedRate, null, "a 3-of-4 bucket must not print 75%");
  assert.equal(bin.calibratedRate, null);
  assert.equal(bin.avgR, null);
  assert.equal(curve.usable, false);
});

test("a bin at exactly MIN_BIN_SAMPLES is sufficient", () => {
  const curve = buildCalibrationCurve(
    batch(72, { wins: MIN_BIN_SAMPLES / 2, losses: MIN_BIN_SAMPLES / 2 }),
  );
  assert.equal(curve.bins[0].sufficient, true);
  assert.equal(curve.bins[0].observedRate, 0.5);
});

test("scratches count in the denominator but never as wins", () => {
  // 10 TP2, 10 breakeven, 10 stopped => 30 resolved, rate 10/30.
  const curve = buildCalibrationCurve(batch(72, { wins: 10, scratches: 10, losses: 10 }));
  const bin = curve.bins[0];
  assert.equal(bin.resolved, 30);
  assert.equal(bin.wins, 10);
  assert.equal(bin.scratches, 10);
  assert.equal(bin.losses, 10);
  assert.equal(bin.observedRate, +(10 / 30).toFixed(4));
  // R: 10 * 2 + 10 * 0 + 10 * -1 = 10, over 30 resolved.
  assert.equal(bin.avgR, +(10 / 30).toFixed(3));
});

test("unresolved and invalidated signals are excluded entirely", () => {
  const curve = buildCalibrationCurve([
    ...batch(72, { wins: 20, losses: 20 }),
    { confluence: 72, status: "invalidated" },
    { confluence: 72, status: "fresh" },
  ]);
  assert.equal(curve.bins[0].resolved, 40, "an expired signal says nothing about the score");
});

test("a non-finite confluence is skipped rather than creating a NaN bin", () => {
  const curve = buildCalibrationCurve([
    ...batch(72, { wins: 20, losses: 20 }),
    { confluence: Number.NaN, status: "hit_tp2" },
  ]);
  assert.equal(curve.bins.length, 1);
  assert.equal(curve.totalResolved, 40);
});

test("calibrated rates are monotone across bins even when observed rates are not", () => {
  const curve = buildCalibrationCurve([
    ...batch(62, { wins: 20, losses: 10 }), // observed 0.67 — out of order
    ...batch(72, { wins: 10, losses: 20 }), // observed 0.33
    ...batch(82, { wins: 25, losses: 5 }), // observed 0.83
  ]);
  const rates = curve.bins.map((bin) => bin.calibratedRate!);
  for (let i = 1; i < rates.length; i += 1) {
    assert.ok(rates[i] >= rates[i - 1] - 1e-9, `not monotone: ${rates.join(",")}`);
  }
  // The first two violate and pool; the third stands alone above them.
  assert.equal(rates[0], rates[1]);
  assert.ok(rates[2] > rates[1]);
});

test("thin bins are excluded from the isotonic fit so they cannot drag a good one", () => {
  const curve = buildCalibrationCurve([
    ...batch(62, { wins: 4, losses: 0 }), // 4 trades, 100% — must not influence anything
    ...batch(72, { wins: 15, losses: 15 }),
  ]);
  const thin = curve.bins.find((bin) => bin.lower === 60)!;
  const solid = curve.bins.find((bin) => bin.lower === 70)!;
  assert.equal(thin.calibratedRate, null);
  assert.equal(solid.calibratedRate, 0.5, "a 4-trade bin must not pull the fitted rate down");
});

// --- lookup and description -------------------------------------------------

test("calibratedProbability finds the bin containing the score", () => {
  const curve = buildCalibrationCurve(batch(72, { wins: 20, losses: 20 }));
  for (const confluence of [70, 72, 74]) {
    assert.equal(calibratedProbability(curve, confluence).sampleSize, 40, `for ${confluence}`);
  }
  assert.equal(calibratedProbability(curve, 69).sampleSize, 0, "69 belongs to the 65-69 bin");
});

test("an unseen confluence level reports zero samples, not a guess", () => {
  const curve = buildCalibrationCurve(batch(72, { wins: 20, losses: 20 }));
  const read = calibratedProbability(curve, 40);
  assert.equal(read.probability, null);
  assert.equal(read.sufficient, false);
  assert.match(describeCalibration(read), /no resolved history/i);
});

test("describeCalibration states the sample size instead of a percentage when thin", () => {
  const curve = buildCalibrationCurve(batch(72, { wins: 3, losses: 2 }));
  const text = describeCalibration(calibratedProbability(curve, 72));
  assert.match(text, /not enough to calibrate/i);
  assert.doesNotMatch(text, /%/, "must not print a percentage off 5 trades");
});

test("describeCalibration reports the rate, R and sample size once calibrated", () => {
  const curve = buildCalibrationCurve(batch(72, { wins: 30, losses: 10 }));
  const text = describeCalibration(calibratedProbability(curve, 72));
  assert.match(text, /75%/);
  assert.match(text, /n=40/);
  assert.match(text, /R avg/);
});

// --- the honesty check ------------------------------------------------------

test("curveIsInformative is null while there is too little to judge", () => {
  assert.equal(curveIsInformative(buildCalibrationCurve(batch(72, { wins: 3, losses: 1 }))), null);
});

test("a flat curve is reported as carrying no information", () => {
  // Every bucket resolves at the same rate: the score is not discriminating.
  const curve = buildCalibrationCurve([
    ...batch(62, { wins: 15, losses: 15 }),
    ...batch(72, { wins: 15, losses: 15 }),
    ...batch(82, { wins: 15, losses: 15 }),
  ]);
  assert.equal(curveIsInformative(curve), false);
});

test("a genuinely rising curve is reported as informative", () => {
  const curve = buildCalibrationCurve([
    ...batch(62, { wins: 6, losses: 24 }),
    ...batch(72, { wins: 15, losses: 15 }),
    ...batch(82, { wins: 24, losses: 6 }),
  ]);
  assert.equal(curveIsInformative(curve), true);
});

test("an empty record produces an empty, unusable curve rather than throwing", () => {
  const curve = buildCalibrationCurve([]);
  assert.deepEqual(curve.bins, []);
  assert.equal(curve.totalResolved, 0);
  assert.equal(curve.usable, false);
  assert.equal(curveIsInformative(curve), null);
});
