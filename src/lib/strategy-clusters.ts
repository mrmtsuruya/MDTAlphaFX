// Correlated-vote clustering.
//
// The engine counts every agreeing strategy as an independent vote. It is not.
// Roughly a third of the catalog reads the same underlying thing: ema_trend,
// ma_ribbon, ichimoku, supertrend, heiken_ashi_scalp and qullamaggie_breakout
// are all moving-average state, so six of them agreeing is ONE opinion held six
// ways, not six analysts reaching the same conclusion.
//
// The old independence proxy was `categories.size >= 2`, which does not help:
// those six span `trend` and `breakout`, and macd_hist sits in `momentum` while
// being EMA-derived. So a single idea could clear the independence bar on its
// own and then have its agreement counted six times over in the confluence
// average. That is the mechanism behind uncalibrated 80%+ readings.
//
// This module groups strategies by what they actually read, then confluence
// counts CLUSTERS instead of votes. Expect scores to fall materially — a
// current 80 landing in the 50s or 60s is the fix working, not a regression.
//
// Two ways to get a cluster map:
//
//   DEFAULT_CLUSTERS below — derived from the indicator each strategy computes.
//   It is a stated prior, not a measurement, and it is what ships until there
//   is enough history to do better.
//
//   computeAgreementMatrix() + clusterByAgreement() — derives the map from how
//   the strategies ACTUALLY voted across real candles. Two strategies that
//   agree 95% of the time are one signal whatever their indicators look like.
//   This wants years of bars (see tools/fetch-history.mjs); running it on a
//   month of data would produce a map fitted to one market regime.
//
// Client-safe: pure functions, no I/O.

import { evaluateStrategy, getEngineStrategyCapability, latestAtr } from "./signal-engine.ts";
import type { SignalEngineCandle, SignalMode, SignalTimeframe } from "./signal-engine.ts";

export type ClusterId =
  | "ma_trend"
  | "oscillator"
  | "channel_break"
  | "volatility"
  | "liquidity"
  | "structure"
  | "session"
  | "harmonic"
  | "vwap"
  | "macro";

/**
 * Prior cluster map, grouped by the underlying series each strategy reads.
 *
 * Justification per group, so the next person can argue with it rather than
 * guess at it:
 *
 *  - ma_trend      — all six resolve to "where is price relative to its moving
 *                    averages, and are they stacked". Ichimoku and SuperTrend
 *                    dress it differently; the input is the same.
 *  - oscillator    — bounded oscillators computed from the close. Divergence
 *                    reads slope-versus-price rather than level, which is a
 *                    genuinely different question, but it is asked of the SAME
 *                    series, so they are pooled until measurement separates
 *                    them.
 *  - channel_break — a close crossing a volatility band. Bollinger, Keltner and
 *                    Donchian differ only in how the band is drawn.
 *  - liquidity     — order-flow reads keyed on a swept level being reclaimed.
 *  - structure     — horizontal or diagonal levels and their failure.
 *  - session       — time-of-day range breaks; correlated by construction since
 *                    they fire in overlapping windows.
 *  - macro         — calendar and positioning, independent of price geometry.
 */
export const DEFAULT_CLUSTERS: Record<string, ClusterId> = {
  ema_trend: "ma_trend",
  ma_ribbon: "ma_trend",
  ichimoku: "ma_trend",
  supertrend: "ma_trend",
  heiken_ashi_scalp: "ma_trend",
  qullamaggie_breakout: "ma_trend",

  rsi_momo: "oscillator",
  stoch_rsi: "oscillator",
  cci_extreme: "oscillator",
  macd_hist: "oscillator",
  rsi_divergence: "oscillator",
  macd_divergence: "oscillator",

  donchian_break: "channel_break",
  bollinger_squeeze: "channel_break",
  keltner_break: "channel_break",

  atr_expansion: "volatility",
  climax_exhaustion: "volatility",

  liquidity_sweep: "liquidity",
  stop_run_reversal: "liquidity",
  fvg: "liquidity",
  order_block: "liquidity",
  bos_choch: "liquidity",

  sr_confluence: "structure",
  trendline_break: "structure",
  fib_retracement: "structure",
  failed_breakout: "structure",

  london_killzone: "session",
  ny_killzone: "session",
  asian_range: "session",
  opening_range_breakout: "session",

  gartley: "harmonic",
  bat_pattern: "harmonic",
  butterfly_pattern: "harmonic",

  vwap_mean_rev: "vwap",

  news_reactive: "macro",
  ai_confluence: "macro",
};

/** An unmapped strategy is its own cluster — never silently pooled. */
export function clusterOf(strategyId: string, map: Record<string, string> = DEFAULT_CLUSTERS) {
  return map[strategyId] ?? `solo:${strategyId}`;
}

export type ClusteredVote = { strategyId: string; direction: "long" | "short"; strength: number };

export type ClusterRollup = {
  cluster: string;
  /** Strongest member — a cluster contributes its best read, not an average. */
  strength: number;
  members: string[];
};

