// Autonomous self-learning loop.
//
// The engine already auto-downweights strategies that fail walk-forward on the
// scan's own candles. This module is the OUTCOME layer on top: it derives
// per-strategy trust multipliers from the resolved paper-trading record (the
// signals we treated as taken and let the market resolve to TP2/TP1/SL), so
// the engine leans into strategies that have actually banked R and starves the
// ones that have lost it — with no user intervention and no LLM cost.
//
// Everything here is deterministic and runs on every scan and every 30s
// performance poll, so the loop is fully autonomous: generated -> resolved ->
// reweighted -> generated.
//
// Multipliers multiply the walk-forward trust weights. A multiplier below
// DOWNWEIGHT_FLOOR (0.35, when the walk-forward weight is neutral at 1.0)
// pushes the strategy under the engine's exclusion floor, so chronically
// losing strategies stop contributing until their recency-weighted record
// recovers.

import { DOWNWEIGHT_FLOOR } from "./signal-engine.ts";
// R-per-outcome is shared with the UI so the panel and the trust multipliers
// can never disagree — see the note on the export in order-ticket.ts.
import { R_OF_STATUS } from "./order-ticket.ts";

export type ResolvedSignalForLearning = {
  id: string;
  pair: string;
  direction: "long" | "short";
  mode?: string;
  timeframe?: string;
  confluence?: number;
  contributing_strategies?: string[];
  status: string; // hit_tp1 | hit_tp2 | hit_sl | invalidated
  created_at: string;
};

// Strategies with fewer raw wins than this can never be BOOSTed, even if a
// recency-weighted rate looks good — the panel shows raw wins/resolved, so a
// "BOOST ×1.35 1/3" chip would contradict itself.
const MIN_RAW_WINS_FOR_BOOST = 2;

// A strategy is only hard-EXCLUDED (pushed under the engine's trust floor) with
// overwhelming evidence: a very low win rate AND at least this many resolved
// outcomes. Below that, chronic losers are merely cooled so they still
// contribute at reduced strength — the user wants every strategy working, just
// weighted by its real record.
const MIN_RESOLVED_FOR_EXCLUSION = 8;

// Recency half-life: an outcome from N days ago carries 50% weight. Recent
// results matter most, so the loop can both punish a fresh losing streak and
// forgive an old one — self-correcting without hysteresis.
const RECENCY_HALF_LIFE_MS = 3 * 86_400_000;

export type LearningVerdict = "boost" | "cool" | "hold" | "insufficient";

export type StrategyLearning = {
  strategyId: string;
  mode: string;
  resolved: number; // resolved trade outcomes (wins + losses)
  wins: number;
  losses: number;
  stale: number; // invalidated (expired without touching a level)
  winRate: number; // recency-weighted 0..1
  totalR: number; // raw sum of R over all outcomes
  multiplier: number; // 0.3 .. 1.35 trust adjustment applied to walk-forward weight
  excluded: boolean; // multiplier forces the weight under the engine floor
  verdict: LearningVerdict;
};

function recencyWeight(createdAt: string, now: number) {
  const age = now - Date.parse(createdAt);
  if (!Number.isFinite(age) || age <= 0) return 1;
  return Math.exp(-age / RECENCY_HALF_LIFE_MS);
}

/**
 * Derive per-strategy trust for ONE mode from the resolved record.
 * Returns a Map keyed by strategyId (only strategies with outcomes).
 */
