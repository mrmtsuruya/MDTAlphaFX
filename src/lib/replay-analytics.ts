// Replay analytics — what a backtest actually tells you about your levels.
//
// runRealBacktest() already returns every trade with its confluence, outcome,
// R, and (since W6.2) its maximum adverse and favourable excursion. Nothing
// consumed those excursions. They are the most informative post-trade numbers
// available, and they answer the two questions the hardcoded 1.25R / 2R targets
// and 1.6–1.8 ATR stops have never been asked:
//
//   MFE — was TP1 too far? If losers routinely ran to 1.1R before turning over,
//         a target at 1.25R was sitting just beyond where the move actually died.
//   MAE — was the stop inside the noise? If winners routinely dipped to -0.8R
//         first, the stop is being placed inside the trade's normal breathing.
//
// This module is deliberately DESCRIPTIVE, not an optimiser. It reports what the
// distributions say and refuses to report anything on a thin sample. Actually
// re-fitting the multiples belongs in W4, where the engine can be re-run over
// real history with varied parameters and the result checked out-of-sample —
// picking a target by eyeballing an MFE percentile on the same trades that
// produced it is exactly the overfit that makes backtests lie.
//
// One honesty note that constrains what can be claimed here: MAE and MFE are
// magnitudes, not a sequence. Knowing a trade reached 1.4R favourable and 0.6R
// adverse does not say which came first. Where that ambiguity matters below,
// the metric is restricted to trades whose OUTCOME already settles the order —
// a stopped-out trade's MFE is unambiguously "how far it ran before dying".
//
// Client-safe: pure functions over trade rows, no I/O.

import { buildCalibrationCurve, type CalibrationCurve } from "./calibration.ts";

/** Minimum trades before any diagnostic is allowed to state a conclusion. */
export const MIN_TRADES_FOR_DIAGNOSIS = 30;

export type ReplayTrade = {
  confluence: number;
  outcome: "hit_tp2" | "hit_tp1" | "hit_sl" | "open";
  r: number;
  maeR: number;
  mfeR: number;
  barsHeld: number;
};

/**
 * Linear-interpolated percentile over a sorted copy. `p` in [0,1].
 * Returns null for an empty set rather than NaN — a missing statistic should
 * be visibly absent, not silently poison an arithmetic chain downstream.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export type ExcursionProfile = {
  trades: number;
  /** Trades that stopped out — their MFE is unambiguously "how far it ran first". */
  losers: number;
  /** Trades that reached TP2. */
  winners: number;
  /** Breakeven exits after TP1 (B-single scratches). */
  scratches: number;
  /** MFE percentiles across stopped-out trades only. */
  loserMfe: { p50: number | null; p75: number | null; p90: number | null };
  /** MAE percentiles across winning trades only. */
  winnerMae: { p50: number | null; p75: number | null; p90: number | null };
  /** Share of losers whose MFE reached at least 1.0R before they died. */
  losersReaching1R: number | null;
  /** Median bars held, all resolved trades. */
  medianBarsHeld: number | null;
  sufficient: boolean;
};

function resolved(trades: ReplayTrade[]) {
  return trades.filter((trade) => trade.outcome !== "open");
}

export function excursionProfile(trades: ReplayTrade[]): ExcursionProfile {
  const done = resolved(trades);
  const losers = done.filter((trade) => trade.outcome === "hit_sl");
  const winners = done.filter((trade) => trade.outcome === "hit_tp2");
  const scratches = done.filter((trade) => trade.outcome === "hit_tp1");
  const sufficient = done.length >= MIN_TRADES_FOR_DIAGNOSIS;

  const pct = (values: number[]) => ({
    p50: sufficient ? percentile(values, 0.5) : null,
    p75: sufficient ? percentile(values, 0.75) : null,
    p90: sufficient ? percentile(values, 0.9) : null,
  });

  return {
    trades: done.length,
    losers: losers.length,
    winners: winners.length,
    scratches: scratches.length,
    loserMfe: pct(losers.map((trade) => trade.mfeR)),
    winnerMae: pct(winners.map((trade) => trade.maeR)),
    losersReaching1R:
      sufficient && losers.length > 0
        ? +(losers.filter((trade) => trade.mfeR >= 1).length / losers.length).toFixed(4)
        : null,
    medianBarsHeld: sufficient
      ? percentile(
          done.map((trade) => trade.barsHeld),
          0.5,
        )
      : null,
    sufficient,
  };
}

export type LevelFinding = {
  /** Machine-readable so a UI can style or filter these. */
  id: "tp1_too_far" | "stop_inside_noise" | "targets_look_reasonable" | "insufficient_data";
  severity: "info" | "warn";
  message: string;
};

/**
 * Turn the excursion distributions into plain findings.
 *
 * Thresholds here are judgement calls, stated openly rather than tuned: a
 * finding is raised when the distribution is lopsided enough that a human
 * looking at the same numbers would say the same thing. They decide what gets
 * SURFACED, never what gets traded.
 */
export function diagnoseLevels(profile: ExcursionProfile): LevelFinding[] {
  if (!profile.sufficient) {
    return [
      {
        id: "insufficient_data",
        severity: "info",
        message: `Only ${profile.trades} resolved trades — need ${MIN_TRADES_FOR_DIAGNOSIS} before the excursion distributions say anything reliable.`,
      },
    ];
  }

  const findings: LevelFinding[] = [];

  // Losers that ran most of the way to target before dying mean the target was
  // sitting just past where the move actually gave out.
  if (profile.losersReaching1R !== null && profile.losersReaching1R >= 0.4) {
    findings.push({
      id: "tp1_too_far",
      severity: "warn",
      message: `${Math.round(profile.losersReaching1R * 100)}% of stopped-out trades first ran to 1.0R or better (median ${profile.loserMfe.p50?.toFixed(2)}R). TP1 at 1.25R is sitting beyond where these moves died — worth testing a nearer first target.`,
    });
  }

  // Winners that routinely dip deep before working mean the stop is inside the
  // trade's normal breathing room, not outside it.
  if (profile.winnerMae.p75 !== null && profile.winnerMae.p75 >= 0.7) {
    findings.push({
      id: "stop_inside_noise",
      severity: "warn",
      message: `A quarter of winning trades first went ${profile.winnerMae.p75.toFixed(2)}R or more against the entry (median ${profile.winnerMae.p50?.toFixed(2)}R). The stop is inside the noise these trades normally make before working.`,
    });
  }

  if (findings.length === 0) {
    findings.push({
      id: "targets_look_reasonable",
      severity: "info",
      message: `Across ${profile.trades} resolved trades the excursion distributions do not argue against the current stop and target placement.`,
    });
  }

  return findings;
}

export type ReplayAnalytics = {
  calibration: CalibrationCurve;
  excursions: ExcursionProfile;
  findings: LevelFinding[];
};

/**
 * Everything a replay can tell you about the engine's own settings, in one pass.
 *
 * The calibration side reuses the same curve builder the live record uses, so a
 * replayed cohort and a live one are measured identically and can be compared
 * directly — which is the whole point of replaying history in the first place.
 */
export function analyseReplay(trades: ReplayTrade[]): ReplayAnalytics {
  const excursions = excursionProfile(trades);
  return {
    calibration: buildCalibrationCurve(
      resolved(trades).map((trade) => ({ confluence: trade.confluence, status: trade.outcome })),
    ),
    excursions,
    findings: diagnoseLevels(excursions),
  };
}
