// ============================================================================
// SYNTHETIC-DATA SANDBOX ONLY — DO NOT TREAT THESE RESULTS AS EVIDENCE.
// ============================================================================
// This engine runs entirely on generateSyntheticCandles() below, a seeded
// random-walk generator. It does NOT fetch real market data, and it replays
// its OWN parallel 7-strategy reimplementation (STRATEGY_DEFAULTS below),
// which is not the same strategy set as the live scanner
// (IMPLEMENTED_STRATEGIES in signal-engine.ts, 31 strategies — rsi_meanrev
// and donchian_breakout here don't even exist there). A great win rate from
// this file says nothing about whether the real signal engine has an edge.
//
// For honest, real-candle evidence about the actual scanner
// (scanCandlesForSignal), use src/lib/real-backtest.ts /
// src/lib/real-backtest.server.ts instead. This file is kept only because the
// existing "Strategy Backtester" UI sandbox (optimizer / Monte Carlo /
// parameter sweeps) still depends on it as a quick, deterministic scratchpad
// — every result it returns is stamped `dataSource: "synthetic"` so the UI
// can never present it as real.
// ============================================================================

export type Candle = { t: number; o: number; h: number; l: number; c: number };

export type Trade = {
  idx: number;
  time: number;
  dir: "long" | "short";
  entry: number;
  exit: number;
  sl: number;
  tp: number;
  pips: number;
  r: number;
  outcome: "tp" | "sl" | "eod";
};

export type BacktestResult = {
  pair: string;
  strategy: string;
  params: Record<string, number>;
  bars: number;
  trades: Trade[];
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitFactor: number;
    expectancyR: number;
    netPips: number;
    maxDrawdownPct: number;
    sharpe: number;
    avgWinR: number;
    avgLossR: number;
    longestWinStreak: number;
    longestLossStreak: number;
  };
  equity: number[];
  /** Always "synthetic" — see the banner at the top of this file. Stamped on every result so the UI can never mistake this for real-market evidence. */
  dataSource: "synthetic";
};

