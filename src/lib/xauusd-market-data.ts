// Fail-closed XAUUSD market-data contract for the auto-paper worker.
//
// Everything the worker consumes passes through this module's validation
// before any engine runs or any trade is created. A single failed check
// yields a machine-readable `DataQualityCode` and produces zero signals and
// zero fills. There is deliberately no "close the gap" or "substitute the
// close" fallback anywhere: the present TradingView/Yahoo feed is
// `reference_only` and can never satisfy this contract.

import type { SignalEngineCandle } from "./signal-engine.ts";

export const PAPER_TIMEFRAMES = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"] as const;
export type PaperTimeframe = (typeof PAPER_TIMEFRAMES)[number];

export type NativeXauusdQuote = {
  provider: "OANDA_V20_PRACTICE";
  instrument: "XAU_USD";
  bid: number;
  ask: number;
  providerTime: string;
  receivedAt: string;
  tradeable: boolean;
};

export type SideOhlc = { open: number; high: number; low: number; close: number };
export type TwoSidedCandle = {
  instrument: "XAU_USD";
  timeframe: PaperTimeframe;
  time: string;
  bid: SideOhlc;
  ask: SideOhlc;
  volume: number;
  complete: true;
};

export interface XauusdMarketDataProvider {
  health(): Promise<{ ok: boolean; code: string; checkedAt: string }>;
  quote(): Promise<NativeXauusdQuote>;
  latestCompleted(timeframes: PaperTimeframe[]): Promise<Record<PaperTimeframe, string | null>>;
  completedCandles(timeframe: PaperTimeframe, count: number): Promise<TwoSidedCandle[]>;
}

export type DataQualityCode =
  | "not_tradeable"
  | "stale_quote"
  | "crossed_quote"
  | "instrument_mismatch"
  | "candles_not_ascending"
  | "duplicate_candle"
  | "incomplete_candle"
  | "invalid_ohlc"
  | "candle_gap"
  | "invalid_stop_distance"
  | "spread_too_wide";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: DataQualityCode; detail: string };

/** Quote maximum age: 15,000 ms — anything older is not the market, it is a museum. */
const QUOTE_MAX_AGE_MS = 15_000;

/** Nominal candle interval per paper timeframe; used for grid/continuity checks. */
const TIMEFRAME_INTERVAL_MS: Record<PaperTimeframe, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

function fail(code: DataQualityCode, detail: string): ValidationResult {
  return { ok: false, code, detail };
}

function isFinitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function validSide(side: SideOhlc): boolean {
  return (
    isFinitePositive(side.open) &&
    isFinitePositive(side.high) &&
    isFinitePositive(side.low) &&
    isFinitePositive(side.close) &&
    side.high >= Math.max(side.open, side.close) &&
    side.low <= Math.min(side.open, side.close)
  );
}

export function validateQuote(quote: NativeXauusdQuote, now: number): ValidationResult {
  if (quote.instrument !== "XAU_USD")
    return fail("instrument_mismatch", `expected XAU_USD, got ${quote.instrument}`);
  if (quote.tradeable !== true)
    return fail("not_tradeable", "provider reports the instrument is not tradeable");
  if (!isFinitePositive(quote.bid) || !isFinitePositive(quote.ask))
    return fail("crossed_quote", "bid and ask must be finite positive numbers");
  if (quote.ask <= quote.bid)
    return fail("crossed_quote", `ask ${quote.ask} is not above bid ${quote.bid}`);
  const providerTime = Date.parse(quote.providerTime);
  if (!Number.isFinite(providerTime))
    return fail("stale_quote", `provider timestamp ${quote.providerTime} is unparseable`);
  const age = now - providerTime;
  if (age > QUOTE_MAX_AGE_MS)
    return fail("stale_quote", `quote age ${age}ms exceeds ${QUOTE_MAX_AGE_MS}ms`);
  return { ok: true };
}

