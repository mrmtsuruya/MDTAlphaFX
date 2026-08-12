import assert from "node:assert/strict";
import test from "node:test";
import { createTvKeylessXauusdProvider, KeylessFeedError } from "./tv-keyless-provider.ts";
import { validateCandles, validateQuote, type TwoSidedCandle } from "./xauusd-market-data.ts";

const NOW = () => new Date("2026-08-11T07:42:11.000Z");

// d[1]=close, d[2]=bid, d[3]=ask
const TV_PAYLOAD = {
  data: [
    {
      s: "OANDA:XAUUSD",
      d: ["OANDA:XAUUSD", "4403.85", "4403.80", "4403.90", "4404.0", "4403.5", "4403.0"],
    },
  ],
};

type Bar = { time: string; o: number; h: number; l: number; c: number };

const M1_BARS: Bar[] = [
  { time: "2026-08-11T07:39:00.000Z", o: 4399.8, h: 4400.3, l: 4399.5, c: 4400.0 },
  { time: "2026-08-11T07:40:00.000Z", o: 4400.0, h: 4400.4, l: 4399.8, c: 4400.1 },
  { time: "2026-08-11T07:41:00.000Z", o: 4400.1, h: 4400.5, l: 4399.9, c: 4400.2 },
  // Incomplete at NOW (07:42:00 + 60s > 07:42:11) — must be filtered out.
  { time: "2026-08-11T07:42:00.000Z", o: 4400.2, h: 4400.6, l: 4400.0, c: 4400.3 },
];

function yahooPayload(bars: Bar[]) {
  return {
    chart: {
      result: [
        {
          timestamp: bars.map((b) => Date.parse(b.time) / 1000),
          indicators: {
            quote: [
              {
                open: bars.map((b) => b.o),
                high: bars.map((b) => b.h),
                low: bars.map((b) => b.l),
                close: bars.map((b) => b.c),
                volume: bars.map(() => 0),
              },
            ],
          },
        },
      ],
    },
  };
}

type CapturedRequest = { method: string; url: string };

function buildFakeFetch(handler: (url: string) => { status: number; body: unknown }) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    requests.push({ method: init?.method ?? "GET", url });
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { requests, fetchImpl };
}

function router(payloads: Record<string, unknown>) {
  return (url: string): { status: number; body: unknown } => {
    for (const [needle, body] of Object.entries(payloads)) {
      if (url.includes(needle)) return { status: 200, body };
    }
    return { status: 404, body: { errorMessage: "unexpected route" } };
  };
}

function makeProvider(fetchImpl: typeof fetch) {
  return createTvKeylessXauusdProvider({ now: NOW }, fetchImpl);
}

test("quote parses bid/ask from the TradingView scanner row", async () => {
  const { fetchImpl } = buildFakeFetch(router({ "scanner.tradingview.com": TV_PAYLOAD }));
  const quote = await makeProvider(fetchImpl).quote();
  assert.equal(quote.provider, "TV_OANDA_FEED");
  assert.equal(quote.instrument, "XAU_USD");
  assert.equal(quote.bid, 4403.8);
  assert.equal(quote.ask, 4403.9);
  assert.equal(quote.tradeable, true);
  assert.equal(quote.providerTime, NOW().toISOString());
});

test("quote is cached for 30s so the cycle does not pound the scanner", async () => {
  const { requests, fetchImpl } = buildFakeFetch(router({ "scanner.tradingview.com": TV_PAYLOAD }));
  const provider = makeProvider(fetchImpl);
  await provider.quote();
  await provider.quote();
  assert.equal(
    requests.filter((r) => r.url.includes("scanner.tradingview.com")).length,
    1,
    "second quote within the cache window must not refetch",
  );
});

