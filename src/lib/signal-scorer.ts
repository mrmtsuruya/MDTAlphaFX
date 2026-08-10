// Paper-trading scorer: evaluates stored signals against the live OANDA feed
// and reports hit-rate / R-multiple performance, per strategy and overall.
//
// A signal is scored by comparing the live mid to its stored entry/SL/TP levels
// (first-touch approximation): a long is "hit_tp2" once price trades above TP2,
// "hit_tp1" above TP1, "hit_sl" below the stop; R-multiple is measured relative
// to the entry→stop risk. Outcomes persist to signal_events and fold back into
// the strategy trust weights used by the engine.
//
// NOTE the status names predate the execution policy: under B-single a
// terminal "hit_tp1" means the breakeven stop took the trade out AFTER TP1 was
// reached, so it scores 0R, not +1.25R. scoreSignal() below is only the
// live-standing display approximation; replaySignalPath() is authoritative.

import { breakevenLevel, halfSpread } from "./costs.ts";

/**
 * How a two-target signal is managed once it is live.
 *
 * `b_single` is what this account actually trades: a 0.01 lot cannot be halved
 * (the minimum lot step IS 0.01), so "take 50% off at TP1" is unexecutable.
 * Instead TP1 arms a breakeven stop and the whole position runs to TP2.
 *
 * `all_out` is the legacy model, kept only so a backtest can measure what the
 * policy change is worth by running the same window both ways. Same reasoning
 * as `halfSpread: 0` and `regimeOverride: "none"`.
 */
export type ExecutionPolicy = "b_single" | "all_out";

export type SignalOutcome =
  | { status: "hit_tp2"; r: number }
  | { status: "hit_tp1"; r: number }
  | { status: "hit_sl"; r: number }
  | { status: "open"; r: number };

/** Fixed R-multiple for a persisted resolved status (used for cumulative stats). */
// UNDER B-SINGLE, `hit_tp1` IS THE BREAKEVEN EXIT, NOT A BANKED PARTIAL WIN.
// The trade reached TP1, the stop moved to breakeven, and price came back and
// took it out — the trader walks away flat. Scoring that as +1.25R (what the
// old all-out model did) books a win for a trade that returned nothing.
const RESOLVED_R: Record<string, number> = { hit_tp2: 2, hit_tp1: 0, hit_sl: -1 };

export function outcomeFromStatus(status: string): SignalOutcome | null {
  const r = RESOLVED_R[status];
  return r === undefined ? null : { status: status as SignalOutcome["status"], r };
}

export type SignalForScoring = {
  id: string;
  pair: string;
  direction: "long" | "short";
  timeframe?: string;
  entry: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  contributing_strategies: string[];
  status: string;
  created_at: string;
};

export function scoreSignal(signal: SignalForScoring, mid: number): SignalOutcome {
  const { entry, stop_loss: sl, take_profit_1: tp1, take_profit_2: tp2 } = signal;
  const long = signal.direction === "long";
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { status: "open", r: 0 };

  // Live-standing approximation (see replaySignalPath for the true path check).
  const distanceTo = (level: number) => (long ? mid - level : level - mid);

  if (distanceTo(tp2) >= 0) return { status: "hit_tp2", r: 2 };
  if (distanceTo(tp1) >= 0) return { status: "hit_tp1", r: 1.25 };
  if (distanceTo(sl) <= 0) return { status: "hit_sl", r: -1 };
  // Open: current unrealized R relative to the stop.
  const realized = long ? mid - entry : entry - mid;
  return { status: "open", r: +(realized / risk).toFixed(3) };
}

export type SignalPathOutcome = SignalOutcome & {
  /** Maximum adverse excursion in R, measured on the exit-side price, clamped at 0. */
  maeR: number;
  /** Maximum favourable excursion in R, measured on the exit-side price, clamped at 0. */
  mfeR: number;
  /** Bars from entry to resolution inclusive; for an unresolved trade, bars examined. */
  barsHeld: number;
};