/**
 * Collapse votes to one entry per cluster, keeping the strongest member.
 *
 * Taking the max rather than the mean is deliberate: six moving averages
 * agreeing is one opinion held at its most confident, and averaging would
 * PUNISH breadth within an idea while the old code REWARDED it. Neither is
 * right; the honest answer is that breadth within a cluster carries almost no
 * extra information, so it is worth a small saturating bonus and nothing more.
 */
export function rollupByCluster(
  votes: ClusteredVote[],
  map: Record<string, string> = DEFAULT_CLUSTERS,
): ClusterRollup[] {
  const byCluster = new Map<string, ClusterRollup>();
  for (const vote of votes) {
    const cluster = clusterOf(vote.strategyId, map);
    const existing = byCluster.get(cluster);
    if (!existing) {
      byCluster.set(cluster, { cluster, strength: vote.strength, members: [vote.strategyId] });
      continue;
    }
    existing.members.push(vote.strategyId);
    if (vote.strength > existing.strength) existing.strength = vote.strength;
  }
  return [...byCluster.values()].sort((a, b) => b.strength - a.strength);
}

/**
 * Extra credit for depth inside a cluster, saturating fast.
 *
 * A second moving average agreeing is worth something — it rules out a single
 * indicator's quirk. A sixth is worth nothing. Capped at 2 extra members per
 * cluster and 4.5 points overall so breadth can never substitute for genuine
 * independence.
 */
export function clusterDepthBonus(rollups: ClusterRollup[]): number {
  const raw = rollups.reduce(
    (sum, rollup) => sum + Math.min(rollup.members.length - 1, 2) * 1.5,
    0,
  );
  return Math.min(raw, 4.5);
}

// --- measuring the map from real votes ---------------------------------------

export type AgreementMatrix = {
  strategyIds: string[];
  /** agreement[i][j] = share of co-voting bars where i and j voted the same way. */
  agreement: number[][];
  /** coVotes[i][j] = bars on which BOTH strategies cast a vote. */
  coVotes: number[][];
};

/**
 * How often does each pair of strategies vote the same direction, given both
 * voted at all?
 *
 * Bars where only one of a pair votes say nothing about whether they are the
 * same signal, so they are excluded from that pair's denominator — otherwise a
 * rarely-firing strategy would look uncorrelated with everything simply by
 * abstaining.
 */
export function computeAgreementMatrix({
  candles,
  timeframe,
  mode,
  strategyIds,
  step = 1,
}: {
  candles: SignalEngineCandle[];
  timeframe: SignalTimeframe;
  mode: SignalMode;
  strategyIds: string[];
  /** Evaluate every Nth bar. Consecutive bars are near-duplicates; stepping cuts cost without losing signal. */
  step?: number;
}): AgreementMatrix {
  const complete = candles.filter((candle) => candle.complete);
  const eligible = strategyIds.filter((id) => {
    const capability = getEngineStrategyCapability(id);
    return capability.implemented && capability.timeframes.includes(timeframe);
  });
  const size = eligible.length;
  const same = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const both = Array.from({ length: size }, () => new Array<number>(size).fill(0));

  for (let index = 60; index < complete.length; index += step) {
    const window = complete.slice(0, index + 1);
    let atr: number;
    try {
      atr = latestAtr(window);
    } catch {
      continue;
    }
    const directions = eligible.map((id) => {
      const vote = evaluateStrategy(id, window, atr, mode);
      return vote ? vote.direction : null;
    });
    for (let i = 0; i < size; i += 1) {
      if (!directions[i]) continue;
      for (let j = i + 1; j < size; j += 1) {
        if (!directions[j]) continue;
        both[i][j] += 1;
        both[j][i] += 1;
        if (directions[i] === directions[j]) {
          same[i][j] += 1;
          same[j][i] += 1;
        }
      }
    }
  }

  const agreement = same.map((row, i) =>
    row.map((value, j) => (both[i][j] > 0 ? +(value / both[i][j]).toFixed(4) : 0)),
  );
  return { strategyIds: eligible, agreement, coVotes: both };
}

/**
 * Single-linkage clustering at a fixed agreement threshold.
 *
 * Single-linkage (rather than complete or average) because the property being
 * detected is transitive in practice: if A duplicates B and B duplicates C,
 * treating all three as one opinion is the conservative call even when A and C
 * look less similar directly.
 *
 * Pairs with fewer than `minCoVotes` shared bars are treated as unrelated — a
 * 100% agreement rate over four bars is noise, and merging on it would collapse
 * the whole catalog into one cluster.
 */
export function clusterByAgreement(
  matrix: AgreementMatrix,
  threshold = 0.8,
  minCoVotes = 50,
): Record<string, string> {
  const { strategyIds, agreement, coVotes } = matrix;
  const parent = strategyIds.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };

  for (let i = 0; i < strategyIds.length; i += 1) {
    for (let j = i + 1; j < strategyIds.length; j += 1) {
      if (coVotes[i][j] >= minCoVotes && agreement[i][j] >= threshold) union(i, j);
    }
  }

  const map: Record<string, string> = {};
  for (let i = 0; i < strategyIds.length; i += 1) {
    map[strategyIds[i]] = `measured:${strategyIds[find(i)]}`;
  }
  return map;
}