test("completedCandles synthesizes bid/ask around the live spread and rebases GC=F to spot", async () => {
  const { fetchImpl } = buildFakeFetch(
    router({
      "scanner.tradingview.com": TV_PAYLOAD,
      "query1.finance.yahoo.com": yahooPayload(M1_BARS),
    }),
  );
  const candles: TwoSidedCandle[] = await makeProvider(fetchImpl).completedCandles("M1", 400);
  assert.equal(candles.length, 3, "incomplete candle must be filtered out");
  assert.equal(candles[0].timeframe, "M1");
  assert.equal(candles[0].instrument, "XAU_USD");

  // Spread = 0.10 (bid 4403.80 / ask 4403.90); every side pair must differ by it.
  const spread = 0.1;
  for (const candle of candles) {
    assert.ok(Math.abs(candle.ask.open - candle.bid.open - spread) < 1e-9);
    assert.ok(Math.abs(candle.ask.close - candle.bid.close - spread) < 1e-9);
  }

  // GC=F (4400ish) rebased onto spot (4403.85): the last complete candle's
  // mid close must land on the rebased close.
  const last = candles[2];
  const expectedMid = M1_BARS[2].c + (4403.85 - M1_BARS[3].c); // delta from last bar (incl. incomplete)
  const actualMid = (last.bid.close + last.ask.close) / 2;
  assert.ok(Math.abs(actualMid - expectedMid) < 1e-9, `mid ${actualMid} vs ${expectedMid}`);
});

test("completedCandles output satisfies the fail-closed contract", async () => {
  const { fetchImpl } = buildFakeFetch(
    router({
      "scanner.tradingview.com": TV_PAYLOAD,
      "query1.finance.yahoo.com": yahooPayload(M1_BARS),
    }),
  );
  const provider = makeProvider(fetchImpl);
  const quote = await provider.quote();
  const candles = await provider.completedCandles("M1", 400);
  assert.deepEqual(validateQuote(quote, NOW().getTime()), { ok: true });
  assert.deepEqual(validateCandles(candles, "M1"), { ok: true });
});

test("H4 candles are bucketed from 1h bars into 4-hour windows", async () => {
  const bars: Bar[] = [];
  for (let h = 0; h < 8; h++) {
    const time = new Date(`2026-08-11T0${h}:00:00.000Z`);
    if (Date.parse(time.toISOString()) + 14_400_000 > NOW().getTime()) break;
    bars.push({ time: time.toISOString(), o: 4400, h: 4401, l: 4399, c: 4400.5 });
  }
  const { fetchImpl } = buildFakeFetch(
    router({
      "scanner.tradingview.com": TV_PAYLOAD,
      "query1.finance.yahoo.com": yahooPayload(bars),
    }),
  );
  const candles = await makeProvider(fetchImpl).completedCandles("H4", 400);
  assert.ok(candles.length >= 1);
  for (const candle of candles) {
    const ms = Date.parse(candle.time);
    assert.equal(ms % 14_400_000, 0, "H4 bucket must start on a 4h boundary");
  }
});

test("latestCompleted returns the last complete candle time and null for empty timeframes", async () => {
  const { fetchImpl } = buildFakeFetch(
    router({
      "scanner.tradingview.com": TV_PAYLOAD,
      "query1.finance.yahoo.com": yahooPayload(M1_BARS),
    }),
  );
  const provider = makeProvider(fetchImpl);
  const latest = await provider.latestCompleted(["M1", "D1"]);
  assert.equal(latest.M1, "2026-08-11T07:41:00.000Z");
  assert.equal(latest.D1, null, "no complete D1 candle in the fixture");
});

test("health reports ok on a fresh quote and the feed code on failure", async () => {
  const ok = buildFakeFetch(router({ "scanner.tradingview.com": TV_PAYLOAD }));
  const healthOk = await makeProvider(ok.fetchImpl).health();
  assert.deepEqual(healthOk, { ok: true, code: "ok", checkedAt: NOW().toISOString() });

  const broken = buildFakeFetch(router({ "scanner.tradingview.com": { data: [] } }));
  const healthBroken = await makeProvider(broken.fetchImpl).health();
  assert.equal(healthBroken.ok, false);
  assert.equal(healthBroken.code, "quote_unavailable");
});

test("unreachable feed and malformed payloads map to stable codes", async () => {
  const down = buildFakeFetch(() => ({ status: 500, body: {} }));
  await assert.rejects(
    () => makeProvider(down.fetchImpl).quote(),
    (err: unknown) => err instanceof KeylessFeedError && err.code === "feed_unavailable",
  );

  const garbage = buildFakeFetch(() => ({
    status: 200,
    body: { chart: { result: [] } },
  }));
  await assert.rejects(
    () => makeProvider(garbage.fetchImpl).completedCandles("M1", 400),
    (err: unknown) => err instanceof KeylessFeedError && err.code === "candles_unavailable",
  );
});
