// Confluence calibration.
//
// The engine reports a confluence number. Nothing has ever checked whether it
// MEANS anything — whether a 78 actually resolves better than a 62. This module
// answers that from the resolved record and nothing else: bucket the outcomes by
// the confluence they were issued at, measure what each bucket really did, and
// fit a monotone curve mapping the score to an observed probability.
//
// Two deliberate design choices:
//
//   1. NO GATING. Nothing here filters, blocks or downweights a signal. It is
//      purely a truth-teller, so the UI can print "72 → 58% historical, n=214"
//      instead of an uncalibrated number the user has no way to interpret.
//   2. IT REFUSES TO GUESS. Below MIN_BIN_SAMPLES a bucket reports
//      `sufficient: false` and no probability at all. An invented percentage on
//      nine trades is worse than an honest blank — it looks like knowledge.
//
// Under B-single a `hit_tp1` is the breakeven exit: resolved, but neither a win
// nor a loss (see R_OF_STATUS in order-ticket.ts). It therefore counts in the
// denominator — a score that keeps producing round trips to nowhere should not
// look identical to one that reaches TP2 — while contributing nothing to the
// numerator. Excluding scratches entirely would flatter every bucket.
//
// Client-safe: pure functions over already-fetched rows, no I/O.

import { R_OF_STATUS } from "./order-ticket.ts";

/** Width of a confluence bucket, in confluence points. */
export const BIN_WIDTH = 5;

/**
 * Minimum resolved outcomes before a bucket is allowed to report a probability.
 * 20 is not a statistical guarantee — it is the point below which the number
 * would be actively misleading. A 3-of-4 bucket "75%" has a 95% interval of
 * roughly 19%–99%.
 */
export const MIN_BIN_SAMPLES = 20;

export type CalibrationBin = {
  /** Inclusive lower bound of the bucket, e.g. 70 for the 70–74 bin. */
  lower: number;
  upper: number;
  resolved: number;
  wins: number;
  scratches: number;
  losses: number;
  /** Observed wins / resolved. Null when the bucket is too thin to report. */
  observedRate: number | null;
  /** Isotonic-smoothed rate — monotone across bins. Null when insufficient. */
  calibratedRate: number | null;
  /** Mean R over the bucket's resolved outcomes. Null when insufficient. */
  avgR: number | null;
  sufficient: boolean;
};

export type CalibrationCurve = {
  bins: CalibrationBin[];
  totalResolved: number;
  /** True when at least one bin cleared MIN_BIN_SAMPLES. */
  usable: boolean;
};

export type ResolvedForCalibration = {
  confluence: number;
  status: string;
};

function binLower(confluence: number): number {
  return Math.floor(confluence / BIN_WIDTH) * BIN_WIDTH;
}

/**
 * Pool Adjacent Violators — the standard isotonic fit.
 *
 * Raw bucket rates are noisy and will not be monotone: a 65–69 bin can easily
 * out-perform 70–74 on small samples. Forcing monotonicity is the right prior
 * here because the whole claim under test is "higher confluence should mean a
 * better outcome". Where the data violates that, PAVA pools the offending
 * neighbours into one flat segment — which is itself informative: a long flat
 * run means the score carries no information across that range.
 *
 * Weighted by each bin's sample count so a 200-trade bucket is not overruled
 * by a 25-trade one.
 */
export function poolAdjacentViolators(values: number[], weights: number[]): number[] {
  if (values.length === 0) return [];
  // Each block holds a pooled mean plus the total weight behind it.
  const blocks: { sum: number; weight: number; count: number }[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const weight = weights[i] > 0 ? weights[i] : 0;
    blocks.push({ sum: values[i] * weight, weight, count: 1 });
    // Collapse backwards while the previous block sits above this one.
    while (blocks.length > 1) {
      const current = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      const currentMean = current.weight > 0 ? current.sum / current.weight : 0;
      const previousMean = previous.weight > 0 ? previous.sum / previous.weight : 0;
      if (previousMean <= currentMean) break;
      blocks.splice(blocks.length - 2, 2, {
        sum: previous.sum + current.sum,
        weight: previous.weight + current.weight,
        count: previous.count + current.count,
      });
    }
  }
  const out: number[] = [];
  for (const block of blocks) {
    const mean = block.weight > 0 ? block.sum / block.weight : 0;
    for (let i = 0; i < block.count; i += 1) out.push(mean);
  }
  return out;
}

/**
 * Build the reliability curve from resolved signals.
 *
 * `wins` is TP2 only. `scratches` (breakeven exits after TP1) sit in the
 * denominator but not the numerator — see the note at the top of this file.
 */
