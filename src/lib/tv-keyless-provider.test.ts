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

test("off-grid forming bars are bucketed so M5 scans stay valid and fingerprints stable", async () => {
  // GC=F emits a live forming bar with a non-grid timestamp that advances on
  // every fetch (e.g. 18:35:15 after 18:35:00). Left raw, the series ends in a
  // candle_gap and latestCompleted changes each minute, re-claiming the scan.
  const M5_BARS: Bar[] = [
    { time: "2026-08-11T07:30:00.000Z", o: 4400.0, h: 4400.5, l: 4399.5, c: 4400.1 },
    { time: "2026-08-11T07:35:00.000Z", o: 4400.1, h: 4400.6, l: 4399.6, c: 4400.2 },
    // Forming bar: same 07:35 bucket, off-grid stamp (07:35:15), and a live
    // tick that updates the bucket's close rather than opening a new bar.
    { time: "2026-08-11T07:35:15.000Z", o: 4400.2, h: 4400.7, l: 4399.7, c: 4400.4 },
    // 07:40 is still forming at NOW (07:40:00 + 300s = 07:45 > 07:42:11) —
    // both it and 07:45 must be filtered out, leaving 07:35 as the last
    // complete bucket.
    { time: "2026-08-11T07:40:00.000Z", o: 4400.4, h: 4400.9, l: 4399.9, c: 4400.5 },
    { time: "2026-08-11T07:45:00.000Z", o: 4400.5, h: 4401.0, l: 4400.0, c: 4400.6 },
  ];
  const { fetchImpl } = buildFakeFetch(
    router({
      "scanner.tradingview.com": TV_PAYLOAD,
      "query1.finance.yahoo.com": yahooPayload(M5_BARS),
    }),
  );
  const provider = makeProvider(fetchImpl);
  const candles = await provider.completedCandles("M5", 400);
  assert.deepEqual(validateCandles(candles, "M5"), {
    ok: true,
  });
  // The 07:35:15 forming tick must merge into the 07:35 bucket, not open a
  // separate off-grid bar.
  const times = candles.map((c) => c.time);
  assert.ok(!times.includes("2026-08-11T07:35:15.000Z"), "forming tick must not appear as its own bar");
  const last = candles[candles.length - 1];
  assert.equal(last.time, "2026-08-11T07:35:00.000Z");
  // Rebased onto spot (4403.85) from the last raw bar (07:45 close 4400.6),
  // so the bucket close = 4400.4 + (4403.85 - 4400.6) - half-spread.
  assert.equal(last.bid.close, 4403.6, "bucket close must carry the last tick in the bucket");

  // latestCompleted must be grid-stable, not advancing with the forming tick,
  // so the scan fingerprint does not change between real 5m closes.
  const latest = await provider.latestCompleted(["M5"]);
  assert.equal(latest.M5, "2026-08-11T07:35:00.000Z");
});

test("D1 series anchored off midnight (futures session + DST + partial day) is bucketed to whole days", async () => {
  // GC=F daily bars anchor at 04:00 UTC (shifting to 05:00 across DST) with a
  // partial session bar at 14:30. Raw consecutive gaps are not multiples of
  // 86400s, which fails the worker's continuity check; bucketing to UTC
  // midnight makes every day whole-aligned and merges the partial bar.
  // All four are complete by NOW (2026-08-11T07:42): each day's bucket closes
  // 86400s after its midnight start, well before 07:42 on the 11th.
  const D1_BARS: Bar[] = [
    { time: "2026-08-07T04:00:00.000Z", o: 4400, h: 4410, l: 4390, c: 4405 },
    { time: "2026-08-08T04:00:00.000Z", o: 4405, h: 4415, l: 4395, c: 4410 },
    { time: "2026-08-09T05:00:00.000Z", o: 4410, h: 4420, l: 4400, c: 4415 }, // DST-shifted
    { time: "2026-08-09T14:30:00.000Z", o: 4415, h: 4425, l: 4405, c: 4420 }, // partial session
  ];
  const { fetchImpl } = buildFakeFetch(
    router({
      "scanner.tradingview.com": TV_PAYLOAD,
      "query1.finance.yahoo.com": yahooPayload(D1_BARS),
    }),
  );
  const provider = makeProvider(fetchImpl);
  const candles = await provider.completedCandles("D1", 400);
  assert.deepEqual(validateCandles(candles, "D1"), { ok: true });
  const times = candles.map((c) => c.time);
  assert.deepEqual(
    times,
    ["2026-08-07T00:00:00.000Z", "2026-08-08T00:00:00.000Z", "2026-08-09T00:00:00.000Z"],
    "DST + partial bars must merge into their UTC day bucket",
  );
  const last = candles[candles.length - 1];
  // Rebased onto spot (4403.85) from the last raw bar (08-09 14:30 close
  // 4420), so the merged day close = 4420 + (4403.85 - 4420) - half-spread.
  assert.ok(Math.abs(last.bid.close - 4403.8) < 1e-9, "partial-session close must win the merged day bucket");
  const latest = await provider.latestCompleted(["D1"]);
  assert.equal(latest.D1, "2026-08-09T00:00:00.000Z");
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