export function computeStrategyLearning(
  signals: ResolvedSignalForLearning[],
  mode: string,
  now = Date.now(),
): Map<string, StrategyLearning> {
  const acc = new Map<
    string,
    {
      resolved: number;
      wins: number;
      losses: number;
      stale: number;
      weightedWins: number;
      weightedResolved: number;
      totalR: number;
    }
  >();

  for (const signal of signals) {
    // Mode-less (legacy synthetic) signals carry no contributing strategies, so
    // they are no-ops either way — but be strict: never count an ambiguous-mode
    // row toward one specific mode's learning.
    if (!signal.mode || signal.mode !== mode) continue;
    for (const strategyId of signal.contributing_strategies ?? []) {
      const entry = acc.get(strategyId) ?? {
        resolved: 0,
        wins: 0,
        losses: 0,
        stale: 0,
        weightedWins: 0,
        weightedResolved: 0,
        totalR: 0,
      };
      const r = R_OF_STATUS[signal.status] ?? 0;
      const weight = recencyWeight(signal.created_at, now);
      entry.totalR += r;
      if (signal.status === "hit_tp2") {
        entry.resolved += 1;
        entry.wins += 1;
        entry.weightedWins += weight;
        entry.weightedResolved += weight;
      } else if (signal.status === "hit_tp1") {
        // B-single scratch: reached TP1, then the breakeven stop took it out.
        // Resolved and it counts toward the win RATE denominator — a strategy
        // that keeps producing round trips to nowhere should not look as good
        // as one that reaches TP2 — but it is neither a win nor a loss.
        entry.resolved += 1;
        entry.weightedResolved += weight;
      } else if (signal.status === "hit_sl") {
        entry.resolved += 1;
        entry.losses += 1;
        entry.weightedResolved += weight; // a loss decays too — old losses fade
      } else {
        entry.stale += 1;
      }
      acc.set(strategyId, entry);
    }
  }

  const result = new Map<string, StrategyLearning>();
  for (const [strategyId, entry] of acc) {
    const winRate = entry.weightedResolved > 0 ? entry.weightedWins / entry.weightedResolved : 0;
    const { multiplier, verdict } = trustMultiplier(winRate, entry.resolved, entry.wins);
    result.set(strategyId, {
      strategyId,
      mode,
      resolved: entry.resolved,
      wins: entry.wins,
      losses: entry.losses,
      stale: entry.stale,
      winRate: +winRate.toFixed(3),
      totalR: +entry.totalR.toFixed(2),
      multiplier,
      // At a neutral walk-forward weight (1.0), the 0.3 multiplier lands at 0.3,
      // under the engine's exclusion floor — the strategy stops contributing.
      excluded: verdict === "cool" && multiplier < DOWNWEIGHT_FLOOR,
      verdict,
    });
  }
  return result;
}

/**
 * Map (recency-weighted winRate, raw sample count, raw wins) onto a trust
 * multiplier.
 * - <3 resolved samples: no evidence yet, hold at 1.0.
 * - >=60% wins with >=2 RAW wins: boost up to 1.35 (engine trusts it more).
 *   The raw-wins floor prevents a misleading boost from a few fresh wins over
 *   heavily decayed old losses (a "BOOST ×1.35 1/3" chip would contradict the
 *   raw counts the panel shows).
 * - <=40% wins: cooled to 0.6 (or 0.5 for a <25% rate) so the strategy keeps
 *   contributing at reduced strength.
 * - Only a <25% win rate WITH >= MIN_RESOLVED_FOR_EXCLUSION resolved outcomes
 *   hard-excludes the strategy (0.3 lands under the engine floor at a neutral
 *   walk-forward weight). This keeps every strategy in the catalog working
 *   while still silencing chronic, well-evidenced losers.
 */
export function trustMultiplier(
  winRate: number,
  resolved: number,
  wins = 0,
): { multiplier: number; verdict: LearningVerdict } {
  if (resolved < 3) return { multiplier: 1, verdict: "insufficient" };
  if (winRate >= 0.7 && wins >= MIN_RAW_WINS_FOR_BOOST)
    return { multiplier: 1.35, verdict: "boost" };
  if (winRate >= 0.6 && wins >= MIN_RAW_WINS_FOR_BOOST)
    return { multiplier: 1.2, verdict: "boost" };
  if (winRate <= 0.25 && resolved >= MIN_RESOLVED_FOR_EXCLUSION)
    return { multiplier: 0.3, verdict: "cool" };
  if (winRate <= 0.25) return { multiplier: 0.5, verdict: "cool" };
  if (winRate <= 0.4) return { multiplier: 0.6, verdict: "cool" };
  return { multiplier: 1, verdict: "hold" };
}

