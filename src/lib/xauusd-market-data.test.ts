import assert from "node:assert/strict";
import test from "node:test";
import {
  snapshotContentHash,
  toMidCandles,
  validateCandles,
  validateQuote,
  validateSpreadForSignal,
  type DataQualityCode,
  type NativeXauusdQuote,
  type PaperTimeframe,
  type TwoSidedCandle,
  type ValidationResult,
} from "./xauusd-market-data.ts";

function codeOf(result: ValidationResult): DataQualityCode | null {
  return result.ok ? null : result.code;
}

const NOW = Date.parse("2026-08-11T07:42:18Z");

const validQuote: NativeXauusdQuote = {
  provider: "OANDA_V20_PRACTICE",
  instrument: "XAU_USD",
  bid: 3400.1,
  ask: 3400.3,
  providerTime: "2026-08-11T07:42:10.000Z",
  receivedAt: "2026-08-11T07:42:11.000Z",
  tradeable: true,
};

function validCandles(
  count = 60,
  timeframe: PaperTimeframe = "M1",
  start = Date.parse("2026-08-11T06:42:00Z"),
): TwoSidedCandle[] {
  const intervalMs = {
    M1: 60_000,
    M5: 5 * 60_000,
    M15: 15 * 60_000,
    M30: 30 * 60_000,
    H1: 60 * 60_000,
    H4: 4 * 60 * 60_000,
    D1: 24 * 60 * 60_000,
  }[timeframe];
  return Array.from({ length: count }, (_, i) => ({
    instrument: "XAU_USD" as const,
    timeframe,
    time: new Date(start + i * intervalMs).toISOString(),
    bid: { open: 3400, high: 3400.2, low: 3399.8, close: 3400.1 },
    ask: { open: 3400.2, high: 3400.4, low: 3400, close: 3400.3 },
    volume: 1_000 + i,
    complete: true as const,
  }));
}

test("valid quote and candles pass with ok:true", () => {
  assert.deepEqual(validateQuote(validQuote, NOW), { ok: true });
  assert.deepEqual(validateCandles(validCandles(), "M1"), { ok: true });
  assert.deepEqual(validateSpreadForSignal(validQuote, 3400, 3397), { ok: true });
});

test("rejects stale quote older than 15 seconds", () => {
  assert.equal(
    codeOf(validateQuote({ ...validQuote, providerTime: "2026-08-11T07:41:00Z" }, NOW)),
    "stale_quote",
  );
});

test("rejects crossed quote where ask is not above bid", () => {
  assert.equal(codeOf(validateQuote({ ...validQuote, ask: validQuote.bid }, NOW)), "crossed_quote");
  assert.equal(
    codeOf(validateQuote({ ...validQuote, ask: validQuote.bid - 0.1 }, NOW)),
    "crossed_quote",
  );
});

test("rejects mixed instrument quote", () => {
  assert.equal(
    codeOf(validateQuote({ ...validQuote, instrument: "GC=F" } as never, NOW)),
    "instrument_mismatch",
  );
});

test("rejects non-tradeable quote", () => {
  assert.equal(codeOf(validateQuote({ ...validQuote, tradeable: false }, NOW)), "not_tradeable");
});

test("rejects descending candles", () => {
  assert.equal(codeOf(validateCandles([...validCandles()].reverse(), "M1")), "candles_not_ascending");
});

test("rejects duplicate candle timestamps", () => {
  const candles = validCandles();
  const duplicated = [candles[0], candles[0], ...candles.slice(1)];
  assert.equal(codeOf(validateCandles(duplicated, "M1")), "duplicate_candle");
});

test("rejects incomplete candle", () => {
  assert.equal(
    codeOf(validateCandles([{ ...validCandles()[0], complete: false } as never], "M1")),
    "incomplete_candle",
  );
});

test("rejects invalid bid/ask OHLC invariants", () => {
  const badHigh = validCandles();
  badHigh[0] = {
    ...badHigh[0],
    bid: { open: 3400, high: 3399.9, low: 3399.8, close: 3400.1 },
  };
  assert.equal(codeOf(validateCandles(badHigh, "M1")), "invalid_ohlc");
  const badLow = validCandles();
  badLow[0] = {
    ...badLow[0],
    ask: { open: 3400.2, high: 3400.4, low: 3400.5, close: 3400.3 },
  };
  assert.equal(codeOf(validateCandles(badLow, "M1")), "invalid_ohlc");
});

test("rejects candles off the timeframe grid", () => {
  const candles = validCandles();
  candles[1] = {
    ...candles[1],
    time: new Date(Date.parse(candles[1].time) + 30_000).toISOString(),
  };
  assert.equal(codeOf(validateCandles(candles, "M1")), "candle_gap");
});

test("rejects spread wider than 10% of the signal's stop distance", () => {
  assert.equal(codeOf(validateSpreadForSignal(validQuote, 3400, 3399)), "spread_too_wide");
  assert.equal(codeOf(validateSpreadForSignal(validQuote, 3400, 3400)), "invalid_stop_distance");
});

test("toMidCandles averages every bid/ask OHLC field and preserves time/volume", () => {
  const mid = toMidCandles(validCandles(2));
  assert.deepEqual(mid, [
    {
      time: "2026-08-11T06:42:00.000Z",
      open: 3400.1,
      high: 3400.3,
      low: 3399.9,
      close: 3400.2,
      complete: true,
      volume: 1_000,
    },
    {
      time: "2026-08-11T06:43:00.000Z",
      open: 3400.1,
      high: 3400.3,
      low: 3399.9,
      close: 3400.2,
      complete: true,
      volume: 1_001,
    },
  ]);
});

test("snapshotContentHash is stable and sensitive to any input change", async () => {
  const candles = validCandles();
  const first = await snapshotContentHash(validQuote, "M1", candles);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, await snapshotContentHash(validQuote, "M1", candles));

  const changedBid = candles.map((c, i) =>
    i === 0 ? { ...c, bid: { ...c.bid, close: 3400.15 } } : c,
  );
  assert.notEqual(await snapshotContentHash(validQuote, "M1", changedBid), first);
  assert.notEqual(
    await snapshotContentHash({ ...validQuote, ask: 3400.31 }, "M1", candles),
    first,
  );
  assert.notEqual(await snapshotContentHash(validQuote, "H1", candles), first);
});
