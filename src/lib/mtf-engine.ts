// Multi-timeframe (MTF) confluence layer.
//
// Classic top-down analysis: instead of judging a pair on a single timeframe,
// a scan confirms the DIRECTION on the higher timeframes and takes the ENTRY
// on a lower one — trade the 5M entry in the direction the 15M/30M/1H/4H/1D
// agree on (intraday), or the 1M entry in the direction 5M/15M/30M agree on
// (scalper). A signal that fights a confirmed higher-timeframe tide is
// blocked; one that rides it gets the tide stamped into its metadata.
//
// Purely client-safe: imports only the engine primitives (no server deps), so
// it can run inside server functions and be unit-tested directly.

import {
  DIRECTION_MARGIN,
  DOWNWEIGHT_FLOOR,
  evaluateStrategy,
  getEngineStrategyCapability,
  latestAtr,
  type EngineMacroContext,
  type SignalDirection,
  type SignalEngineCandle,
  type SignalMode,
  type SignalTimeframe,
  type StrategyVote,
} from "./signal-engine.ts";

export type MtfPlan = {
  /** The timeframe the entry signal is generated on. */
  entryTf: SignalTimeframe;
  /** The higher timeframes whose collective direction gates the entry. */
  directionTfs: SignalTimeframe[];
};

// The user's spec: intraday reads the tide on 15M/30M/1H/4H/1D and enters on
// 5M; scalping reads 5M/15M/30M and enters on 1M.
export const MTF_PLANS: Record<SignalMode, MtfPlan> = {
  intraday: {
    entryTf: "M5",
    directionTfs: ["M15", "M30", "H1", "H4", "D1"],
  },
  scalper: {
    entryTf: "M1",
    directionTfs: ["M5", "M15", "M30"],
  },
};

export type MtfTfBias = {
  tf: SignalTimeframe;
  direction: SignalDirection | "neutral";
  /** Average weighted vote strength of the winning side (0 when neutral). */
  strength: number;
  /** Number of agreeing strategy votes on this timeframe. */
  votes: number;
  /** Total weighted votes cast on this timeframe. */
  totalVotes: number;
  /** The top agreeing strategies on this timeframe. */
  strategies: string[];
};

export type MtfAgreement = {
  plan: MtfPlan;
  /** The tide direction (majority of directional timeframes), or null when split. */
  confirmed: SignalDirection | null;
  /** Fraction of directional timeframes agreeing with the confirmed side (0..1). */
  alignment: number;
  /** alignment as 0..100 (0 when no tide is confirmed). */
  agreementScore: number;
  /** Per-timeframe verdicts. */
  biases: MtfTfBias[];
};

/**
 * Directional verdict for ONE timeframe: run every enabled, compatible
 * strategy (with the same trust weights + macro overlay a live scan uses) and
 * take the weighted majority. Two agreeing votes from independent strategies
 * are required — the same bar the single-timeframe engine applies.
 */
export function evaluateTfDirection({
  pair,
  tf,
  mode,
  candles,
  enabledStrategyIds,
  strategyWeights,
  macro,
}: {
  pair: string;
  tf: SignalTimeframe;
  mode: SignalMode;
  candles: SignalEngineCandle[];
  enabledStrategyIds: string[];
  strategyWeights?: Record<string, number>;
  macro?: EngineMacroContext;
}): MtfTfBias {
  const complete = candles.filter((candle) => candle.complete);
  const neutral: MtfTfBias = {
    tf,
    direction: "neutral",
    strength: 0,
    votes: 0,
    totalVotes: 0,
    strategies: [],
  };
  if (complete.length < 60) return neutral;
  let atr: number;
  try {
    atr = latestAtr(complete);
  } catch {
    return neutral;
  }
  // Same injectable clock as scanCandlesForSignal: the macro-aware strategies
  // must judge "imminent" against the bar being evaluated, not the wall clock,
  // or a replayed higher timeframe reads today's calendar.
  const lastBarMs = Date.parse(complete.at(-1)!.time);
  const context = { pair, macro, now: Number.isFinite(lastBarMs) ? lastBarMs : Date.now() };
  const votes: StrategyVote[] = enabledStrategyIds.flatMap((strategyId) => {
    const capability = getEngineStrategyCapability(strategyId);
    if (!capability.implemented || !capability.timeframes.includes(tf)) return [];
    const weight = strategyWeights?.[strategyId] ?? 1;
    if (weight < DOWNWEIGHT_FLOOR) return [];
    const vote = evaluateStrategy(strategyId, complete, atr, mode, context);
    return vote ? [{ ...vote, strength: vote.strength * weight }] : [];
  });
  const longs = votes.filter((vote) => vote.direction === "long");
  const shorts = votes.filter((vote) => vote.direction === "short");
  // Strength, not raw count, decides the side — see DIRECTION_MARGIN in
  // signal-engine.ts (shared with scanCandlesForSignal's single-TF gate). An
  // exact tie must never default long the way a `>=` count comparison used to.
  const longStrength = longs.reduce((sum, vote) => sum + vote.strength, 0);
  const shortStrength = shorts.reduce((sum, vote) => sum + vote.strength, 0);
  const totalStrength = longStrength + shortStrength;
  const side = longStrength >= shortStrength ? longs : shorts;
  const sideStrength = side === longs ? longStrength : shortStrength;
  if (side.length < 2 || totalStrength === 0 || sideStrength / totalStrength < DIRECTION_MARGIN) {
    return neutral;
  }
  const direction: SignalDirection = side === longs ? "long" : "short";
  return {
    tf,
    direction,
    strength: Math.round(side.reduce((sum, vote) => sum + vote.strength, 0) / side.length),
    votes: side.length,
    totalVotes: votes.length,
    strategies: side.map((vote) => vote.strategyId).slice(0, 3),
  };
}

/**
 * Aggregate the per-timeframe verdicts into a single tide. The confirmed
 * direction is the majority among timeframes that have a directional bias; a
 * tie or all-neutral set confirms nothing (entry falls back to the
 * single-timeframe engine's own verdict).
 */
export function computeMtfAgreement({
  pair,
  mode,
  plan,
  candlesByTf,
  enabledStrategyIds,
  strategyWeights,
  macro,
}: {
  pair: string;
  mode: SignalMode;
  plan: MtfPlan;
  candlesByTf: Record<string, SignalEngineCandle[]>;
  enabledStrategyIds: string[];
  strategyWeights?: Record<string, number>;
  macro?: EngineMacroContext;
}): MtfAgreement {
  const biases = plan.directionTfs.map((tf) =>
    evaluateTfDirection({
      pair,
      tf,
      mode,
      candles: candlesByTf[tf] ?? [],
      enabledStrategyIds,
      strategyWeights,
      macro,
    }),
  );
  const directional = biases.filter((bias) => bias.direction !== "neutral");
  const longs = directional.filter((bias) => bias.direction === "long").length;
  const shorts = directional.filter((bias) => bias.direction === "short").length;
  let confirmed: SignalDirection | null = null;
  if (longs > 0 && longs > shorts) confirmed = "long";
  else if (shorts > 0 && shorts > longs) confirmed = "short";
  const alignment = confirmed
    ? (confirmed === "long" ? longs : shorts) / Math.max(1, directional.length)
    : 0;
  return {
    plan,
    confirmed,
    alignment: +alignment.toFixed(2),
    agreementScore: confirmed ? Math.round(alignment * 100) : 0,
    biases,
  };
}
