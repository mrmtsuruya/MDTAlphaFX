// Location scoring: where inside its own recent range an entry sits, not
// just what the indicators say about it. Two setups with identical
// confluence can be opposite trades in disguise — an EMA-long vote fires
// the same whether price is at the bottom of a 60-bar range or already
// stretched to the top of one. The vote is blind to that; this module is
// the eye.
//
// A continuous multiplier (0.6x .. 1.25x on confluence), never a gate. A
// great setup at a bad location still fires — visibly discounted and
// labelled "chasing" — rather than silently withheld. Filtering signals out
// hides the very pattern (buying tops, selling bottoms) this exists to
// surface.
//
// Client-safe: no server imports, no I/O. Imported by signal-engine.ts, so
// this uses a relative "./"-prefixed import with an explicit .ts extension
// — same reason chart-overlays.ts / mtf-engine.ts / signal-learning.ts /
// strategy-weights.ts do: this module is exercised under `node --test`,
// which resolves neither the "@/" alias nor extensionless imports.
import { clamp, emaSeries, findSwingPoints, type SignalEngineCandle } from "./signal-engine.ts";

export type LocationLabel =
  | "deep discount"
  | "discount"
  | "equilibrium"
  | "premium"
  | "extended premium";

export type LocationRead = {
  /** 0 = at the swing low, 1 = at the swing high, 0.5 = equilibrium. */
  swingPosition: number;
  /** Signed ATR distance of close from EMA21. Positive = above the mean. */
  meanDistanceAtr: number;
  /** ATR distance to the nearest opposing structure level ahead of the trade; null when none found. */
  headroomAtr: number | null;
  /** 0..1 — how good this location is FOR THE GIVEN DIRECTION. */
  score: number;
  /** 0.6 .. 1.25 multiplier applied to confluence. */
  multiplier: number;
  label: LocationLabel;
  /** True when entering against location badly enough to call it a chase. */
  chasing: boolean;
  swing: { highIndex: number; highPrice: number; lowIndex: number; lowPrice: number };
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Reads where `candles`' latest close sits inside its own recent swing range
 * and scores that location for `direction`. Returns null when there is not
 * enough history to define a range, or the range is degenerate (dead-flat —
 * no location is "good" or "bad" inside a range that never moved).
 */
export function readLocation(
  candles: SignalEngineCandle[],
  direction: "long" | "short",
  atr: number,
  lookback = 60,
): LocationRead | null {
  const complete = candles.filter((candle) => candle.complete);
  if (complete.length < lookback) return null;

  // Dominant swing: the extremes of the last `lookback` bars, not the whole
  // history — location is relative to the range price is CURRENTLY inside,
  // which ages out as new bars push the window forward.
  const offset = complete.length - lookback;
  const window = complete.slice(offset);
  let highIndex = offset;
  let highPrice = window[0].high;
  let lowIndex = offset;
  let lowPrice = window[0].low;
  for (let i = 0; i < window.length; i += 1) {
    const candle = window[i];
    // >= / <= (not > / <): the LAST bar to touch an extreme owns it, so a
    // retest reads as re-establishing the current extreme, not the first
    // touch that happened to arrive earlier in the window.
    if (candle.high >= highPrice) {
      highPrice = candle.high;
      highIndex = offset + i;
    }
    if (candle.low <= lowPrice) {
      lowPrice = candle.low;
      lowIndex = offset + i;
    }
  }
  if (highPrice === lowPrice) return null; // dead-flat window: no location to read

  const close = complete.at(-1)!.close;
  const swingPosition = clamp((close - lowPrice) / (highPrice - lowPrice), 0, 1);

  // Long wants the low, short wants the high — the same swingPosition reads
  // opposite ways depending which side of the trade you're asking for.
  const f = direction === "long" ? 1 - swingPosition : swingPosition;

  const closes = complete.map((candle) => candle.close);
  const ema21 = emaSeries(closes, 21).at(-1)!;
  const meanDistanceAtr = (close - ema21) / atr;

  // Only distance ALREADY run in the trade's own direction counts against
  // it — that's exhausted supply/demand, not confirmation. A pullback
  // toward the mean ahead of an entry the other way isn't penalized here.
  const adverse =
    direction === "long" ? Math.max(0, meanDistanceAtr) : Math.max(0, -meanDistanceAtr);
  const meanTerm = clamp(1 - adverse / 3, 0, 1);

  // Structure ahead of the trade caps how far it can run before the next
  // likely reaction. Uses the full available history (not just the
  // lookback window) because a level worth respecting can predate the
  // current range.
  const swings = findSwingPoints(complete, 2);
  let headroomAtr: number | null = null;
  if (direction === "long") {
    const above = swings.filter((swing) => swing.kind === "high" && swing.price > close);
    if (above.length > 0) {
      const level = Math.min(...above.map((swing) => swing.price));
      headroomAtr = (level - close) / atr;
    }
  } else {
    const below = swings.filter((swing) => swing.kind === "low" && swing.price < close);
    if (below.length > 0) {
      const level = Math.max(...below.map((swing) => swing.price));
      headroomAtr = (close - level) / atr;
    }
  }
  // No level found isn't "clear air to run forever" — it's simply unknown,
  // since it may sit outside the candle history this scan can see. Neutral,
  // not free marks.
  const headroomTerm = headroomAtr === null ? 0.5 : clamp(headroomAtr / 2, 0, 1);

  // 0.55/0.25/0.20: raw location dominates the read; mean-distance and
  // headroom refine it rather than override it.
  const score = round3(clamp(0.55 * f + 0.25 * meanTerm + 0.2 * headroomTerm, 0, 1));
  const multiplier = round3(0.6 + score * 0.65);
  // f below 0.3 means the entry sits on the worst 30% of the range for its
  // own direction — close enough to the adverse extreme to name it a chase
  // rather than treat it as an ordinary low-scoring location.
  const chasing = f < 0.3;

  let label: LocationLabel;
  if (swingPosition <= 0.2) label = "deep discount";
  else if (swingPosition <= 0.4) label = "discount";
  else if (swingPosition < 0.6) label = "equilibrium";
  else if (swingPosition < 0.8) label = "premium";
  else label = "extended premium";

  return {
    swingPosition: round3(swingPosition),
    meanDistanceAtr: round3(meanDistanceAtr),
    headroomAtr: headroomAtr === null ? null : round3(headroomAtr),
    score,
    multiplier,
    label,
    chasing,
    swing: { highIndex, highPrice, lowIndex, lowPrice },
  };
}

/** One-line summary for signal cards / rationale text. */
export function describeLocation(read: LocationRead, direction: "long" | "short"): string {
  const headroomText =
    read.headroomAtr === null
      ? "headroom unclear beyond this range"
      : `${read.headroomAtr.toFixed(1)} ATR of headroom`;
  const chaseText = read.chasing ? "chasing extension, " : "";
  return `${direction.toUpperCase()} at ${read.swingPosition.toFixed(2)} of the swing range (${read.label}) — ${chaseText}${headroomText}.`;
}
