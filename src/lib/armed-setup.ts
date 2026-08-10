// Armed setups: a setup that is FORMING but has not triggered, stated
// explicitly instead of discarded. A scan today is instantaneous and
// binary — press the button, get a signal or get nothing — even though the
// engine has already computed every one of the conditions a trader would
// actually watch for ("not yet, I want a close back above 4358 with the H4
// tide still long") before throwing all of them away except the final
// boolean. This module is that watch-list state, made explicit.
//
// Pure and read-only: takes the same regime/location/mtf/votes a live scan
// already produced and restates them as a checklist plus a trigger and an
// invalidation level. It does not re-run any strategy and is not wired into
// scanCandlesForSignal — persistence, per-bar re-evaluation and UI are a
// later pass.
//
// Client-safe: no server imports, no I/O. Relative "./"-prefixed imports
// with an explicit .ts extension, same reason regime.ts / location.ts /
// mode-arbiter.ts do: this module is exercised under `node --test`, which
// resolves neither the "@/" alias nor extensionless imports.
import { findSwingPoints, latestAtr, type SignalEngineCandle } from "./signal-engine.ts";
import { readRegime, type MarketRegime, type RegimeRead } from "./regime.ts";
import { readLocation, type LocationRead } from "./location.ts";
import { arbitrateMode, type ModeRead } from "./mode-arbiter.ts";

export type ArmedCondition = { label: string; met: boolean };

export type ArmedSetup = {
  direction: "long" | "short";
  conditions: ArmedCondition[];
  metCount: number;
  totalCount: number;
  /** Price whose breach completes the setup. */
  trigger: { price: number; description: string } | null;
  /** Price beyond which the idea is dead. */
  invalidation: { price: number; description: string } | null;
  /** Bars after which the setup expires unfired. */
  expiresInBars: number;
};

// findSwingPoints needs at least k*2+1 = 5 candles to find anything at all,
// and a 60-bar invalidation window means little read off a handful of bars
// — 30 is the floor at which both start producing a real read rather than
// noise. A module-local number, not readLocation's 60 or readRegime's own
// 60: each module's floor matches what THAT module needs, not a shared
// constant.
const MIN_COMPLETE_CANDLES = 30;

// The window the dominant against-the-trade extreme is read over. Matches
// readLocation's own default swing lookback so "the range this setup lives
// inside" means the same 60 bars everywhere in the engine.
const INVALIDATION_LOOKBACK = 60;

// Bars until a waiting idea expires unfired, keyed by how fast the regime
// is moving — a fast regime invalidates a stale idea sooner. Hand-set
// priors, the same way regime.ts's own REGIME_WEIGHTS table is: a
// reasonable starting point, not a fit to resolved history yet.
const EXPIRY_BARS_BY_REGIME: Record<MarketRegime, number> = {
  strong_trend: 12,
  weak_trend: 10,
  range: 6,
  expansion: 4,
  contraction: 8,
};
const EXPIRY_BARS_NO_REGIME = 8;

/**
 * States exactly what is met, what is missing, what would trigger `direction`,
 * and what would kill it — for `candles`, given the same regime/location/mtf/
 * votes a live scan already computed. Returns null when there are fewer than
 * 30 complete candles.
 */
export function buildArmedSetup(input: {
  candles: SignalEngineCandle[];
  direction: "long" | "short";
  atr: number;
  regime: RegimeRead | null;
  location: LocationRead | null;
  mtf?: { confirmed: "long" | "short" | null; alignment: number } | null;
  /** From SignalEngineResult.diagnostics — the votes actually cast. */
  votes: { direction: "long" | "short"; category: string }[];
}): ArmedSetup | null {
  const { candles, direction, regime, location, mtf, votes } = input;
  const complete = candles.filter((candle) => candle.complete);
  if (complete.length < MIN_COMPLETE_CANDLES) return null;

  // Conditions 4 and 5 both read off the SAME agreeing subset — "two votes"
  // and "two categories" are two views of one fact (the votes actually cast
  // for this direction), not independent computations.
  const agreeingVotes = votes.filter((vote) => vote.direction === direction);
  const agreeingCategories = new Set(agreeingVotes.map((vote) => vote.category));

  const conditions: ArmedCondition[] = [
    mtf
      ? { label: "Higher-timeframe tide agrees", met: mtf.confirmed === direction }
      : { label: "Higher-timeframe tide (not evaluated)", met: false },
    {
      label: "Regime supports the direction",
      met: regime !== null && (regime.trendDirection === direction || regime.regime === "range"),
    },
    {
      label: "Price at a favourable location",
      met: location !== null && location.chasing === false,
    },
    {
      label: "At least two agreeing strategy votes",
      met: agreeingVotes.length >= 2,
    },
    {
      label: "At least two independent categories",
      met: agreeingCategories.size >= 2,
    },
  ];
  const metCount = conditions.filter((condition) => condition.met).length;

  // Trigger: the nearest opposing swing structure the close would have to
  // break to complete the setup. Same swing source (and the same "nearest
  // level ahead of the trade" reasoning) as readLocation's own headroom
  // calculation — a real, tradeable level, not an arbitrary distance.
  const close = complete.at(-1)!.close;
  const swings = findSwingPoints(complete, 2);
  let trigger: ArmedSetup["trigger"] = null;
  if (direction === "long") {
    const above = swings.filter((swing) => swing.kind === "high" && swing.price > close);
    if (above.length > 0) {
      const price = Math.min(...above.map((swing) => swing.price));
      trigger = { price, description: `close above ${price.toFixed(5)}` };
    }
  } else {
    const below = swings.filter((swing) => swing.kind === "low" && swing.price < close);
    if (below.length > 0) {
      const price = Math.max(...below.map((swing) => swing.price));
      trigger = { price, description: `close below ${price.toFixed(5)}` };
    }
  }

  // Invalidation: the worst extreme against the trade over the last 60 bars
  // (or all of them, when there are fewer — slice(-60) does both, since a
  // negative start beyond the array's own length just clamps to 0).
  const invalidationWindow = complete.slice(-INVALIDATION_LOOKBACK);
  let invalidation: ArmedSetup["invalidation"];
  if (direction === "long") {
    const price = Math.min(...invalidationWindow.map((candle) => candle.low));
    invalidation = { price, description: `close below ${price.toFixed(5)}` };
  } else {
    const price = Math.max(...invalidationWindow.map((candle) => candle.high));
    invalidation = { price, description: `close above ${price.toFixed(5)}` };
  }

  return {
    direction,
    conditions,
    metCount,
    totalCount: conditions.length,
    trigger,
    invalidation,
    expiresInBars: regime ? EXPIRY_BARS_BY_REGIME[regime.regime] : EXPIRY_BARS_NO_REGIME,
  };
}

