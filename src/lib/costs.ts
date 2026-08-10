// Trading cost model — the single source of truth for spread that both
// outcome resolvers price fills against: replaySignalPath() in
// signal-scorer.ts and resolveSignalOutcome() in real-backtest.ts. Before
// this file existed, both resolvers tested bid/ask-referenced stop and
// target levels against mid-price candles, which under-detects stops and
// over-detects targets (see the comments above those two functions).
// Centralising the numbers here means the live scorer and the backtest
// harness can no longer silently disagree about the cost of a trade.
//
// PROVISIONAL: every value below is typed in by hand from JustMarkets'
// published Standard-account spreads, not measured. Real spread is not flat
// through the trading day — it is tighter in the London/NY overlap and can
// blow out around rollover and news — but there is no data yet to model
// that curve, and a fabricated one would be worse than an honest flat
// number: it would look precise without being true. tools/fetch-history.mjs
// now pulls real Dukascopy bid/ask history; once enough of it has landed,
// these flat numbers should be replaced with measured per-hour-of-week
// spread statistics. Do not add session multipliers or a time-of-day curve
// before that data exists.
//
// Client-safe: no server-only imports, no I/O, pure data and functions.

export type InstrumentCost = {
  /** Typical spread in PRICE units (not pips) for this instrument. */
  spread: number;
  /** Commission per 0.01 lot per side, in account currency. */
  commissionPerMicroLot: number;
  /** Units of the underlying per 1.00 lot. */
  contractSize: number;
};

/**
 * Seed values modelled on JustMarkets Standard (commission-free; XAUUSD
 * spread from ~0.20). Anything not listed here is a generic FX major/cross
 * and falls back to the 5-decimal default in costsFor() below.
 */
export const DEFAULT_COSTS: Record<string, InstrumentCost> = {
  XAUUSD: { spread: 0.2, commissionPerMicroLot: 0, contractSize: 100 },
  // JPY pairs price to 3 decimals, so 0.3 pips = 0.003 (matches
  // precisionForPair in signal-engine.ts).
  USDJPY: { spread: 0.003, commissionPerMicroLot: 0, contractSize: 100_000 },
  EURJPY: { spread: 0.003, commissionPerMicroLot: 0, contractSize: 100_000 },
  GBPJPY: { spread: 0.003, commissionPerMicroLot: 0, contractSize: 100_000 },
  AUDJPY: { spread: 0.003, commissionPerMicroLot: 0, contractSize: 100_000 },
  BTCUSD: { spread: 5, commissionPerMicroLot: 0, contractSize: 1 },
  ETHUSD: { spread: 0.5, commissionPerMicroLot: 0, contractSize: 1 },
};

// 5-decimal FX default: 0.3 pips = 0.00003. Used for every major/cross not
// explicitly seeded above (EURUSD, GBPUSD, AUDUSD, ...).
const GENERIC_FX: InstrumentCost = {
  spread: 0.00003,
  commissionPerMicroLot: 0,
  contractSize: 100_000,
};

/** Cost model for a pair; unlisted instruments fall back to the generic FX default. */
export function costsFor(pair: string): InstrumentCost {
  return DEFAULT_COSTS[pair] ?? GENERIC_FX;
}

/**
 * The stop level that exits flat after costs, once TP1 has been reached.
 *
 * It returns `entry` unchanged, and the reason that is correct is the whole
 * point of the function existing:
 *
 * A long is entered at the ASK and exits at the BID, so net P&L is
 * `bidExit - entry`. Exiting flat therefore means the *bid* must come back to
 * the entry price — not the mid. The resolvers already convert mid candles to
 * the exit side before every touch test, so handing them `entry` as the stop
 * level and reusing that same test lands exactly on breakeven. A short mirrors
 * it: entered at the bid, exits at the ask, so the ask must return to entry.
 *
 * Worth stating because it looks wrong at a glance: at the instant of entry
 * this level sits one full spread away in the ADVERSE direction. That is why
 * it is only ever armed after TP1 has been reached — arming it at entry would
 * stop the trade out immediately.
 */
export function breakevenLevel(entry: number): number {
  return entry;
}

/** Half-spread in price units — the distance from mid to bid, or mid to ask. */
export function halfSpread(pair: string): number {
  return costsFor(pair).spread / 2;
}