/**
 * True first-touch resolution: replay the real candle path from the moment the
 * signal was generated (entry assumed filled at signal time) and resolve the
 * level the market actually traded through, under the account's real execution
 * policy.
 *
 * - Default policy is `b_single`: a 0.01 lot cannot be halved, so TP1 does not
 *   close the trade. It ARMS a breakeven stop (see breakevenLevel in costs.ts)
 *   and the whole position runs on toward TP2. The outcomes are therefore
 *   TP2 = +2R, `hit_tp1` = the breakeven exit at 0R, and SL = -1R.
 *   `hit_tp1` is a SCRATCH, not a banked partial win — a trade that tagged the
 *   target and gave it all back returned nothing, and scoring it +1.25R (what
 *   `policy: "all_out"` still does, kept only as a measurable baseline) books a
 *   win that never existed.
 * - A candle touching both targets counts TP2.
 * - SL always wins a tie: if one candle wicks through both a target and the
 *   stop, price hit the worst level. The bar that ARMS the breakeven stop is
 *   the one exception — its own new stop is not tested on that same bar,
 *   because intrabar order is unknowable and assuming a round trip from TP1
 *   back to breakeven inside one candle is a guess, not a measurement.
 * - Only candles after the signal's creation are considered (no lookahead).
 * - Provider candles are MID prices, but a long's stop and target both fill
 *   on the bid and a short's both fill on the ask. Testing bid/ask-referenced
 *   levels against the mid candle under-detects stops and over-detects
 *   targets (bid sits below mid, ask above it) — both errors inflate the
 *   reported win rate, and the bias grows with spread. So each bar is
 *   shifted to the side the exit actually sees before it is compared: `h` is
 *   the half-spread from costs.ts, subtracted from a long's bar (bid side)
 *   and added to a short's (ask side).
 *
 * Also reports MAE/MFE in R, on that same exit-side price, over the bars up
 * to and including the resolution bar: MFE answers "was TP1 too far?", MAE
 * answers "was the stop inside the noise?" Across a large trade sample the
 * joint distribution of the two is what will let stop and target multiples
 * be fitted from data instead of hardcoded — these fields are not decoration.
 */
export function replaySignalPath(
  signal: Pick<
    SignalForScoring,
    "pair" | "direction" | "entry" | "stop_loss" | "take_profit_1" | "take_profit_2" | "created_at"
  >,
  candles: { time: string; high: number; low: number; close?: number }[],
  opts?: { halfSpread?: number; policy?: ExecutionPolicy },
): SignalPathOutcome {
  const { entry, stop_loss: sl, take_profit_1: tp1, take_profit_2: tp2 } = signal;
  const long = signal.direction === "long";
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return { status: "open", r: 0, maeR: 0, mfeR: 0, barsHeld: 0 };

  const h = opts?.halfSpread ?? halfSpread(signal.pair);
  const policy = opts?.policy ?? "b_single";

  const createdMs = Date.parse(signal.created_at);
  const bars = candles
    .map((candle) => ({ ...candle, timeMs: Date.parse(candle.time) }))
    .filter((candle) => Number.isFinite(candle.timeMs) && candle.timeMs >= createdMs)
    .sort((a, b) => a.timeMs - b.timeMs);
  if (bars.length === 0) return { status: "open", r: 0, maeR: 0, mfeR: 0, barsHeld: 0 };

  // Running best/worst excursion in R, updated on the exit-side price before
  // the touch check below so the resolution bar's own excursion counts —
  // excursion after the trade has closed is meaningless and is never seen.
  let maeR = 0;
  let mfeR = 0;
  // B-single state: once TP1 is reached the stop jumps to breakeven and the
  // whole position runs at zero risk toward TP2.
  let armed = false;
  let stopLevel = sl;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const exitHigh = long ? bar.high - h : bar.high + h;
    const exitLow = long ? bar.low - h : bar.low + h;
    const favourable = long ? exitHigh - entry : entry - exitLow;
    const adverse = long ? entry - exitLow : exitHigh - entry;
    mfeR = Math.max(mfeR, favourable / risk);
    maeR = Math.max(maeR, adverse / risk);

    // Conservative touch: SL checked on the same candle as a target, stop wins.
    const touchedSl = long ? exitLow <= stopLevel : exitHigh >= stopLevel;
    const touchedTp1 = long ? exitHigh >= tp1 : exitLow <= tp1;
    const touchedTp2 = long ? exitHigh >= tp2 : exitLow <= tp2;
    const excursions = () => ({
      maeR: +Math.max(0, maeR).toFixed(3),
      mfeR: +Math.max(0, mfeR).toFixed(3),
      barsHeld: i + 1,
    });

    if (armed) {
      // Breakeven stop is live. Only two ways out now.
      if (touchedSl) return { status: "hit_tp1", r: 0, ...excursions() };
      if (touchedTp2) return { status: "hit_tp2", r: 2, ...excursions() };
      continue;
    }

    if (touchedSl) return { status: "hit_sl", r: -1, ...excursions() };
    if (touchedTp2) return { status: "hit_tp2", r: 2, ...excursions() };
    if (touchedTp1) {
      if (policy === "all_out") return { status: "hit_tp1", r: 1.25, ...excursions() };
      // B-single: TP1 arms a breakeven stop and the position runs on. We do NOT
      // test that new stop on this same bar — intrabar order is unknowable, and
      // assuming price tagged TP1 then retraced all the way to breakeven inside
      // one candle is a pessimistic guess dressed up as a measurement.
      armed = true;
      stopLevel = breakevenLevel(entry);
    }
  }

  // Still inside the levels: unrealized R from the last known close.
  const last = bars[bars.length - 1];
  const lastClose = last.close ?? (long ? last.high : last.low);
  const realized = long ? lastClose - entry : entry - lastClose;
  return {
    status: "open",
    r: +(realized / risk).toFixed(3),
    maeR: +Math.max(0, maeR).toFixed(3),
    mfeR: +Math.max(0, mfeR).toFixed(3),
    barsHeld: bars.length,
  };
}