// ---------------------------------------------------------------------------
// Per-signal autopsies — the "what went right / what went wrong" narrative.
// ---------------------------------------------------------------------------

export type SignalAutopsy = {
  id: string;
  pair: string;
  direction: "long" | "short";
  mode: string;
  timeframe: string;
  status: string;
  r: number;
  confluence: number;
  headline: string;
  diagnosis: string;
  lesson: string;
  carriers: string[]; // strategies that carried the signal (contributing)
};

export function buildSignalAutopsy(signal: ResolvedSignalForLearning): SignalAutopsy | null {
  const r = R_OF_STATUS[signal.status] ?? 0;
  const mode = (signal.mode ?? "intraday").toUpperCase();
  const direction = signal.direction?.toUpperCase() ?? "";
  const carriers = signal.contributing_strategies ?? [];
  const confluence = signal.confluence ?? 0;

  if (signal.status === "hit_tp2") {
    return {
      id: signal.id,
      pair: signal.pair,
      direction: signal.direction,
      mode,
      timeframe: signal.timeframe ?? "-",
      status: signal.status,
      r,
      confluence,
      headline: `Full runner — TP2 banked +2.0R on ${signal.pair}`,
      diagnosis: `The ${direction} thesis played out end-to-end: price ran through TP1 and kept going to TP2. All ${carriers.length} carrying strategies were on the right side (${carriers.join(", ") || "—"}).`,
      lesson: `Letting winners run to TP2 was the highest-value decision in ${mode} mode. Consider scaling out only at TP2 or using a trail after TP1.`,
      carriers,
    };
  }
  if (signal.status === "hit_tp1") {
    return {
      id: signal.id,
      pair: signal.pair,
      direction: signal.direction,
      mode,
      timeframe: signal.timeframe ?? "-",
      status: signal.status,
      r,
      confluence,
      headline: `Scratched at breakeven — TP1 reached, then the breakeven stop took it out on ${signal.pair}`,
      diagnosis: `The ${direction} move reached TP1 but reversed far enough to trigger the breakeven stop — the whole 0.01 lot exited flat. Carrying strategies: ${carriers.join(", ") || "—"}.`,
      lesson: `Under B-single only TP2 banks R: this scratch means the thesis stalled after the first target. It is resolved and counts toward the rate denominator, but is neither a win nor a loss.`,
      carriers,
    };
  }
  if (signal.status === "hit_sl") {
    return {
      id: signal.id,
      pair: signal.pair,
      direction: signal.direction,
      mode,
      timeframe: signal.timeframe ?? "-",
      status: signal.status,
      r,
      confluence,
      headline: `Stopped out −1.0R on ${signal.pair}`,
      diagnosis: `The ${direction} setup fired but price swept the structural stop before the thesis could develop. Every carrying strategy was wrong here (${carriers.join(", ") || "—"}) — the confluence was ${confluence}% at generation.`,
      lesson: `Losing trades cluster when confluence is thin or when the stop sits at obvious liquidity. The loop is now cooling the strategies that keep carrying losing ${mode} setups.`,
      carriers,
    };
  }
  if (signal.status === "invalidated") {
    return {
      id: signal.id,
      pair: signal.pair,
      direction: signal.direction,
      mode,
      timeframe: signal.timeframe ?? "-",
      status: signal.status,
      r,
      confluence,
      headline: `Expired stale — no level touched on ${signal.pair}`,
      diagnosis: `The ${direction} setup never reached TP1, TP2, or the stop inside its validity window — the move simply did not develop. Confluence was ${confluence}%.`,
      lesson: `Stale expiries are cheap information: low-confluence ${mode} setups stall. Raising the minimum confluence or demanding a third category of confirmation would cut these.`,
      carriers,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Learning report — the aggregate the UI and the loop both consume.
// ---------------------------------------------------------------------------

export type LearningReport = {
  generatedAt: string;
  resolved: number; // wins + scratches + losses across the record
  wins: number;
  losses: number;
  stale: number;
  winRate: number;
  totalR: number;
  adjustmentsApplied: number; // strategies whose trust multiplier != 1
  excludedCount: number;
  modes: {
    intraday: StrategyLearning[];
    scalper: StrategyLearning[];
  };
  strengths: StrategyLearning[]; // boost verdict, sorted by totalR desc
  weaknesses: StrategyLearning[]; // cool verdict, sorted by totalR asc
  autopsies: SignalAutopsy[];
  recommendations: string[];
};

export function buildLearningReport(
  signals: ResolvedSignalForLearning[],
  now = Date.now(),
): LearningReport {
  const resolved = signals.filter(
    (s) => s.status === "hit_tp1" || s.status === "hit_tp2" || s.status === "hit_sl",
  );
  // B-single: only TP2 is a win and only the pre-TP1 stop is a loss. `hit_tp1`
  // is the breakeven scratch — resolved (so it dilutes the win rate) but
  // excluded from both tallies.
  const wins = resolved.filter((s) => s.status === "hit_tp2").length;
  const losses = resolved.filter((s) => s.status === "hit_sl").length;
  const stale = signals.filter((s) => s.status === "invalidated").length;
  const totalR = signals.reduce((sum, s) => sum + (R_OF_STATUS[s.status] ?? 0), 0);

  const intraday = [...computeStrategyLearning(signals, "intraday", now).values()];
  const scalper = [...computeStrategyLearning(signals, "scalper", now).values()];
  const all = new Map<string, StrategyLearning>();
  for (const entry of [...intraday, ...scalper]) {
    all.set(`${entry.strategyId}:${entry.mode}`, entry);
  }
  const strengths = [...all.values()]
    .filter((s) => s.verdict === "boost")
    .sort((a, b) => b.totalR - a.totalR);
  const weaknesses = [...all.values()]
    .filter((s) => s.verdict === "cool")
    .sort((a, b) => a.totalR - b.totalR);

  const autopsies = signals
    .slice()
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 6)
    .map((s) => buildSignalAutopsy(s))
    .filter((a): a is SignalAutopsy => a !== null);

  const recommendations: string[] = [];
  if (resolved.length === 0) {
    recommendations.push(
      "Not enough resolved trades yet to tune trust. Keep scanning — the loop needs at least 3 resolved outcomes per strategy before it adjusts anything.",
    );
  } else {
    if (strengths.length > 0) {
      recommendations.push(
        `Leaning into ${strengths
          .slice(0, 3)
          .map((s) => `${s.strategyId} (${s.wins}/${s.resolved})`)
          .join(", ")} — trust boosted on the next scan.`,
      );
    }
    if (weaknesses.length > 0) {
      recommendations.push(
        `Starving ${weaknesses
          .slice(0, 3)
          .map((s) => `${s.strategyId}×${s.multiplier}`)
          .join(", ")} — their losing ${weaknesses[0].mode} outcomes are downweighted.`,
      );
    }
    recommendations.push(
      `Global win rate ${Math.round((wins / Math.max(1, resolved.length)) * 100)}% over ${resolved.length} resolved ${wins >= losses ? "— the book is profitable; keep the same risk profile." : "— the book is losing; the loop is throttling the worst strategies and will re-evaluate every scan."}`,
    );
    recommendations.push(
      "Trust weights self-correct from the resolved record on every scan — no manual tuning required.",
    );
  }

  return {
    generatedAt: new Date(now).toISOString(),
    resolved: resolved.length,
    wins,
    losses,
    stale,
    winRate: resolved.length ? Math.round((wins / resolved.length) * 100) : 0,
    totalR: +totalR.toFixed(2),
    adjustmentsApplied: [...all.values()].filter((s) => s.multiplier !== 1).length,
    excludedCount: [...all.values()].filter((s) => s.excluded).length,
    modes: {
      intraday: intraday.sort((a, b) => b.totalR - a.totalR),
      scalper: scalper.sort((a, b) => b.totalR - a.totalR),
    },
    strengths,
    weaknesses,
    autopsies,
    recommendations,
  };
}