/** Multi-line watch-list block for the UI: header counts, one checklist
 *  line per condition, then trigger/invalidation/expiry. `[x]` / `[ ]`
 *  only, no emoji — the block has to render identically in a plain-text
 *  log line as it does on screen. */
export function describeArmedSetup(setup: ArmedSetup, pair: string, timeframe: string): string {
  const header = `${pair} · ${timeframe} · ${setup.direction.toUpperCase()} · ARMED — ${setup.metCount} of ${setup.totalCount} conditions met`;
  const conditionLines = setup.conditions.map(
    (condition) => `  [${condition.met ? "x" : " "}] ${condition.label}`,
  );
  const triggerLine = setup.trigger
    ? `  Trigger: ${setup.trigger.description}`
    : "  Trigger: no qualifying swing level yet";
  const invalidationLine = setup.invalidation
    ? `  Invalidates: ${setup.invalidation.description}`
    : "  Invalidates: unknown";
  const expiryLine = `  Expires in ${setup.expiresInBars} bars`;
  return [header, ...conditionLines, triggerLine, invalidationLine, expiryLine].join("\n");
}

// --- buildArmedContext -------------------------------------------------------
//
// buildArmedSetup above is the primitive: hand it a regime/location/mtf/votes
// that have already been computed and it restates them as a checklist. A live
// scan's null branch does not have those on hand — it has raw candles and the
// votes actually cast, the same inputs scanCandlesForSignal itself started
// from. This is the thin layer between the two: infer a direction to watch,
// read regime/location the same way a scan would, and fold in the mode
// verdict so one call answers both "what is this setup waiting for" and "is
// this even a moment to be trading."

export type ArmedContext = {
  armed: ArmedSetup | null;
  mode: ModeRead;
  /** Direction the armed setup is watching, when one could be inferred. */
  direction: "long" | "short" | null;
};

/** Regime's own trend read wins when it has one — a steadier signal than a
 *  single scan's vote tally. The fallback counts votes, not weighted
 *  strength: ArmedContext only receives the {direction, category} shape
 *  SignalEngineResult.diagnostics.votes already exposes, not the internal
 *  weights scanCandlesForSignal used to pick its own winning side. An exact
 *  tie (0 votes included, 0 === 0) leaves nothing to infer either way. */
function inferWatchedDirection(
  regime: RegimeRead | null,
  votes: { direction: "long" | "short"; category: string }[],
): "long" | "short" | null {
  if (regime?.trendDirection) return regime.trendDirection;
  const longCount = votes.filter((vote) => vote.direction === "long").length;
  const shortCount = votes.filter((vote) => vote.direction === "short").length;
  if (longCount === shortCount) return null;
  return longCount > shortCount ? "long" : "short";
}

/**
 * The null-branch's own read of the same tape a fired signal would have
 * used: infers which direction is being watched, then restates regime,
 * location, the armed checklist, and the mode verdict for it — the exact
 * information a scan currently throws away as a bare reason string.
 */
export function buildArmedContext(input: {
  candles: SignalEngineCandle[];
  votes: { direction: "long" | "short"; category: string }[];
  mtf?: { confirmed: "long" | "short" | null; alignment: number } | null;
  /** Minutes until the nearest pending High-impact release; null when none. */
  minutesToHighImpact?: number | null;
}): ArmedContext {
  const { candles, votes, mtf, minutesToHighImpact } = input;
  const complete = candles.filter((candle) => candle.complete);
  const regime = readRegime(complete);
  const direction = inferWatchedDirection(regime, votes);

  if (direction === null) {
    // Nothing to arm when we cannot tell which way we are leaning — but the
    // mode verdict (a pending release, a missing regime read) is its own
    // fact, independent of whether a direction was inferable.
    return {
      armed: null,
      mode: arbitrateMode({ regime, location: null, direction: null, minutesToHighImpact }),
      direction: null,
    };
  }

  let atr: number;
  try {
    atr = latestAtr(complete);
  } catch {
    // Same "not enough real history" case latestAtr itself guards against —
    // read as no ATR rather than letting a read-only helper's throw escape
    // to a caller that only wants a watch-list state, never an exception.
    return {
      armed: null,
      mode: arbitrateMode({ regime, location: null, direction, minutesToHighImpact }),
      direction,
    };
  }

  const location = readLocation(complete, direction, atr);
  const armed = buildArmedSetup({
    candles: complete,
    direction,
    atr,
    regime,
    location,
    mtf,
    votes,
  });
  const mode = arbitrateMode({ regime, location, direction, minutesToHighImpact });
  return { armed, mode, direction };
}
