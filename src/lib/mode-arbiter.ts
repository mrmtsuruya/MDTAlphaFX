// Mode arbitration: what the market is offering right now, independent of
// which mode the user happens to have picked by hand. Today "auto" just
// sweeps every timeframe and keeps whichever scan produced the highest
// confluence * 1000 + strategyCount — a scoring accident, not a judgement a
// trader would recognize. A professional reads the regime and the location
// together and says "this is a scalp," "this is a swing," or "not yet" —
// this module is that read.
//
// A VERDICT, not a score: regime.ts and location.ts both stay continuous
// multipliers on purpose — a bad location still fires, just discounted.
// This module is deliberately different. Its whole job is to collapse
// everything the engine already knows about the tape into one of four
// discrete calls, because a trader has to actually decide what to do next,
// not receive one more number to weigh in their head.
//
// Client-safe: no server imports, no I/O. Relative "./"-prefixed imports
// with an explicit .ts extension, same reason regime.ts / location.ts do:
// this module is exercised under `node --test`, which resolves neither the
// "@/" alias nor extensionless imports.
import type { LocationRead } from "./location.ts";
import type { RegimeRead } from "./regime.ts";

export type ModeVerdict = "scalp" | "intraday" | "wait" | "stand_down";

export type ModeRead = {
  verdict: ModeVerdict;
  /** Plain-English reason, shown to the user verbatim. */
  reason: string;
  /** Direction the higher-timeframe context supports, when there is one. */
  bias: "long" | "short" | null;
};

/** "Strong long trend" / "Weak trend" (direction omitted on the rare exact
 *  DI+/DI- tie that still classifies as a trend regime) — the shared clause
 *  rules 4, 5 and 7 build their reason text around, so the same evidence
 *  reads identically wherever it shows up. */
function trendDescriptor(regime: RegimeRead): string {
  const strength = regime.regime === "strong_trend" ? "Strong" : "Weak";
  const direction = regime.trendDirection ? ` ${regime.trendDirection}` : "";
  return `${strength}${direction} trend`;
}

/**
 * Collapses everything the engine already reads about the tape — regime,
 * location, an optional proposed direction, and how close the next
 * High-impact release sits — into one discrete verdict. Rules are evaluated
 * in the order below and the first match wins; later rules never run once
 * an earlier one has already decided.
 */
export function arbitrateMode(input: {
  regime: RegimeRead | null;
  location: LocationRead | null;
  /** Direction the entry setup is proposing, when one exists. */
  direction?: "long" | "short" | null;
  /** Minutes until the next High-impact release, from macroConfluenceAdjustment. Null when none pending. */
  minutesToHighImpact?: number | null;
}): ModeRead {
  const { regime, location, direction, minutesToHighImpact } = input;
  // Independent of whichever rule below actually fires: bias is simply what
  // the trend read supports, not a claim tied to the verdict reached.
  const bias: "long" | "short" | null = regime?.trendDirection ?? null;

  // Rule 1 — checked first, ahead of even the missing-regime case: a release
  // this close makes every other read untrustworthy, so it has to override
  // instead of compete with them.
  const minutes = minutesToHighImpact;
  if (minutes != null && minutes >= -30 && minutes <= 15) {
    const reason =
      minutes >= 0
        ? `A high-impact release is due in ${minutes} minute${minutes === 1 ? "" : "s"} — stand down until the reaction resolves.`
        : `A high-impact release printed ${Math.abs(minutes)} minute${Math.abs(minutes) === 1 ? "" : "s"} ago — stand down until the reaction resolves.`;
    return { verdict: "stand_down", reason, bias };
  }

  // Rule 2 — readRegime itself refuses to guess below 60 candles; this
  // module honors that same floor rather than inventing a verdict without
  // enough history to support one.
  if (regime === null) {
    return {
      verdict: "stand_down",
      reason:
        "No regime read yet — not enough candle history to judge what the market is offering.",
      bias,
    };
  }

  // Rule 3 — a range or contraction regime has no swing worth holding for
  // (trendDirection is always null on both), so the only trade on offer is
  // the edges, in and back out.
  if (regime.regime === "range" || regime.regime === "contraction") {
    const label = regime.regime === "range" ? "Range" : "Contraction";
    return {
      verdict: "scalp",
      reason: `${label} regime with no higher-timeframe tide — scalp the edges, there is no swing to hold.`,
      bias,
    };
  }

  const isTrend = regime.regime === "strong_trend" || regime.regime === "weak_trend";
  // A genuine "long"/"short", never the absence markers — a null/undefined
  // direction must not accidentally equal a null trendDirection and read as
  // "matches".
  const directionGiven = direction === "long" || direction === "short";

  // Rule 4 — the direction on offer is right, but taking it here IS the
  // chase location.ts exists to flag. This is the single most valuable
  // verdict the module can return: today this exact case silently becomes a
  // bad fill instead of a "not yet".
  if (
    isTrend &&
    directionGiven &&
    direction === regime.trendDirection &&
    location?.chasing === true
  ) {
    return {
      verdict: "wait",
      reason: `${trendDescriptor(regime)} but price sits at ${location.swingPosition.toFixed(2)} of the swing range — direction is right, location is not. Wait for a pullback.`,
      bias,
    };
  }

  // Rule 5 — trend intact and nothing flags this location as a chase: the
  // ordinary case a trend regime is offering, whether or not a candidate
  // direction was even supplied to check against it.
  if (isTrend && (location === null || location.chasing === false)) {
    const locationClause = location
      ? `price sitting at a workable ${location.label} location`
      : "no location read yet to flag a chase";
    return {
      verdict: "intraday",
      reason: `${trendDescriptor(regime)} with ${locationClause} — ride the intraday swing.`,
      bias,
    };
  }

  // Rule 6 — expansion is loud without being settled: the same "take the
  // edges, do not hold" logic as rule 3, for a different reason (volatility
  // rather than no direction at all).
  if (regime.regime === "expansion") {
    return {
      verdict: "scalp",
      reason:
        "Expansion regime — volatility without a settled direction, take what the range gives and do not hold.",
      bias,
    };
  }

  // Rule 7 — reachable only when a trend regime's location IS chasing but
  // there was no matching direction to test it against (rule 4 needs one):
  // without that, "wait for a pullback" isn't a claim this module can make,
  // so it falls back to the plain trend read.
  return {
    verdict: "intraday",
    reason: `${trendDescriptor(regime)} without a confirmed direction to judge location against — default to the intraday read.`,
    bias,
  };
}
