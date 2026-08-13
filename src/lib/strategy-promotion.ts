// Strategy multiplier promotion — the review pipeline behind the
// AUTONOMOUS_LEARNING_LOOP panel.
//
// computeStrategyLearning derives candidate trust multipliers from the
// canonical paper ledger; this module decides which candidates may be
// PROMOTED to live weights and turns the promotion ledger into the active
// state. Rules:
//   - Minimum samples: a candidate needs at least PROMOTION_MIN_SAMPLES
//     resolved trades in its mode before it can be promoted.
//   - Verdict: only boost / cool qualify (insufficient is below the floor;
//     hold is no change).
//   - Walk-forward validation: the strategy's walk-forward trust weight must
//     not contradict the promotion (weight >= DOWNWEIGHT_FLOOR). A strategy
//     the walk-forward already downweights cannot be boosted by the ledger.
//   - The promotion ledger (strategy_promotions) is the state: the latest
//     row per (strategy, mode) wins — 'approve' activates the multiplier,
//     'revert' clears it back to 1. No separate "applied" flag to drift.
//
// Pure: no I/O, deterministic per input.

import type { StrategyLearning, LearningVerdict } from "./signal-learning.ts";

export const PROMOTION_MIN_SAMPLES = 20 as const;
export const PROMOTION_MULTIPLIER_MIN = 0.15 as const;
export const PROMOTION_MULTIPLIER_MAX = 1.35 as const;
/** Matches the walk-forward trust floor the scanner enforces (strategy-weights.ts). */
export const PROMOTION_WALK_FLOOR = 0.4 as const;

export type PromotionAction = "approve" | "revert";

/** Raw strategy_promotions row as the repository returns it. */
export type PromotionLedgerRow = {
  strategy_id: string;
  mode: string;
  action: PromotionAction;
  multiplier: number | string;
  created_at: string;
};

export type ActiveMultiplier = {
  strategyId: string;
  mode: string;
  multiplier: number;
};

/**
 * Latest row wins per (strategy, mode): an 'approve' activates its
 * multiplier, a 'revert' (or no row at all) means 1. Rows are expected
 * newest-first; the first row for a key decides.
 */
export function activeMultipliers(rows: PromotionLedgerRow[]): ActiveMultiplier[] {
  const active = new Map<string, ActiveMultiplier>();
  for (const row of rows) {
    const key = `${row.strategy_id}:${row.mode}`;
    if (active.has(key)) continue;
    const multiplier =
      row.action === "approve" ? Math.min(Number(row.multiplier), PROMOTION_MULTIPLIER_MAX) : 1;
    active.set(key, { strategyId: row.strategy_id, mode: row.mode, multiplier });
  }
  return [...active.values()];
}

/** Clamp a candidate multiplier into the promotable band. */
export function clampPromotionMultiplier(multiplier: number): number {
  return Math.min(PROMOTION_MULTIPLIER_MAX, Math.max(PROMOTION_MULTIPLIER_MIN, multiplier));
}

export type PromotionGate = {
  ok: boolean;
  multiplier: number | null;
  reasons: string[];
};

/**
 * The approval gates for one candidate. Every failure is named so the UI can
 * show exactly why APPROVE is disabled. `walkWeight` is the strategy's
 * walk-forward trust weight on the current candles (null when the walk
 * couldn't score it — which fails closed: no walk-forward evidence, no
 * promotion).
 */
export function evaluatePromotionGate(input: {
  learned: StrategyLearning | null;
  walkWeight: number | null;
}): PromotionGate {
  const { learned, walkWeight } = input;
  const reasons: string[] = [];

  if (!learned) {
    return { ok: false, multiplier: null, reasons: ["NO_LEARNING_RECORD"] };
  }
  if (learned.verdict !== "boost" && learned.verdict !== "cool") {
    reasons.push(`VERDICT_${learned.verdict.toUpperCase()}`);
  }
  if (learned.resolved < PROMOTION_MIN_SAMPLES) {
    reasons.push(`NEEDS_${PROMOTION_MIN_SAMPLES}_RESOLVED_HAS_${learned.resolved}`);
  }
  if (walkWeight == null || walkWeight < PROMOTION_WALK_FLOOR) {
    reasons.push(walkWeight == null ? "NO_WALK_FORWARD_WEIGHT" : "WALK_DOWNWEIGHTED");
  }

  if (reasons.length > 0) {
    return { ok: false, multiplier: null, reasons };
  }
  return {
    ok: true,
    multiplier: clampPromotionMultiplier(learned.multiplier),
    reasons: [],
  };
}

export type { StrategyLearning, LearningVerdict };
