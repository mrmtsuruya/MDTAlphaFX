// Read-only OANDA v20 PRACTICE adapter for canonical XAUUSD spot data.
//
// This is the ONLY data source the auto-paper worker may consume. It is
// deliberately minimal and asymmetric:
//   - host is FIXED to the practice endpoint; no configurable host exists;
//   - every request is HTTP GET;
//   - there is no order, trade, position, or transaction method anywhere;
//   - credentials are never logged, stored, or echoed back.
//
// Every failure throws a stable OandaMarketDataError code so the worker can
// record a machine-readable degraded state and fail closed.

import type {
  NativeXauusdQuote,
  PaperTimeframe,
  TwoSidedCandle,
  XauusdMarketDataProvider,
} from "./xauusd-market-data.ts";

const OANDA_PRACTICE_BASE_URL = "https://api-fxpractice.oanda.com";
const OANDA_INSTRUMENT = "XAU_USD";
const GRANULARITY = {
  M1: "M1",
  M5: "M5",
  M15: "M15",
  M30: "M30",
  H1: "H1",
  H4: "H4",
  D1: "D",
} as const;
const GRANULARITY_BY_CODE: Record<string, PaperTimeframe> = {
  M1: "M1",
  M5: "M5",
  M15: "M15",
  M30: "M30",
  H1: "H1",
  H4: "H4",
  D: "D1",
};

export type OandaMarketDataErrorCode =
  | "credentials_missing"
  | "unauthorized"
  | "instrument_unavailable"
  | "quote_unavailable"
  | "candles_unavailable"
  | "malformed_response";

export class OandaMarketDataError extends Error {
  readonly code: OandaMarketDataErrorCode;

  constructor(code: OandaMarketDataErrorCode, message: string) {
    super(message);
    this.name = "OandaMarketDataError";
    this.code = code;
  }
}

/**
 * Normalize a provider RFC3339 timestamp (which can carry 0, 3, or 9
 * fractional digits) to millisecond ISO. Mixed-precision timestamps would
 * otherwise sort inconsistently as strings, which breaks candle ordering.
 */
function normalizeTime(value: unknown): string {
  const time = Date.parse(String(value));
  if (!Number.isFinite(time)) {
    throw new OandaMarketDataError("malformed_response", `unparseable OANDA time ${value}`);
  }
  return new Date(time).toISOString();
}

