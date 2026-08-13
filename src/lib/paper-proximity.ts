// Proximity + hold-odds math for the signal autopsy.
//
// "Will it still hold until TP1?" is answered with the owner's own resolved
// ledger: trades are binned by how far they traveled toward TP1 (from their
// recorded MFE in R) and the observed rate at which each bucket actually
// reached TP1 is reported. Pure, no I/O.

import type { PaperSignalListItem } from "./xauusd-paper-view.ts";

export type HoldBucket = {
  /** Distance toward TP1 in percent (50 = halfway). */
  thresholdPct: number;
  /** Resolved trades that reached at least this far toward TP1. */
  reached: number;
  /** Of those, how many actually touched TP1. */
  hitTp1: number;
  /** hitTp1 / reached; null when the bucket is empty. */
  hitRate: number | null;
};

export const HOLD_THRESHOLDS_PCT = [50, 75, 90] as const;

/** R distance from entry to TP1 (the excursion that counts as "reached"). */
export function tp1DistanceR(signal: Pick<PaperSignalListItem, "entry" | "stopLoss" | "takeProfit1">): number | null {
  const risk = Math.abs(signal.entry - signal.stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  return Math.abs(signal.takeProfit1 - signal.entry) / risk;
}

function isResolved(
  signal: PaperSignalListItem,
): signal is PaperSignalListItem & { trade: { mfeR: number; resultR: number } } {
  return signal.trade.mfeR != null && signal.trade.resultR != null;
}

/**
 * For every threshold, of the resolved trades on this pair+timeframe that
 * traveled at least threshold% of the way to TP1, how many went on to touch
 * TP1? The answer is the ledger's own estimate of "will it hold".
 */
export function computeHoldStats(
  signals: PaperSignalListItem[],
  pair: string,
  timeframe: string,
): HoldBucket[] {
  const resolved = signals.filter(
    (s): s is PaperSignalListItem & { trade: { mfeR: number; resultR: number } } =>
      s.pair === pair && s.timeframe === timeframe && isResolved(s),
  );
  return HOLD_THRESHOLDS_PCT.map((thresholdPct) => {
    const threshold = thresholdPct / 100;
    const reached = resolved.filter((s) => {
      const dist = tp1DistanceR(s);
      return dist != null && s.trade.mfeR >= threshold * dist;
    });
    const hit = reached.filter((s) => {
      const dist = tp1DistanceR(s);
      return dist != null && s.trade.mfeR >= dist;
    });
    return {
      thresholdPct,
      reached: reached.length,
      hitTp1: hit.length,
      hitRate: reached.length > 0 ? hit.length / reached.length : null,
    };
  });
}

export type OpenTradeMeters = {
  /** Signed R distance from current price to TP1 (positive = still reachable). */
  toTp1R: number;
  /** Signed R distance from current price to SL (positive = buffer). */
  toSlR: number;
  /** $ distance to TP1 at the fixed 0.01 lot (1 oz, $1 per $1 move). */
  toTp1Usd: number;
  /** Current favorable excursion as a percent of the full entry→TP1 distance. */
  progressPct: number | null;
};

/**
 * Live meters for an open trade: how far TP1 and SL are, in R and $, and the
 * current progress toward TP1. Null when no quote is available.
 */
export function openTradeMeters(
  signal: Pick<PaperSignalListItem, "direction" | "entry" | "stopLoss" | "takeProfit1">,
  current: number | null,
): OpenTradeMeters | null {
  if (current == null || !Number.isFinite(current)) return null;
  const dir = signal.direction === "long" ? 1 : -1;
  const risk = Math.abs(signal.entry - signal.stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) return null;
  const toTp1 = dir * (signal.takeProfit1 - current);
  const toSl = dir * (current - signal.stopLoss);
  const excursion = dir * (current - signal.entry);
  const tp1Dist = Math.abs(signal.takeProfit1 - signal.entry);
  return {
    toTp1R: toTp1 / risk,
    toSlR: toSl / risk,
    toTp1Usd: toTp1 * 0.01 * 100,
    progressPct: tp1Dist > 0 ? Math.max(0, Math.min(1, excursion / tp1Dist)) * 100 : null,
  };
}