export function buildCalibrationCurve(signals: ResolvedForCalibration[]): CalibrationCurve {
  const buckets = new Map<
    number,
    { wins: number; scratches: number; losses: number; totalR: number }
  >();

  for (const signal of signals) {
    const r = R_OF_STATUS[signal.status];
    // Only terminal outcomes calibrate anything. `invalidated` expired without
    // ever being tested by the market, so it says nothing about the score.
    if (signal.status !== "hit_tp2" && signal.status !== "hit_tp1" && signal.status !== "hit_sl") {
      continue;
    }
    if (!Number.isFinite(signal.confluence)) continue;
    const lower = binLower(signal.confluence);
    const bucket = buckets.get(lower) ?? { wins: 0, scratches: 0, losses: 0, totalR: 0 };
    if (signal.status === "hit_tp2") bucket.wins += 1;
    else if (signal.status === "hit_tp1") bucket.scratches += 1;
    else bucket.losses += 1;
    bucket.totalR += r ?? 0;
    buckets.set(lower, bucket);
  }

  const lowers = [...buckets.keys()].sort((a, b) => a - b);
  const bins: CalibrationBin[] = lowers.map((lower) => {
    const bucket = buckets.get(lower)!;
    const resolved = bucket.wins + bucket.scratches + bucket.losses;
    const sufficient = resolved >= MIN_BIN_SAMPLES;
    return {
      lower,
      upper: lower + BIN_WIDTH - 1,
      resolved,
      wins: bucket.wins,
      scratches: bucket.scratches,
      losses: bucket.losses,
      observedRate: sufficient ? +(bucket.wins / resolved).toFixed(4) : null,
      calibratedRate: null,
      avgR: sufficient ? +(bucket.totalR / resolved).toFixed(3) : null,
      sufficient,
    };
  });

  // Isotonic runs over the sufficient bins only. Feeding a 4-trade bucket into
  // the fit would let noise drag a well-sampled neighbour with it.
  const usableBins = bins.filter((bin) => bin.sufficient);
  if (usableBins.length > 0) {
    const fitted = poolAdjacentViolators(
      usableBins.map((bin) => bin.observedRate ?? 0),
      usableBins.map((bin) => bin.resolved),
    );
    usableBins.forEach((bin, index) => {
      bin.calibratedRate = +fitted[index].toFixed(4);
    });
  }

  return {
    bins,
    totalResolved: bins.reduce((sum, bin) => sum + bin.resolved, 0),
    usable: usableBins.length > 0,
  };
}

export type CalibratedRead = {
  confluence: number;
  /** Calibrated probability of reaching TP2, or null when unknown. */
  probability: number | null;
  avgR: number | null;
  sampleSize: number;
  sufficient: boolean;
};

/** Look a confluence score up against the curve. */
export function calibratedProbability(curve: CalibrationCurve, confluence: number): CalibratedRead {
  const lower = binLower(confluence);
  const bin = curve.bins.find((candidate) => candidate.lower === lower);
  if (!bin) {
    return { confluence, probability: null, avgR: null, sampleSize: 0, sufficient: false };
  }
  return {
    confluence,
    probability: bin.calibratedRate,
    avgR: bin.avgR,
    sampleSize: bin.resolved,
    sufficient: bin.sufficient,
  };
}

/**
 * One line for the UI. Says "not enough data" plainly rather than dressing a
 * thin sample up as a percentage — the entire point of this module.
 */
export function describeCalibration(read: CalibratedRead): string {
  if (!read.sufficient || read.probability === null) {
    return read.sampleSize > 0
      ? `confluence ${read.confluence} — only ${read.sampleSize} resolved at this level, not enough to calibrate`
      : `confluence ${read.confluence} — no resolved history at this level yet`;
  }
  const percent = Math.round(read.probability * 100);
  const r = read.avgR !== null ? `, ${read.avgR >= 0 ? "+" : ""}${read.avgR.toFixed(2)}R avg` : "";
  return `confluence ${read.confluence} → ${percent}% reached TP2 historically${r} (n=${read.sampleSize})`;
}

/**
 * Does the score carry information at all?
 *
 * If the calibrated curve is flat across every sufficient bin, confluence is
 * not discriminating between good and bad setups, and the honest thing is to
 * say so rather than keep printing a number. Returns null while there is too
 * little data to judge either way.
 */
export function curveIsInformative(curve: CalibrationCurve): boolean | null {
  const rates = curve.bins
    .filter((bin) => bin.sufficient && bin.calibratedRate !== null)
    .map((bin) => bin.calibratedRate as number);
  if (rates.length < 2) return null;
  return Math.max(...rates) - Math.min(...rates) >= 0.05;
}