export type MonteCarloResult = {
  sims: number;
  finalR: { p5: number; p50: number; p95: number; mean: number };
  maxDD: { p5: number; p50: number; p95: number; mean: number };
  ruinProbability: number;
  curves: number[][];
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

function gauss(rand: () => number) {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function pipSize(pair: string) {
  if (pair === "XAUUSD") return 0.1;
  return pair.endsWith("JPY") ? 0.01 : 0.0001;
}

/** Seeded random-walk candle generator — SYNTHETIC DATA, see the file banner above. */
export function generateSyntheticCandles(pair: string, bars: number, seedSalt = 0): Candle[] {
  const rand = rng(hash(pair) + seedSalt);
  const isJPY = pair.endsWith("JPY");
  const isGold = pair === "XAUUSD";
  const isBTC = pair === "BTCUSD";
  const isETH = pair === "ETHUSD";
  // Seed prices are only the synthetic walk's realistic-looking starting
  // point — this is data realism for the sandbox, not a trading threshold.
  // Before this fix BTCUSD/ETHUSD fell through to the FX default (1.1),
  // which is nowhere near a plausible crypto price.
  let price = isGold ? 2600 : isJPY ? 150 : isBTC ? 65_000 : isETH ? 3_200 : 1.1;
  const vol = (isGold ? 0.006 : isBTC || isETH ? 0.02 : 0.0035) / Math.sqrt(24);
  const out: Candle[] = [];
  let drift = 0;
  const now = Date.now();
  for (let i = 0; i < bars; i++) {
    // regime-switching drift for realistic trends and ranges
    if (i % 60 === 0) drift = (rand() - 0.5) * vol * 0.6;
    const step = drift + gauss(rand) * vol;
    const o = price;
    const c = o * (1 + step);
    const wick = Math.abs(step) * o * (0.4 + rand());
    const h = Math.max(o, c) + wick;
    const l = Math.min(o, c) - wick;
    price = c;
    out.push({ t: now - (bars - i) * 3600_000, o, h, l, c });
  }
  return out;
}

// ---- indicators ----
function ema(values: number[], period: number) {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(values: number[], period: number) {
  const out: number[] = new Array(values.length).fill(50);
  let gain = 0,
    loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0),
      l = Math.max(-d, 0);
    if (i <= period) {
      gain += g / period;
      loss += l / period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(candles: Candle[], period: number) {
  const out: number[] = [];
  let prev = candles[0].h - candles[0].l;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const pc = i > 0 ? candles[i - 1].c : c.o;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    prev = i === 0 ? tr : (prev * (period - 1) + tr) / period;
    out.push(prev);
  }
  return out;
}

function stdev(values: number[], period: number, i: number) {
  const start = Math.max(0, i - period + 1);
  const slice = values.slice(start, i + 1);
  const m = slice.reduce((a, b) => a + b, 0) / slice.length;
  return Math.sqrt(slice.reduce((a, b) => a + (b - m) ** 2, 0) / slice.length);
}

export type StrategyId =
  | "ema_trend"
  | "macd_hist"
  | "rsi_meanrev"
  | "bollinger_squeeze"
  | "donchian_breakout"
  | "supertrend"
  | "ichimoku";

export const STRATEGY_DEFAULTS: Record<StrategyId, Record<string, number>> = {
  ema_trend: { fast: 12, slow: 34, atrPeriod: 14, slMult: 1.5, tpMult: 3 },
  macd_hist: { fast: 12, slow: 26, signal: 9, atrPeriod: 14, slMult: 1.5, tpMult: 3 },
  rsi_meanrev: { period: 14, oversold: 30, overbought: 70, atrPeriod: 14, slMult: 1.2, tpMult: 2 },
  bollinger_squeeze: { period: 20, mult: 2, atrPeriod: 14, slMult: 1.5, tpMult: 3 },
  donchian_breakout: { lookback: 20, atrPeriod: 14, slMult: 2, tpMult: 4 },
  supertrend: { atrPeriod: 10, mult: 3, slMult: 1.5, tpMult: 3 },
  ichimoku: { conversion: 9, base: 26, atrPeriod: 14, slMult: 1.8, tpMult: 3.6 },
};

/** Returns +1 (long), -1 (short) or 0 (flat) for each bar. */
function signalSeries(id: StrategyId, candles: Candle[], p: Record<string, number>): number[] {
  const close = candles.map((c) => c.c);
  const n = close.length;
  const sig = new Array(n).fill(0);

  if (id === "ema_trend") {
    const f = ema(close, p.fast),
      s = ema(close, p.slow);
    for (let i = 1; i < n; i++) {
      if (f[i - 1] <= s[i - 1] && f[i] > s[i]) sig[i] = 1;
      else if (f[i - 1] >= s[i - 1] && f[i] < s[i]) sig[i] = -1;
    }
  } else if (id === "macd_hist") {
    const macd = ema(close, p.fast).map((v, i) => v - ema(close, p.slow)[i]);
    const sline = ema(macd, p.signal);
    for (let i = 1; i < n; i++) {
      const h = macd[i] - sline[i],
        hp = macd[i - 1] - sline[i - 1];
      if (hp <= 0 && h > 0) sig[i] = 1;
      else if (hp >= 0 && h < 0) sig[i] = -1;
    }
  } else if (id === "rsi_meanrev") {
    const r = rsi(close, p.period);
    for (let i = 1; i < n; i++) {
      if (r[i - 1] < p.oversold && r[i] >= p.oversold) sig[i] = 1;
      else if (r[i - 1] > p.overbought && r[i] <= p.overbought) sig[i] = -1;
    }
  } else if (id === "bollinger_squeeze") {
    const mid = ema(close, p.period);
    for (let i = p.period; i < n; i++) {
      const sd = stdev(close, p.period, i);
      const upper = mid[i] + p.mult * sd,
        lower = mid[i] - p.mult * sd;
      if (close[i - 1] <= upper && close[i] > upper) sig[i] = 1;
      else if (close[i - 1] >= lower && close[i] < lower) sig[i] = -1;
    }
  } else if (id === "donchian_breakout") {
    const lb = Math.floor(p.lookback);
    for (let i = lb; i < n; i++) {
      const hh = Math.max(...candles.slice(i - lb, i).map((c) => c.h));
      const ll = Math.min(...candles.slice(i - lb, i).map((c) => c.l));
      if (close[i] > hh) sig[i] = 1;
      else if (close[i] < ll) sig[i] = -1;
    }
  } else if (id === "supertrend") {
    const a = atr(candles, p.atrPeriod);
    let trend = 1;
    for (let i = 1; i < n; i++) {
      const upper = (candles[i].h + candles[i].l) / 2 + p.mult * a[i];
      const lower = (candles[i].h + candles[i].l) / 2 - p.mult * a[i];
      const newTrend = close[i] > upper ? 1 : close[i] < lower ? -1 : trend;
      if (newTrend !== trend) sig[i] = newTrend;
      trend = newTrend;
    }
  } else if (id === "ichimoku") {
    const conv: number[] = [],
      base: number[] = [];
    for (let i = 0; i < n; i++) {
      const cw = candles.slice(Math.max(0, i - p.conversion + 1), i + 1);
      const bw = candles.slice(Math.max(0, i - p.base + 1), i + 1);
      conv.push((Math.max(...cw.map((c) => c.h)) + Math.min(...cw.map((c) => c.l))) / 2);
      base.push((Math.max(...bw.map((c) => c.h)) + Math.min(...bw.map((c) => c.l))) / 2);
    }
    for (let i = 1; i < n; i++) {
      if (conv[i - 1] <= base[i - 1] && conv[i] > base[i]) sig[i] = 1;
      else if (conv[i - 1] >= base[i - 1] && conv[i] < base[i]) sig[i] = -1;
    }
  }
  return sig;
}

export function runBacktest(
  pair: string,
  strategy: StrategyId,
  bars: number,
  paramsOverride: Partial<Record<string, number>> = {},
): BacktestResult {
  const params: Record<string, number> = {
    ...STRATEGY_DEFAULTS[strategy],
    ...(paramsOverride as Record<string, number>),
  };
  const candles = generateSyntheticCandles(pair, bars);
  const a = atr(candles, params.atrPeriod ?? 14);
  const sig = signalSeries(strategy, candles, params);
  const pip = pipSize(pair);

  const trades: Trade[] = [];
  let i = 1;
  while (i < candles.length) {
    const dir = sig[i];
    if (dir === 0) {
      i++;
      continue;
    }
    const entry = candles[i].c;
    const slDist = a[i] * (params.slMult ?? 1.5);
    const tpDist = a[i] * (params.tpMult ?? 3);
    const sl = dir === 1 ? entry - slDist : entry + slDist;
    const tp = dir === 1 ? entry + tpDist : entry - tpDist;
    let exit = entry,
      outcome: Trade["outcome"] = "eod",
      j = i + 1;
    for (; j < Math.min(candles.length, i + 200); j++) {
      const c = candles[j];
      const hitSL = dir === 1 ? c.l <= sl : c.h >= sl;
      const hitTP = dir === 1 ? c.h >= tp : c.l <= tp;
      if (hitSL && hitTP) {
        exit = sl;
        outcome = "sl";
        break;
      }
      if (hitSL) {
        exit = sl;
        outcome = "sl";
        break;
      }
      if (hitTP) {
        exit = tp;
        outcome = "tp";
        break;
      }
    }
    if (outcome === "eod") exit = candles[Math.min(j, candles.length - 1)].c;
    const move = (exit - entry) * dir;
    trades.push({
      idx: trades.length + 1,
      time: candles[i].t,
      dir: dir === 1 ? "long" : "short",
      entry: +entry.toFixed(5),
      exit: +exit.toFixed(5),
      sl: +sl.toFixed(5),
      tp: +tp.toFixed(5),
      pips: +(move / pip).toFixed(1),
      r: +(move / slDist).toFixed(3),
      outcome,
    });
    i = j + 1;
  }

  return {
    pair,
    strategy,
    params,
    bars,
    trades,
    stats: computeStats(trades),
    equity: equityCurve(trades),
    dataSource: "synthetic",
  };
}

function equityCurve(trades: Trade[]) {
  let eq = 0;
  return [0, ...trades.map((t) => (eq += t.r))];
}

function computeStats(trades: Trade[]): BacktestResult["stats"] {
  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  const grossWin = wins.reduce((a, t) => a + t.r, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.r, 0));
  const eq = equityCurve(trades);
  let peak = eq[0],
    maxDD = 0;
  for (const v of eq) {
    peak = Math.max(peak, v);
    maxDD = Math.max(maxDD, peak - v);
  }
  const rs = trades.map((t) => t.r);
  const mean = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const sd = rs.length ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length) : 0;

  let ws = 0,
    ls = 0,
    bw = 0,
    bl = 0;
  for (const t of trades) {
    if (t.r > 0) {
      ws++;
      ls = 0;
      bw = Math.max(bw, ws);
    } else {
      ls++;
      ws = 0;
      bl = Math.max(bl, ls);
    }
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : 0,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : grossWin > 0 ? 99 : 0,
    expectancyR: +mean.toFixed(3),
    netPips: +trades.reduce((a, t) => a + t.pips, 0).toFixed(1),
    maxDrawdownPct: +maxDD.toFixed(2),
    sharpe: sd ? +((mean / sd) * Math.sqrt(trades.length || 1)).toFixed(2) : 0,
    avgWinR: wins.length ? +(grossWin / wins.length).toFixed(2) : 0,
    avgLossR: losses.length ? +(-grossLoss / losses.length).toFixed(2) : 0,
    longestWinStreak: bw,
    longestLossStreak: bl,
  };
}

export function monteCarlo(trades: Trade[], sims: number, ruinR: number): MonteCarloResult {
  const rs = trades.map((t) => t.r);
  const rand = rng(rs.length * 7919 + 13);
  const finals: number[] = [],
    dds: number[] = [],
    curves: number[][] = [];
  let ruined = 0;
  for (let s = 0; s < sims; s++) {
    let eq = 0,
      peak = 0,
      dd = 0,
      hitRuin = false;
    const curve: number[] = [0];
    for (let i = 0; i < rs.length; i++) {
      eq += rs[Math.floor(rand() * rs.length)];
      peak = Math.max(peak, eq);
      dd = Math.max(dd, peak - eq);
      if (dd >= ruinR) hitRuin = true;
      curve.push(+eq.toFixed(3));
    }
    if (hitRuin) ruined++;
    finals.push(eq);
    dds.push(dd);
    if (s < 40) curves.push(curve);
  }
  const q = (arr: number[], p: number) => {
    const a = [...arr].sort((x, y) => x - y);
    return +(a[Math.min(a.length - 1, Math.floor(p * a.length))] ?? 0).toFixed(2);
  };
  const avg = (a: number[]) => +(a.reduce((x, y) => x + y, 0) / (a.length || 1)).toFixed(2);
  return {
    sims,
    finalR: { p5: q(finals, 0.05), p50: q(finals, 0.5), p95: q(finals, 0.95), mean: avg(finals) },
    maxDD: { p5: q(dds, 0.05), p50: q(dds, 0.5), p95: q(dds, 0.95), mean: avg(dds) },
    ruinProbability: +((ruined / sims) * 100).toFixed(1),
    curves,
  };
}

const OPT_GRID: Record<StrategyId, Record<string, number[]>> = {
  ema_trend: { fast: [8, 12, 21], slow: [34, 55, 89], slMult: [1.2, 1.5, 2], tpMult: [2, 3, 4] },
  macd_hist: { fast: [8, 12], slow: [21, 26], signal: [7, 9], slMult: [1.2, 1.5], tpMult: [2, 3] },
  rsi_meanrev: {
    period: [9, 14, 21],
    oversold: [20, 30],
    overbought: [70, 80],
    tpMult: [1.5, 2, 3],
  },
  bollinger_squeeze: { period: [14, 20, 30], mult: [1.5, 2, 2.5], tpMult: [2, 3, 4] },
  donchian_breakout: { lookback: [10, 20, 40], slMult: [1.5, 2, 3], tpMult: [3, 4, 6] },
  supertrend: { atrPeriod: [7, 10, 14], mult: [2, 3, 4], tpMult: [2, 3, 4] },
  ichimoku: { conversion: [7, 9, 12], base: [22, 26, 34], tpMult: [2.5, 3.6, 5] },
};

export function optimize(pair: string, strategy: StrategyId, bars: number, topN = 8) {
  const grid = OPT_GRID[strategy];
  const keys = Object.keys(grid);
  const combos: Record<string, number>[] = [{}];
  for (const k of keys) {
    const next: Record<string, number>[] = [];
    for (const base of combos) for (const v of grid[k]) next.push({ ...base, [k]: v });
    combos.length = 0;
    combos.push(...next);
  }
  const results = combos.map((params) => {
    const r = runBacktest(pair, strategy, bars, params);
    const score = r.stats.trades < 10 ? -99 : r.stats.expectancyR * Math.sqrt(r.stats.trades);
    return { params, stats: r.stats, score: +score.toFixed(3) };
  });
  results.sort((a, b) => b.score - a.score);
  return { tested: results.length, top: results.slice(0, topN) };
}
