// Real-data backtest harness for the LIVE signal engine.
//
// This is deliberately NOT the old backtest-engine.server.ts approach. That
// engine (see the SYNTHETIC banner at the top of that file) generates a
// seeded random walk and replays its own parallel 7-strategy reimplementation
// against it — so it can never say anything about whether the real scanner
// (scanCandlesForSignal in signal-engine.ts, 31 strategies) actually has an
// edge. This module fixes both problems:
//
//   1. It takes REAL candles as input (see real-backtest.server.ts, which
//      fetches them once from the live feed and hands them here — this file
//      itself makes zero network calls, so it is plain, synchronous, and
//      node --test friendly).
//   2. It calls scanCandlesForSignal() directly. Every trade recorded here is
//      a signal the production scanner would actually emit on that candle,
//      not a re-derived approximation of one.
//
// Every signal is resolved with the SAME first-touch logic as
// replaySignalPath() in signal-scorer.ts (SL wins same-candle ties, TP2
// before TP1 — see resolveSignalOutcome below). real-backtest.test.ts asserts
// resolveSignalOutcome() agrees with replaySignalPath() bar-for-bar on shared
// inputs so the two can never silently drift apart.
//
// Chronological in-sample / out-of-sample split, walk-forward style (see
// strategy-weights.ts's trainSize convention, which this mirrors). IMPORTANT:
// scanCandlesForSignal has no fitted or learned parameters — its rules are
// fixed technical-analysis logic, so there is nothing being "trained" here.
// The split exists to answer one narrow, honest question: does performance
// measured on the earlier majority of the series hold up on the later,
// unseen minority, or does it decay? That is the only overfitting question
// this harness can answer, and callers should not read more into it than
// that.
//
// Known limitation, stated plainly: there is no historical bid/ask spread
// series, so every entry fills at the candle close with bid = ask = close
// (spread = 0). buildRiskLevels() in signal-engine.ts therefore never selects
// the "spread" stop basis here, whereas the live scanner sometimes does. The
// STRATEGY VOTES and the R-multiple RESOLUTION LOGIC are identical to
// production; the exact stop distance on spread-driven signals can be
// slightly optimistic versus live trading. This is an ENTRY-side gap only:
// the EXIT side (resolveSignalOutcome below) does price the stop and target
// against the bid/ask via costs.ts, not the zero-spread quote above.

import {
  scanCandlesForSignal,
  type MarketRegime,
  type SignalEngineCandle,
  type SignalMode,
  type SignalTimeframe,
  type StrategyTriggerVariant,
} from "./signal-engine.ts";
import { breakevenLevel, halfSpread } from "./costs.ts";
import { analyseReplay, type ReplayAnalytics } from "./replay-analytics.ts";
import type { ExecutionPolicy } from "./signal-scorer.ts";

export type BacktestOutcomeStatus = "hit_tp2" | "hit_tp1" | "hit_sl" | "open";

export type BacktestTrade = {
  strategyIds: string[];
  direction: "long" | "short";
  signalBarIndex: number;
  signalTime: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  confluence: number;
  /** Bar index (into the complete-candle array) where the trade resolved; null if still open when data ran out. */
  resolutionBarIndex: number | null;
  resolutionTime: string | null;
  outcome: BacktestOutcomeStatus;
  r: number;
  // MAE/MFE (see resolveSignalOutcome for the exact definition and why they
  // matter): MFE answers "was TP1 too far?", MAE answers "was the stop
  // inside the noise?" — not decoration, the data these get fitted from.
  maeR: number;
  mfeR: number;
  barsHeld: number;
  segment: "in_sample" | "out_of_sample";
};

export type SampleStats = {
  label: string;
  trades: number;
  wins: number;
  /** B-single breakeven exits (`hit_tp1`) — resolved and in the denominator, but neither wins nor losses. */
  scratches: number;
  losses: number;
  open: number;
  /** null (never 0) when there are zero resolved trades — a fabricated rate is worse than no rate. */
  winRate: number | null;
  totalR: number;
  expectancyR: number | null;
  maxDrawdownR: number;
};

export type SegmentReport = {
  segment: "in_sample" | "out_of_sample";
  fromBarIndex: number;
  toBarIndex: number;
  overall: SampleStats;
  byStrategy: SampleStats[];
};

export type RealBacktestReport = {
  pair: string;
  mode: SignalMode;
  timeframe: SignalTimeframe;
  strategyIdsEvaluated: string[];
  totalCandles: number;
  completeCandles: number;
  splitBarIndex: number;
  sufficientData: boolean;
  insufficiencyReason: string | null;
  inSample: SegmentReport | null;
  outOfSample: SegmentReport | null;
  trades: BacktestTrade[];
  /** Excursion + calibration read over `trades`; see replay-analytics.ts. */
  analytics: ReplayAnalytics;
  generatedAt: string;
  notes: string[];
};