/**
 * Can this signal still be followed right now? A signal is "too late" once the
 * live price has moved beyond ~half the risk distance from entry in the
 * adverse direction — the candle is already trading and the edge is gone.
 */
export function followabilityForSignal(
  signal: Pick<SignalForScoring, "direction" | "entry" | "stop_loss">,
  mid: number,
): { followable: boolean; distancePct: number } {
  const risk = Math.abs(signal.entry - signal.stop_loss);
  if (risk <= 0) return { followable: true, distancePct: 0 };
  // Adverse move is DIRECTION-AWARE: a long is hurt by price falling below
  // entry (entry - mid > 0), a short by price rising above entry
  // (mid - entry > 0). Positive = already moving against you (too late);
  // negative = price is in the trade's favor and still followable.
  const adverse = signal.direction === "long" ? signal.entry - mid : mid - signal.entry;
  const signedPct = +(adverse / risk).toFixed(2);
  return { followable: signedPct <= 0.5, distancePct: Math.abs(signedPct) };
}

export type StrategyScore = {
  strategyId: string;
  signals: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  totalR: number;
};

export type PerformanceReport = {
  scored: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  totalR: number;
  byStrategy: StrategyScore[];
  perSignal: {
    id: string;
    pair: string;
    direction: "long" | "short";
    status: string;
    r: number;
  }[];
};

export function buildPerformanceReport(
  scored: { signal: SignalForScoring; outcome: SignalOutcome }[],
): PerformanceReport {
  const perSignal = scored.map(({ signal, outcome }) => ({
    id: signal.id,
    pair: signal.pair,
    direction: signal.direction,
    status: outcome.status,
    r: outcome.r,
  }));

  const resolved = scored.filter(
    ({ outcome }) =>
      outcome.status === "hit_tp1" || outcome.status === "hit_tp2" || outcome.status === "hit_sl",
  );
  // Only TP2 is a win. `hit_tp1` is the B-single breakeven exit — resolved, so
  // it stays in the win-rate denominator, but it is a scratch and belongs in
  // neither tally. Counting it as a win (the old `!== "hit_sl"` test) credited
  // a strategy for a round trip that returned nothing.
  const wins = resolved.filter(({ outcome }) => outcome.status === "hit_tp2");
  const losses = resolved.filter(({ outcome }) => outcome.status === "hit_sl");
  const grossWin = wins.reduce((sum, { outcome }) => sum + outcome.r, 0);
  const grossLoss = Math.abs(losses.reduce((sum, { outcome }) => sum + outcome.r, 0));
  const totalR = scored.reduce((sum, { outcome }) => sum + outcome.r, 0);

  const byStrategy = new Map<string, StrategyScore>();
  for (const { signal, outcome } of scored) {
    for (const strategyId of signal.contributing_strategies ?? []) {
      const entry = byStrategy.get(strategyId) ?? {
        strategyId,
        signals: 0,
        wins: 0,
        losses: 0,
        open: 0,
        winRate: 0,
        totalR: 0,
      };
      entry.signals += 1;
      entry.totalR += outcome.r;
      if (outcome.status === "hit_tp2") entry.wins += 1;
      else if (outcome.status === "hit_sl") entry.losses += 1;
      // `hit_tp1` (breakeven exit) is deliberately in neither bucket, and is
      // not "open" either — it resolved, it just resolved at zero.
      else if (outcome.status !== "hit_tp1") entry.open += 1;
      byStrategy.set(strategyId, entry);
    }
  }

  return {
    scored: scored.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    winRate: resolved.length ? Math.round((wins.length / resolved.length) * 100) : 0,
    avgR: scored.length ? +(totalR / scored.length).toFixed(3) : 0,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 99 : 0,
    totalR: +totalR.toFixed(2),
    byStrategy: [...byStrategy.values()].sort((a, b) => b.totalR - a.totalR),
    perSignal,
  };
}