export function validateCandles(
  candles: TwoSidedCandle[],
  timeframe: PaperTimeframe,
): ValidationResult {
  if (candles.length === 0) return fail("candles_not_ascending", "no candles provided");
  const interval = TIMEFRAME_INTERVAL_MS[timeframe];
  let previousTime: number | null = null;
  for (const candle of candles) {
    if (candle.instrument !== "XAU_USD")
      return fail("instrument_mismatch", `expected XAU_USD candle, got ${candle.instrument}`);
    if (candle.timeframe !== timeframe)
      return fail("instrument_mismatch", `candle timeframe ${candle.timeframe} != ${timeframe}`);
    if (candle.complete !== true)
      return fail("incomplete_candle", `candle at ${candle.time} is not complete`);
    const time = Date.parse(candle.time);
    if (!Number.isFinite(time))
      return fail("candles_not_ascending", `candle time ${candle.time} is unparseable`);
    if (previousTime !== null) {
      if (time === previousTime)
        return fail("duplicate_candle", `duplicate candle time ${candle.time}`);
      if (time < previousTime)
        return fail(
          "candles_not_ascending",
          `candle ${candle.time} precedes ${new Date(previousTime).toISOString()}`,
        );
      // Continuity: consecutive candles must land on whole interval multiples.
      // Weekend and holiday gaps are whole-interval multiples, so they pass;
      // a mid-grid timestamp means the provider emitted a malformed series.
      if ((time - previousTime) % interval !== 0)
        return fail(
          "candle_gap",
          `gap ${time - previousTime}ms is not a multiple of ${interval}ms`,
        );
    }
    if (!validSide(candle.bid) || !validSide(candle.ask))
      return fail(
        "invalid_ohlc",
        `bid/ask OHLC invariants violated at ${candle.time}`,
      );
    previousTime = time;
  }
  return { ok: true };
}

export function validateSpreadForSignal(
  quote: NativeXauusdQuote,
  entry: number,
  stopLoss: number,
): ValidationResult {
  if (!isFinitePositive(quote.bid) || !isFinitePositive(quote.ask))
    return fail("crossed_quote", "bid and ask must be finite positive numbers");
  if (quote.ask <= quote.bid)
    return fail("crossed_quote", `ask ${quote.ask} is not above bid ${quote.bid}`);
  const stopDistance = Math.abs(entry - stopLoss);
  if (!(stopDistance > 0))
    return fail("invalid_stop_distance", `stop distance ${stopDistance} is not positive`);
  const spread = quote.ask - quote.bid;
  if (spread > 0.1 * stopDistance)
    return fail(
      "spread_too_wide",
      `spread ${spread} exceeds 10% of stop distance ${stopDistance}`,
    );
  return { ok: true };
}

export function toMidCandles(candles: TwoSidedCandle[]): SignalEngineCandle[] {
  return candles.map((c) => ({
    time: c.time,
    open: (c.bid.open + c.ask.open) / 2,
    high: (c.bid.high + c.ask.high) / 2,
    low: (c.bid.low + c.ask.low) / 2,
    close: (c.bid.close + c.ask.close) / 2,
    complete: true,
    volume: c.volume,
  }));
}

/**
 * SHA-256 of a FIXED-ORDER JSON array. Every field is flattened to an array
 * position so the digest never depends on object enumeration order — two
 * providers emitting the same snapshot in different key orders must hash
 * identically, and any value change must hash differently.
 */
export async function snapshotContentHash(
  quote: NativeXauusdQuote,
  timeframe: PaperTimeframe,
  candles: TwoSidedCandle[],
): Promise<string> {
  const payload = JSON.stringify([
    quote.provider,
    quote.instrument,
    quote.bid,
    quote.ask,
    quote.providerTime,
    quote.receivedAt,
    quote.tradeable,
    timeframe,
    candles.map((c) => [
      c.instrument,
      c.timeframe,
      c.time,
      [c.bid.open, c.bid.high, c.bid.low, c.bid.close],
      [c.ask.open, c.ask.high, c.ask.low, c.ask.close],
      c.volume,
      c.complete,
    ]),
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