function parseNumber(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new OandaMarketDataError(
      "malformed_response",
      `malformed numeric ${field}: ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function parseSide(side: unknown, label: "bid" | "ask"): {
  open: number;
  high: number;
  low: number;
  close: number;
} {
  if (typeof side !== "object" || side === null) {
    throw new OandaMarketDataError("malformed_response", `missing ${label} candle side`);
  }
  const s = side as Record<string, unknown>;
  return {
    open: parseNumber(s.o, `${label}.o`),
    high: parseNumber(s.h, `${label}.h`),
    low: parseNumber(s.l, `${label}.l`),
    close: parseNumber(s.c, `${label}.c`),
  };
}

export function createOandaPracticeXauusdProvider(
  config: { accountId: string; token: string; now?: () => Date },
  fetchImpl: typeof fetch = fetch,
): XauusdMarketDataProvider {
  const accountId = config.accountId.trim();
  const token = config.token.trim();
  const now = config.now ?? (() => new Date());

  function credentialsOrThrow(): void {
    if (!accountId || !token) {
      throw new OandaMarketDataError(
        "credentials_missing",
        "OANDA practice accountId and token are required",
      );
    }
  }

  async function request(path: string): Promise<unknown> {
    credentialsOrThrow();
    const url = `${OANDA_PRACTICE_BASE_URL}${path}`;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Accept-Datetime-Format": "RFC3339",
        "Content-Type": "application/json",
      },
    });
    if (response.status === 401) {
      throw new OandaMarketDataError("unauthorized", `OANDA rejected credentials (401) for ${path}`);
    }
    if (!response.ok) {
      throw new OandaMarketDataError(
        "malformed_response",
        `OANDA returned HTTP ${response.status} for ${path}`,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new OandaMarketDataError("malformed_response", `non-JSON response for ${path}`);
    }
    return json;
  }

  async function quote(): Promise<NativeXauusdQuote> {
    const json = await request(`/v3/accounts/${accountId}/pricing?instruments=${OANDA_INSTRUMENT}`);
    const prices = (json as { prices?: unknown })?.prices;
    if (!Array.isArray(prices) || prices.length === 0) {
      throw new OandaMarketDataError("quote_unavailable", "no OANDA price returned");
    }
    const price = prices[0] as Record<string, unknown>;
    if (price.instrument !== OANDA_INSTRUMENT) {
      throw new OandaMarketDataError(
        "instrument_unavailable",
        `expected ${OANDA_INSTRUMENT}, got ${price.instrument}`,
      );
    }
    if (price.tradeable !== true) {
      throw new OandaMarketDataError(
        "instrument_unavailable",
        `OANDA reports ${OANDA_INSTRUMENT} is not tradeable`,
      );
    }
    const bids = Array.isArray(price.bids) ? (price.bids as Record<string, unknown>[]) : [];
    const asks = Array.isArray(price.asks) ? (price.asks as Record<string, unknown>[]) : [];
    if (bids.length === 0 || asks.length === 0) {
      throw new OandaMarketDataError("quote_unavailable", "OANDA price has no bid or ask side");
    }
    return {
      provider: "OANDA_V20_PRACTICE",
      instrument: OANDA_INSTRUMENT,
      bid: parseNumber(bids[0]?.price, "bids[0].price"),
      ask: parseNumber(asks[0]?.price, "asks[0].price"),
      providerTime: String(price.time),
      receivedAt: now().toISOString(),
      tradeable: true,
    };
  }

  async function latestCompleted(
    timeframes: PaperTimeframe[],
  ): Promise<Record<PaperTimeframe, string | null>> {
    const specifications = timeframes
      .map((tf) => `${OANDA_INSTRUMENT}:${GRANULARITY[tf]}:BA`)
      .join(",");
    const json = await request(
      `/v3/accounts/${accountId}/candles/latest?candleSpecifications=${encodeURIComponent(specifications)}`,
    );
    const result = Object.fromEntries(timeframes.map((tf) => [tf, null])) as Record<
      PaperTimeframe,
      string | null
    >;
    const latestCandles = (json as { latestCandles?: unknown })?.latestCandles;
    if (!Array.isArray(latestCandles)) return result;
    for (const entry of latestCandles as Record<string, unknown>[]) {
      const tf = GRANULARITY_BY_CODE[String(entry.granularity)];
      if (!tf || !(tf in result)) continue;
      const candles = Array.isArray(entry.candles) ? (entry.candles as Record<string, unknown>[]) : [];
      const completed = candles.filter((c) => c.complete === true);
      const last = completed[completed.length - 1];
      if (last) result[tf] = normalizeTime(last.time);
    }
    return result;
  }

  async function completedCandles(
    timeframe: PaperTimeframe,
    count: number,
  ): Promise<TwoSidedCandle[]> {
    const json = await request(
      `/v3/accounts/${accountId}/instruments/${OANDA_INSTRUMENT}/candles?price=BA&granularity=${GRANULARITY[timeframe]}&count=${count}`,
    );
    const candles = (json as { candles?: unknown })?.candles;
    if (!Array.isArray(candles)) {
      throw new OandaMarketDataError("candles_unavailable", "no OANDA candles returned");
    }
    const complete = (candles as Record<string, unknown>[]).filter((c) => c.complete === true);
    if (complete.length === 0) {
      throw new OandaMarketDataError("candles_unavailable", "no completed OANDA candles returned");
    }
    return complete.map((c) => ({
      instrument: OANDA_INSTRUMENT,
      timeframe,
      time: normalizeTime(c.time),
      bid: parseSide(c.bid, "bid"),
      ask: parseSide(c.ask, "ask"),
      volume: parseNumber(c.volume, "volume"),
      complete: true as const,
    }));
  }

  async function health(): Promise<{ ok: boolean; code: string; checkedAt: string }> {
    const checkedAt = now().toISOString();
    try {
      await quote();
      return { ok: true, code: "ok", checkedAt };
    } catch (err) {
      return {
        ok: false,
        code: err instanceof OandaMarketDataError ? err.code : "malformed_response",
        checkedAt,
      };
    }
  }

  return { health, quote, latestCompleted, completedCandles };
}