// scanCandlesForSignal's own floor (throws below this).
const MIN_SCAN_WINDOW = 60;
// Matches the 200-bar candle fetch scoreSignalPerformance() uses to replay a
// stored signal's path in signals.functions.ts — the same practical horizon
// production uses before a signal is just left "open".
const EXPIRY_LOOKAHEAD_BARS = 200;
// Below this, there isn't enough history for a warmup window PLUS a walk in
// both segments — the split would be theater, not evidence.
const MIN_TOTAL_BARS_FOR_SPLIT = 120;
// Below this many out-of-sample bars, the held-out segment is too thin to
// walk meaningfully even if the hard floor above is technically cleared.
const MIN_OUT_OF_SAMPLE_BARS = 30;

/**
 * Resolves a signal's outcome by walking forward candle-by-candle, first
 * touch wins. Mirrors replaySignalPath() in signal-scorer.ts exactly (SL
 * checked before targets on a shared candle, TP2 before TP1), with two
 * additions needed for a walk-forward harness: it also reports which bar
 * resolved the trade (so the caller can advance past it and avoid counting
 * overlapping, non-independent trades), and it caps the lookahead at
 * EXPIRY_LOOKAHEAD_BARS to match the practical horizon production uses.
 *
 * Forward candles are MID prices, but a long's stop and target both fill on
 * the bid and a short's both fill on the ask — comparing bid/ask-referenced
 * levels against mid under-detects stops and over-detects targets, the same
 * bias documented on replaySignalPath(). Each bar is shifted by the
 * half-spread (`h`, from costs.ts unless `opts.halfSpread` pins one for a
 * test or a zero-spread comparison run) to the side the exit actually sees
 * before it is compared.
 *
 * Also reports MAE/MFE in R on that same exit-side price, over the bars up
 * to and including the resolution bar — see the BacktestTrade type for why
 * these are recorded rather than decorative.
 */
