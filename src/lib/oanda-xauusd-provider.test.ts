import assert from "node:assert/strict";
import test from "node:test";
import {
  createOandaPracticeXauusdProvider,
  OandaMarketDataError,
} from "./oanda-xauusd-provider.ts";
import type { TwoSidedCandle } from "./xauusd-market-data.ts";

const ACCOUNT_ID = "001-011-2345678-001";
const TOKEN = "fake-token-abc";
const NOW = () => new Date("2026-08-11T07:42:11.000Z");

const PRICE_PAYLOAD = {
  prices: [
    {
      instrument: "XAU_USD",
      time: "2026-08-11T07:42:10.000000000Z",
      tradeable: true,
      bids: [{ price: "3400.1", liquidity: 1_000_000 }],
      asks: [{ price: "3400.3", liquidity: 1_000_000 }],
    },
  ],
};

function candlePayload(complete = true) {
  return {
    complete,
    volume: complete ? 1_000 : 5,
    time: complete ? "2026-08-11T06:42:00.000000000Z" : "2026-08-11T06:43:00.000000000Z",
    bid: { o: "3400.0", h: "3400.2", l: "3399.8", c: "3400.1" },
    ask: { o: "3400.2", h: "3400.4", l: "3400.0", c: "3400.3" },
  };
}

const LATEST_PAYLOAD = {
  latestCandles: [
    {
      instrument: "XAU_USD",
      granularity: "M1",
      candles: [
        { ...candlePayload(true), time: "2026-08-11T07:41:00.000000000Z" },
        candlePayload(false),
      ],
    },
    {
      instrument: "XAU_USD",
      granularity: "H1",
      candles: [{ ...candlePayload(true), time: "2026-08-11T07:00:00.000000000Z" }],
    },
  ],
};

type CapturedRequest = { method: string; url: string; headers: Record<string, string> };

function buildFakeFetch(
  handler: (url: string) => { status: number; body: unknown },
) {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : String(input);
    requests.push({
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
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

test("adapter is GET-only, practice-host-only, and never touches order routes", async () => {
  const { requests, fetchImpl } = buildFakeFetch(
    router({
      "/pricing": PRICE_PAYLOAD,
      "/candles/latest": LATEST_PAYLOAD,
      "/instruments/XAU_USD/candles": { candles: [candlePayload(true), candlePayload(false)] },
    }),
  );
  const provider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    fetchImpl,
  );
  await provider.quote();
  await provider.latestCompleted(["M1", "H1"]);
  await provider.completedCandles("M1", 2);

  assert.equal(requests.every((r) => r.method === "GET"), true);
  assert.equal(
    requests.every((r) => r.url.startsWith("https://api-fxpractice.oanda.com/v3/accounts/")),
    true,
  );
  assert.equal(requests.some((r) => /orders|trades|positions|transactions/i.test(r.url)), false);
});

test("quote parses native bid/ask and stamps receivedAt from the injected clock", async () => {
  const { requests, fetchImpl } = buildFakeFetch(router({ "/pricing": PRICE_PAYLOAD }));
  const provider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    fetchImpl,
  );
  assert.deepEqual(await provider.quote(), {
    provider: "OANDA_V20_PRACTICE",
    instrument: "XAU_USD",
    bid: 3400.1,
    ask: 3400.3,
    providerTime: "2026-08-11T07:42:10.000000000Z",
    receivedAt: "2026-08-11T07:42:11.000Z",
    tradeable: true,
  });
  assert.equal(requests[0].headers["authorization"], `Bearer ${TOKEN}`);
  assert.equal(requests[0].headers["accept-datetime-format"], "RFC3339");
});

test("completedCandles drops the final incomplete candle instead of relabeling it", async () => {
  const { fetchImpl } = buildFakeFetch(
    router({
      "/instruments/XAU_USD/candles": {
        candles: [candlePayload(true), candlePayload(false)],
      },
    }),
  );
  const provider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    fetchImpl,
  );
  const candles = await provider.completedCandles("M1", 2);
  assert.equal(candles.length, 1);
  assert.deepEqual(candles[0], {
    instrument: "XAU_USD",
    timeframe: "M1",
    time: "2026-08-11T06:42:00.000Z",
    bid: { open: 3400.0, high: 3400.2, low: 3399.8, close: 3400.1 },
    ask: { open: 3400.2, high: 3400.4, low: 3400.0, close: 3400.3 },
    volume: 1_000,
    complete: true,
  } satisfies TwoSidedCandle);
});

test("D1 history requests use OANDA 'D' granularity", async () => {
  const { requests, fetchImpl } = buildFakeFetch(
    router({ "/instruments/XAU_USD/candles": { candles: [candlePayload(true)] } }),
  );
  const provider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    fetchImpl,
  );
  await provider.completedCandles("D1", 30);
  assert.match(requests[0].url, /granularity=D/);
  assert.match(requests[0].url, /price=BA/);
  assert.match(requests[0].url, /count=30/);
});