export function resolveSignalOutcome(
  signal: {
    pair: string;
    direction: "long" | "short";
    entry: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
  },
  forwardCandles: SignalEngineCandle[],
  opts?: { halfSpread?: number; policy?: ExecutionPolicy },
): {
  status: BacktestOutcomeStatus;
  r: number;
  resolutionIndexOffset: number | null;
  maeR: number;
  mfeR: number;
  barsHeld: number;
} {
  const long = signal.direction === "long";
  const risk = Math.abs(signal.entry - signal.stopLoss);
  if (risk <= 0)
    return { status: "open", r: 0, resolutionIndexOffset: null, maeR: 0, mfeR: 0, barsHeld: 0 };

  const h = opts?.halfSpread ?? halfSpread(signal.pair);
  const policy = opts?.policy ?? "b_single";
  const capped = forwardCandles.slice(0, EXPIRY_LOOKAHEAD_BARS);
  // B-single state, kept byte-identical to replaySignalPath's — the two
  // resolvers drifting apart is the exact failure this file already warns about.
  let armed = false;
  let stopLevel = signal.stopLoss;

  // Running best/worst excursion in R, updated on the exit-side price before
  // the touch check below so the resolution bar's own excursion counts —
  // excursion after the trade has closed is meaningless and is never seen.
  let maeR = 0;
  let mfeR = 0;

  for (let offset = 0; offset < capped.length; offset += 1) {
    const bar = capped[offset];
    const exitHigh = long ? bar.high - h : bar.high + h;
    const exitLow = long ? bar.low - h : bar.low + h;
    const favourable = long ? exitHigh - signal.entry : signal.entry - exitLow;
    const adverse = long ? signal.entry - exitLow : exitHigh - signal.entry;
    mfeR = Math.max(mfeR, favourable / risk);
    maeR = Math.max(maeR, adverse / risk);

    const touchedSl = long ? exitLow <= stopLevel : exitHigh >= stopLevel;
    const touchedTp2 = long ? exitHigh >= signal.takeProfit2 : exitLow <= signal.takeProfit2;
    const touchedTp1 = long ? exitHigh >= signal.takeProfit1 : exitLow <= signal.takeProfit1;
    const excursions = () => ({
      resolutionIndexOffset: offset,
      maeR: +Math.max(0, maeR).toFixed(3),
      mfeR: +Math.max(0, mfeR).toFixed(3),
      barsHeld: offset + 1,
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
      // Deliberately not testing the new breakeven stop on the arming bar —
      // intrabar order is unknowable, and assuming a same-candle round trip
      // from TP1 back to breakeven is a pessimistic guess, not a measurement.
      armed = true;
      stopLevel = breakevenLevel(signal.entry);
    }
  }

  if (capped.length === 0)
    return { status: "open", r: 0, resolutionIndexOffset: null, maeR: 0, mfeR: 0, barsHeld: 0 };
  const last = capped[capped.length - 1];
  const realized = long ? last.close - signal.entry : signal.entry - last.close;
  return {
    status: "open",
    r: +(realized / risk).toFixed(3),
    resolutionIndexOffset: null,
    maeR: +Math.max(0, maeR).toFixed(3),
    mfeR: +Math.max(0, mfeR).toFixed(3),
    barsHeld: capped.length,
  };
}

export function summarizeBacktestTrades(label: string, trades: BacktestTrade[]): SampleStats {
  const resolved = trades.filter((t) => t.outcome !== "open");
  // B-single accounting: only TP2 is a win; `hit_tp1` is the breakeven scratch
  // (resolved, in the denominator, neither win nor loss); only the pre-TP1
  // stop is a loss.
  const wins = resolved.filter((t) => t.outcome === "hit_tp2");
  const scratches = resolved.filter((t) => t.outcome === "hit_tp1");
  const losses = resolved.filter((t) => t.outcome === "hit_sl");
  const totalR = +trades.reduce((sum, t) => sum + t.r, 0).toFixed(3);

  let peak = 0;
  let running = 0;
  let maxDrawdownR = 0;
  for (const trade of [...trades].sort((a, b) => a.signalBarIndex - b.signalBarIndex)) {
    running += trade.r;
    peak = Math.max(peak, running);
    maxDrawdownR = Math.max(maxDrawdownR, peak - running);
  }

  return {
    label,
    trades: trades.length,
    wins: wins.length,
    scratches: scratches.length,
    losses: losses.length,
    open: trades.length - resolved.length,
    winRate: resolved.length > 0 ? +((wins.length / resolved.length) * 100).toFixed(1) : null,
    totalR,
    expectancyR: trades.length > 0 ? +(totalR / trades.length).toFixed(3) : null,
    maxDrawdownR: +maxDrawdownR.toFixed(3),
  };
}

function buildSegmentReport(
  segment: "in_sample" | "out_of_sample",
  fromBarIndex: number,
  toBarIndex: number,
  trades: BacktestTrade[],
): SegmentReport {
  const byStrategyMap = new Map<string, BacktestTrade[]>();
  for (const trade of trades) {
    for (const strategyId of trade.strategyIds) {
      const list = byStrategyMap.get(strategyId) ?? [];
      list.push(trade);
      byStrategyMap.set(strategyId, list);
    }
  }
  const byStrategy = [...byStrategyMap.entries()]
    .map(([strategyId, strategyTrades]) => summarizeBacktestTrades(strategyId, strategyTrades))
    .sort((a, b) => b.trades - a.trades);

  return {
    segment,
    fromBarIndex,
    toBarIndex,
    overall: summarizeBacktestTrades("__overall__", trades),
    byStrategy,
  };
}

export function runRealBacktest({
  pair,
  mode,
  timeframe,
  candles,
  strategyIds,
  trainFraction = 0.6,
  regimeOverride,
  variants,
}: {
  pair: string;
  mode: SignalMode;
  timeframe: SignalTimeframe;
  /** Real candles, oldest first. Fetched ONCE by the caller — this function makes no network calls. */
  candles: SignalEngineCandle[];
  strategyIds: string[];
  /** Fraction of the complete series treated as the earlier ("in-sample") segment. Default 60%, matching strategy-weights.ts. */
  trainFraction?: number;
  /**
   * Pin or disable the regime read for every scan in the walk. `"none"`
   * measures what regime routing is worth (see scanCandlesForSignal).
   */
  regimeOverride?: MarketRegime | "none";
  /** Per-strategy trigger strictness (see scanCandlesForSignal). */
  variants?: Partial<Record<string, StrategyTriggerVariant>>;
}): RealBacktestReport {
  const notes: string[] = [];
  const complete = candles.filter((candle) => candle.complete);
  const totalCandles = candles.length;
  const completeCandles = complete.length;

  if (completeCandles < MIN_TOTAL_BARS_FOR_SPLIT) {
    return {
      pair,
      mode,
      timeframe,
      strategyIdsEvaluated: strategyIds,
      totalCandles,
      completeCandles,
      splitBarIndex: -1,
      sufficientData: false,
      insufficiencyReason:
        `Only ${completeCandles} complete candles are available; at least ${MIN_TOTAL_BARS_FOR_SPLIT} are required for ` +
        `a meaningful in-sample/out-of-sample walk-forward split (a ${MIN_SCAN_WINDOW}-bar minimum scan window plus room ` +
        `to walk both segments). No win rate, expectancy, or drawdown figures are reported for this run.`,
      inSample: null,
      outOfSample: null,
      trades: [],
      // Still shaped, still empty: the analytics report their own
      // insufficiency rather than being absent, so a caller never has to
      // branch on whether the field exists.
      analytics: analyseReplay([]),
      generatedAt: new Date().toISOString(),
      notes,
    };
  }

  const splitBarIndex = Math.floor(completeCandles * trainFraction);
  const outOfSampleBars = completeCandles - Math.max(splitBarIndex, MIN_SCAN_WINDOW);
  if (outOfSampleBars < MIN_OUT_OF_SAMPLE_BARS) {
    notes.push(
      `Out-of-sample segment has only ${Math.max(outOfSampleBars, 0)} usable bars (below the ${MIN_OUT_OF_SAMPLE_BARS}-bar ` +
        `floor this harness treats as meaningful). The numbers below are reported as-is, but should be read as too thin ` +
        `to draw a conclusion from — more a placeholder than evidence.`,
    );
  }

  const trades: BacktestTrade[] = [];
  // One position at a time: after a signal is recorded, the walk advances
  // past its resolution bar before scanning again. This is the same
  // convention the legacy synthetic engine used (`i = j + 1`) and it matters
  // here for the same reason — several strategies (trend/session strategies
  // especially) can keep voting the same direction for many consecutive
  // bars. Scanning and recording every one of those bars as a separate
  // "trade" would count one correlated market move as dozens of independent
  // trials, inflating the sample size and making a win rate look far more
  // stable than the underlying evidence supports.
  let cursor = MIN_SCAN_WINDOW - 1;
  while (cursor < completeCandles) {
    const window = complete.slice(0, cursor + 1);
    const signalCandle = window[window.length - 1];
    const quote = { bid: signalCandle.close, ask: signalCandle.close, mid: signalCandle.close };

    let result: ReturnType<typeof scanCandlesForSignal> | null = null;
    try {
      result = scanCandlesForSignal({
        pair,
        mode,
        timeframe,
        quote,
        candles: window,
        enabledStrategyIds: strategyIds,
        ...(regimeOverride ? { regimeOverride } : {}),
        ...(variants ? { variants } : {}),
      });
    } catch {
      // Not enough usable data at this point in the window (e.g. an ATR
      // calculation failing on a short/flat run) — skip forward one bar.
      cursor += 1;
      continue;
    }

    if (!result.signal) {
      cursor += 1;
      continue;
    }

    const signal = result.signal;
    const forward = complete.slice(cursor + 1);
    const resolved = resolveSignalOutcome(
      {
        pair,
        direction: signal.direction,
        entry: signal.entry,
        stopLoss: signal.stopLoss,
        takeProfit1: signal.takeProfit1,
        takeProfit2: signal.takeProfit2,
      },
      forward,
    );
    const resolutionBarIndex =
      resolved.resolutionIndexOffset != null ? cursor + 1 + resolved.resolutionIndexOffset : null;

    trades.push({
      strategyIds: signal.contributingStrategies,
      direction: signal.direction,
      signalBarIndex: cursor,
      signalTime: signalCandle.time,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit1: signal.takeProfit1,
      takeProfit2: signal.takeProfit2,
      confluence: signal.confluence,
      resolutionBarIndex,
      resolutionTime: resolutionBarIndex != null ? complete[resolutionBarIndex].time : null,
      outcome: resolved.status,
      r: resolved.r,
      maeR: resolved.maeR,
      mfeR: resolved.mfeR,
      barsHeld: resolved.barsHeld,
      segment: cursor < splitBarIndex ? "in_sample" : "out_of_sample",
    });

    cursor =
      resolutionBarIndex != null ? resolutionBarIndex + 1 : cursor + EXPIRY_LOOKAHEAD_BARS + 1;
  }

  const inSampleTrades = trades.filter((trade) => trade.segment === "in_sample");
  const outOfSampleTrades = trades.filter((trade) => trade.segment === "out_of_sample");

  return {
    pair,
    mode,
    timeframe,
    strategyIdsEvaluated: strategyIds,
    totalCandles,
    completeCandles,
    splitBarIndex,
    sufficientData: true,
    insufficiencyReason: null,
    inSample: buildSegmentReport("in_sample", 0, splitBarIndex - 1, inSampleTrades),
    outOfSample: buildSegmentReport(
      "out_of_sample",
      splitBarIndex,
      completeCandles - 1,
      outOfSampleTrades,
    ),
    trades,
    // Excursion and calibration analytics over the same trades. Free — the
    // MAE/MFE were already recorded per trade and were, until now, going
    // nowhere. This is what turns a backtest from "here is a win rate" into
    // "here is whether your stop and target are in the right place".
    analytics: analyseReplay(
      trades.map((trade) => ({
        confluence: trade.confluence,
        outcome: trade.outcome,
        r: trade.r,
        maeR: trade.maeR,
        mfeR: trade.mfeR,
        barsHeld: trade.barsHeld,
      })),
    ),
    generatedAt: new Date().toISOString(),
    notes,
  };
}