test("latestCompleted returns the newest complete candle per timeframe, null when absent", async () => {
  const { fetchImpl } = buildFakeFetch(router({ "/candles/latest": LATEST_PAYLOAD }));
  const provider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    fetchImpl,
  );
  assert.deepEqual(await provider.latestCompleted(["M1", "H1", "D1"]), {
    M1: "2026-08-11T07:41:00.000Z",
    H1: "2026-08-11T07:00:00.000Z",
    D1: null,
  });
});

test("empty bids or asks throw quote_unavailable", async () => {
  for (const price of [
    { ...PRICE_PAYLOAD.prices[0], bids: [] },
    { ...PRICE_PAYLOAD.prices[0], asks: [] },
  ]) {
    const { fetchImpl } = buildFakeFetch(router({ "/pricing": { prices: [price] } }));
    const provider = createOandaPracticeXauusdProvider(
      { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
      fetchImpl,
    );
    await assert.rejects(provider.quote(), (err: unknown) => {
      assert.ok(err instanceof OandaMarketDataError);
      assert.equal(err.code, "quote_unavailable");
      return true;
    });
  }
});

test("non-XAU_USD or non-tradeable price throws instrument_unavailable", async () => {
  const mismatched = { ...PRICE_PAYLOAD.prices[0], instrument: "XAU_JPY" };
  const notTradeable = { ...PRICE_PAYLOAD.prices[0], tradeable: false };
  for (const price of [mismatched, notTradeable]) {
    const { fetchImpl } = buildFakeFetch(router({ "/pricing": { prices: [price] } }));
    const provider = createOandaPracticeXauusdProvider(
      { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
      fetchImpl,
    );
    await assert.rejects(provider.quote(), (err: unknown) => {
      assert.ok(err instanceof OandaMarketDataError);
      assert.equal(err.code, "instrument_unavailable");
      return true;
    });
  }
});

test("malformed numeric quote fields throw malformed_response", async () => {
  const bad = {
    ...PRICE_PAYLOAD.prices[0],
    bids: [{ price: "not-a-number", liquidity: 1 }],
  };
  const { fetchImpl } = buildFakeFetch(router({ "/pricing": { prices: [bad] } }));
  const provider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    fetchImpl,
  );
  await assert.rejects(provider.quote(), (err: unknown) => {
    assert.ok(err instanceof OandaMarketDataError);
    assert.equal(err.code, "malformed_response");
    return true;
  });
});

test("HTTP 401 throws unauthorized", async () => {
  const { fetchImpl } = buildFakeFetch(() => ({
    status: 401,
    body: { errorMessage: "Invalid token" },
  }));
  const provider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    fetchImpl,
  );
  await assert.rejects(provider.quote(), (err: unknown) => {
    assert.ok(err instanceof OandaMarketDataError);
    assert.equal(err.code, "unauthorized");
    return true;
  });
});

test("missing credentials throw credentials_missing without calling fetch", async () => {
  const { requests, fetchImpl } = buildFakeFetch(() => ({ status: 200, body: PRICE_PAYLOAD }));
  const noToken = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: "", now: NOW },
    fetchImpl,
  );
  await assert.rejects(noToken.quote(), (err: unknown) => {
    assert.ok(err instanceof OandaMarketDataError);
    assert.equal(err.code, "credentials_missing");
    return true;
  });
  const noAccount = createOandaPracticeXauusdProvider(
    { accountId: "", token: TOKEN, now: NOW },
    fetchImpl,
  );
  await assert.rejects(noAccount.quote(), (err: unknown) => {
    assert.ok(err instanceof OandaMarketDataError);
    assert.equal(err.code, "credentials_missing");
    return true;
  });
  assert.equal(requests.length, 0);
});

test("health reports ok and maps provider failures to their codes", async () => {
  const healthy = buildFakeFetch(router({ "/pricing": PRICE_PAYLOAD }));
  const okProvider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    healthy.fetchImpl,
  );
  assert.deepEqual(await okProvider.health(), {
    ok: true,
    code: "ok",
    checkedAt: "2026-08-11T07:42:11.000Z",
  });

  const broken = buildFakeFetch(() => ({ status: 401, body: {} }));
  const brokenProvider = createOandaPracticeXauusdProvider(
    { accountId: ACCOUNT_ID, token: TOKEN, now: NOW },
    broken.fetchImpl,
  );
  assert.deepEqual(await brokenProvider.health(), {
    ok: false,
    code: "unauthorized",
    checkedAt: "2026-08-11T07:42:11.000Z",
  });
});
