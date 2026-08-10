---
spec: twelve-data-migration
phase: research
created: 2026-08-02
---

# Research: twelve-data-migration

## Executive Summary
OANDA -> Twelve Data swap is contained to `src/lib/market-data.server.ts` plus `TWELVEDATA_API_KEY` env, symbol format `EURUSD -> EUR/USD`, and the `"OANDA"` string literal check in `signals.functions.ts`. Exact signature preservation (`fetchMarketQuotes`, `fetchMarketCandles`, `getMarketProviderStatus`, `MARKET_PAIRS`) is fully feasible. Biggest open risk: whether `/quote` and `/time_series` truly accept comma-separated multi-symbol batching on the free plan — docs are ambiguous and must be verified with a live key before committing to the polling/caching strategy, because current polling volume (12 pairs x refresh every 15s = far over 8 req/min) requires it.

## Current-State Summary

### `src/lib/market-data.server.ts` (194 lines, OANDA)
- `MARKET_PAIRS`: 12 pairs, 6-char format `EURUSD`, `GBPUSD`, ..., `XAUUSD` (const tuple, `MarketPair` type derived).
- `MarketQuote`: `{ pair, bid, ask, mid, timestamp, tradeable, source: "OANDA" }`.
- `MarketCandle`: `{ time, open, high, low, close, complete, volume }`.
- Config: `getOandaConfig()` reads `OANDA_API_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_ENVIRONMENT` (practice/live -> different base URLs).
- `getMarketProviderStatus()`: returns `{ provider: "OANDA", environment, configured, missing[] }` — used by UI (`signals.tsx`, presumably `chart.tsx`) to show config/connection banners.
- `requireOandaConfig()`: throws descriptive `Error` if token/account missing — **no silent fallback**, hard fail with actionable message naming the missing env vars.
- `toOandaInstrument("EURUSD") -> "EUR_USD"`; inverse `fromOandaInstrument`.
- `oandaRequest<T>(path)`: raw `fetch` with `Authorization: Bearer <token>` header + `Accept-Datetime-Format: RFC3339`; on non-ok response throws `Error("OANDA request failed (<status>): <detail>")` parsed from JSON `errorMessage` or raw text. Again — throws, never swallows.
- `fetchMarketQuotes(pairs: string[])`: builds comma-joined instrument list, single GET to `/v3/accounts/{id}/pricing?instruments=...`; maps OANDA `prices[]` to `MarketQuote[]`, skipping any entry whose bid/ask aren't finite numbers (silent *skip* of bad rows only, not silent failure of the whole call).
- `fetchMarketCandles(pair, granularity: "M5" | "H1", count = 60)`: single GET to `/v3/instruments/{instrument}/candles?price=M&granularity=...&count=...`; maps `candles[].mid` to `MarketCandle[]`, skipping incomplete/non-finite rows.
- Granularity values used by callers: `"M5"` for scalper mode, `"H1"` for intraday mode (see `signals.functions.ts` line 97), count 220 for signal generation, default 60.

### `src/lib/market-data.functions.ts` (TanStack server-fn wrapper, 21 lines)
- `getMarketDataStatus`: GET server fn, auth middleware, calls `getMarketProviderStatus()` directly (no HTTP call to provider — synchronous config check only).
- `getMarketQuotes`: POST server fn, validates `pairs: z.array(z.enum(MARKET_PAIRS)).min(1).max(12)`, calls `fetchMarketQuotes` and returns `{ status, quotes }`.
- No wrapper for candles at this layer — `fetchMarketCandles` is called directly from `signals.functions.ts` server-side (not exposed as its own client-callable fn). Need to check chart.tsx for how candles reach the client (likely its own server fn — see open question below, not found via grep of market-data.* imports; only signals.functions.ts imports fetchMarketCandles).

### `src/lib/signals.functions.ts` (177 lines)
- Imports `fetchMarketCandles`, `fetchMarketQuotes`, `getMarketProviderStatus`, `MARKET_PAIRS`, `MarketQuote` type from `market-data.server.ts`.
- `hasVerifiedMarketData(context)` (line 18-23): checks `context.market_data.provider === "OANDA"` literal. **Must change to match new provider tag.**
- `buildLiveSignal()` (line 25-76) stamps `news_context.market_data = { provider: quote.source, price_type, timestamp: quote.timestamp, environment: getMarketProviderStatus().environment }` on every inserted signal row. `provider` comes from `quote.source` (currently always `"OANDA"` per `MarketQuote.source` type) — so changing the `source` literal type/value on `MarketQuote` automatically flows through, AND `hasVerifiedMarketData`'s check must match whatever new literal is chosen. `environment` field also assumes OANDA's practice/live concept — Twelve Data has no such concept; decide in requirements phase whether to drop, repurpose (e.g. "free"/"paid" plan tier), or keep as fixed string.
- Line 32: `if (!quote.tradeable) throw new Error("OANDA reports this instrument as non-tradeable.")` — hardcoded "OANDA" in error message, cosmetic but should update.
- Line 103: `if (!quote) throw new Error(\`${pair}: OANDA returned no current quote.\`)` — same, cosmetic.
- Line 120: `throw new Error(warnings[0] ?? "OANDA returned no usable market data.")` — same.
- `generateSignals` calls `fetchMarketQuotes(pairs)` once for all requested pairs, then per-pair `fetchMarketCandles(pair, timeframe, 220)` — i.e. **1 quotes call + N candle calls per generation run**, where N = number of pairs (up to 12). This is the single biggest rate-limit risk generation-time call, since generation is a user/cron-triggered action, not passive polling, but still could blow the 8/min free-tier ceiling if the UI allows scanning all 12 pairs in one click (1 quote + 12 candle requests = 13 requests instantly, if Twelve Data doesn't batch time_series).
- `listSignals`: no live market-data calls, only recomputes status from stored `news_context`.
- Every error path in this file already throws with `Error(...)`, no silent fallbacks — new implementation must preserve that pattern exactly (per user constraint).

### Call sites / polling frequency (grep across src)
| File | Uses | Frequency |
|---|---|---|
| `src/lib/market-data.functions.ts` | defines `getMarketDataStatus`, `getMarketQuotes` wrapping server.ts | n/a (wrapper) |
| `src/lib/signals.functions.ts` | `fetchMarketQuotes`, `fetchMarketCandles`, `getMarketProviderStatus`, `MARKET_PAIRS` | on-demand `generateSignals` call (not polled) + status check in `listSignals`-adjacent UI |
| `src/routes/_authenticated/signals.tsx` | `getMarketQuotes` via query key `["market-quotes", TICKER_PAIRS]`, **`refetchInterval: 15_000`** (line 57); also `qc.invalidateQueries({queryKey:["market-quotes"]})` on some mutation (line 65) | every 15s while route mounted |
| `src/components/app-shell.tsx` | imports from `market-data.functions`/`market-data.server` per earlier grep, but no `setInterval`/`refetchInterval` match found directly in file — likely reuses the same `["market-quotes"]` TanStack Query key defined elsewhere and just displays it, or defines its own query without an explicit `refetchInterval` (defaults to no polling, relies on shared cache). **Needs closer read in requirements phase** to confirm ticker's actual refresh cadence — grep only found the import, not a distinct interval, so it may currently free-ride on `signals.tsx`'s 15s query since TanStack Query dedupes by key. If the ticker is mounted app-wide (in `app-shell.tsx`, likely always mounted) while `signals.tsx`'s 15s interval only fires when that route is visited, actual behavior may currently rely on OANDA's much higher rate limits and need explicit throttling for Twelve Data. |
| `src/routes/_authenticated/dashboard.tsx` | No direct market-data/quote/candle grep matches — dashboard reads `market_data_verified`/`signal.market_data_verified` from stored signals, not live provider calls. |
| `src/routes/_authenticated/chart.tsx` | No grep matches for market/candle/quote at all — surprising given the goal mentions "chart, dashboard, signals routes" polling market data. **Open question**: does chart.tsx fetch candles through a different, unfound path (e.g. dynamic import, different function name), or is "Live Chart" referenced in signals.tsx (line 178: "Entries use the same OANDA instrument feed selected in Live Chart") actually a separate/legacy feature not yet wired to `market-data.server.ts`? Needs direct read of chart.tsx in requirements/design phase. |

**Confirmed concrete polling number**: `signals.tsx` alone does 1 quotes request (batched, all pairs in single OANDA call) every 15s = 4 requests/min just from that route — already exceeds nothing by itself (OANDA batches all pairs in 1 HTTP call per `fetchMarketQuotes`), but Twelve Data may not support that same batching (see below), which would turn 1 call into up to 12 calls every 15s = 48/min, ~6x over the free-tier 8/min cap.

### UI text hardcoding "OANDA"
`src/routes/_authenticated/signals.tsx` lines ~175, 186-191: literal strings `OANDA_{env}_CONNECTED`, "Live OANDA feed needs configuration", "OANDA credentials" — cosmetic copy that should be updated for consistency but not functionally blocking.

## Twelve Data API Summary

### Auth
Two supported methods:
1. Query param: `?apikey=<key>`
2. Header (recommended): `Authorization: apikey <key>`
No account/country verification gate reported for free-tier signup (unlike OANDA) — could not fully confirm via docs fetch alone; recommend the user do a 2-minute manual signup test before committing, since this is the entire reason for migrating off OANDA.

### `/quote` — live price snapshot
- `GET https://api.twelvedata.com/quote?symbol=EUR/USD&apikey=...`
- Required: `symbol` (or figi/isin/cusip on paid add-ons — not relevant here).
- Response fields include: `symbol`, `name`, `exchange`, `currency`, `datetime`, `timestamp`, `open`, `high`, `low`, `close`, `volume`, `previous_close`, `change`, `percent_change`, `is_market_open`.
- **No explicit bid/ask** in the standard `/quote` payload (unlike OANDA's bid/ask/mid) — Twelve Data's forex quote returns close/last price, not a two-sided market. This is a **shape mismatch**: `MarketQuote.bid`/`.ask`/`.mid` need a synthetic derivation (e.g. spread estimate, or use `close` for both bid/ask/mid) — flagged as an open risk for requirements phase, especially since `signals.functions.ts` uses `quote.tradeable` and `signal.direction === "long" ? "executable_ask" : "executable_bid"` semantics that assume real bid/ask spread exists.
- Multi-symbol batching on `/quote` is **not confirmed** in docs; Twelve Data documents a separate `/advanced/batch-requests` mechanism. Needs live-key verification.
- 429 response: `{ "code": 429, "message": "Too Many Requests", "status": "error" }`.

### `/price` — simpler live price alt
Similar single-price endpoint (not deeply explored) — also ambiguous on multi-symbol comma batching per docs fetch. Alternative to `/quote` if only a mid/last price is needed and OANDA's bid/ask fields get collapsed to a single price with a synthetic spread.

### `/time_series` — candles
- `GET https://api.twelvedata.com/time_series?symbol=EUR/USD&interval=1min&outputsize=60&apikey=...`
- Required: `symbol`, `interval`.
- `interval` values: `1min, 5min, 15min, 30min, 45min, 1h, 2h, 4h, 8h, 1day, 1week, 1month`. **Shape mismatch with OANDA granularity**: current code uses `"M5" | "H1"` — Twelve Data equivalents are `"5min"` and `"1h"`. Straightforward 1:1 mapping table needed (`M5 -> 5min`, `H1 -> 1h`), no functional gap.
- `outputsize`: optional, default 30, max 5000 — matches/exceeds current `count` param usage (60 default, 220 for signal generation).
- Response: `{ meta: {...}, values: [{ datetime, open, high, low, close, volume }, ...] }`. **Order is descending (newest first) by default** — OANDA's candle order needs to be confirmed but the current code doesn't appear to reverse/sort, so this needs verification: if `signal-engine.ts` assumes oldest-first (typical for a rolling-window scan), Twelve Data's default descending order will silently break signal logic unless `order=asc` is passed or the mapper reverses the array. **Flagged as correctness risk**, not just naming.
- No `complete`/`tradeable` boolean equivalent in Twelve Data candles — OANDA's `candle.complete` flag (used to filter/tag partial candles) has no direct Twelve Data analog. Likely acceptable to set `complete: true` for all historical values except possibly the most recent one if its `datetime` is within the current interval window, but this needs an explicit decision.
- Each symbol/request costs 1 API credit; multi-symbol batching for `/time_series` also unconfirmed in docs (same caveat as `/quote`).

### Rate limits (free tier), current as of research date
- **8 requests/minute**, **800 requests/day**, max 5000 data points per request — consistent across sources (Twelve Data pricing page, third-party comparisons, GitHub issue reports of the same limit being hit in production apps). Source: [Twelve Data Pricing](https://twelvedata.com/pricing), [Twelve Data API: financial data workflows in 2026 | CodeWords](https://www.codewords.ai/blog/twelve-data-api), [Bug: Uncaught TwelveData per minute API limit · Issue #785](https://github.com/we-promise/sure/issues/785).
- No country-restriction language found for API key signup (unlike OANDA) in any source consulted — but this is exactly the class of restriction the user is trying to escape, so a **manual signup test is a hard prerequisite** before implementation, not just a research nicety.

## Symbol-Mapping Table

| App format (`MARKET_PAIRS`) | OANDA instrument | Twelve Data symbol |
|---|---|---|
| `EURUSD` | `EUR_USD` | `EUR/USD` |
| `GBPUSD` | `GBP_USD` | `GBP/USD` |
| `USDJPY` | `USD_JPY` | `USD/JPY` |
| `AUDUSD` | `AUD_USD` | `AUD/USD` |
| `USDCAD` | `USD_CAD` | `USD/CAD` |
| `NZDUSD` | `NZD_USD` | `NZD/USD` |
| `USDCHF` | `USD_CHF` | `USD/CHF` |
| `EURGBP` | `EUR_GBP` | `EUR/GBP` |
| `EURJPY` | `EUR_JPY` | `EUR/JPY` |
| `GBPJPY` | `GBP_JPY` | `GBP/JPY` |
| `AUDJPY` | `AUD_JPY` | `AUD/JPY` |
| `XAUUSD` | (OANDA gold CFD instrument, likely `XAU_USD`) | `XAU/USD` (Twelve Data supports commodities/metals — needs confirming XAU/USD is available on free tier, gold is sometimes a paid add-on) |

Mapping logic mirrors existing `toOandaInstrument`/`fromOandaInstrument`: `pair.slice(0,3) + "/" + pair.slice(3)` and its inverse (strip `/`). Same regex guard (`/^[A-Z]{6}$/`) can gate input before mapping. `XAUUSD` needs explicit verification it isn't `XAU_USD`-style-only-on-paid-tier on Twelve Data.

## Rate-Limit Strategy Recommendation

Given 8 req/min / 800 req/day free-tier ceiling and current 12-pair app:

1. **Verify comma-batching first** (blocking for design phase): test `GET /quote?symbol=EUR/USD,GBP/USD,...` and `/time_series?symbol=EUR/USD,GBP/USD,...&interval=1h` with a real free-tier key. If batching works and each symbol only costs 1 credit combined into 1 HTTP call, quotes polling stays cheap (1 call per tick regardless of pair count, same as OANDA today).
2. If batching is confirmed for `/quote` but not `/time_series` (plausible — time_series responses are heavier), then:
   - Keep quotes polling batched, but **reduce the `signals.tsx` `refetchInterval` from 15s to something rate-limit-safe** (e.g. 60s = 1 req/min if batched single-call; leaves 7 req/min headroom for on-demand candle scans).
   - For `generateSignals` (1 quotes call + up to 12 candle calls today), either serialize candle requests with backoff/queueing to stay under 8/min, or reduce default scan scope, or cache candles server-side (e.g. in-memory/Supabase table) with a TTL matching the chosen interval so repeated scans within the TTL window don't re-hit the API.
3. If neither endpoint supports batching, this becomes the dominant design constraint: 12 pairs x quotes + 12 pairs x candles per generation run is 24 requests, ~3x the per-minute budget in a single click. Would require:
   - A request queue/limiter (e.g. token bucket at 8/min) inside `market-data.server.ts`, sequencing calls with delays — changes `fetchMarketQuotes`/`fetchMarketCandles` from "fire N parallel fetches" to "drain a rate-limited queue," but can still preserve the external function signatures (internal detail).
   - Increase ticker/polling intervals substantially (60s+) and/or reduce default pair count polled by the always-mounted ticker.
   - Consider a lightweight server-side cache (per-pair, short TTL) shared between the ticker, signals list, and generation flow so simultaneous UI surfaces don't each trigger their own provider calls.
4. Either way, `getMarketProviderStatus()` should be extended (or a new function added) to also expose the current request budget/backoff state so the UI can show "rate limited, retrying in Xs" instead of a generic error — consistent with the app's existing no-silent-fallback error philosophy, but user-friendly for a known, recoverable condition (429).

This is a design-phase decision point, not fully resolvable from docs alone — **recommend a spike/test step in requirements or design phase**: sign up for a free Twelve Data key and manually curl `/quote` and `/time_series` with 2+ comma-separated symbols to observe actual behavior and credit consumption before finalizing the caching/throttling architecture.

## Feasibility Assessment

| Aspect | Assessment | Notes |
|---|---|---|
| Preserve `fetchMarketQuotes`/`fetchMarketCandles`/`getMarketProviderStatus`/`MARKET_PAIRS` signatures | High | All are internal to `market-data.server.ts`; Twelve Data can be fully wrapped behind identical signatures. `MARKET_PAIRS` values (`EURUSD` etc.) don't need to change at all — only the internal `to<Provider>Symbol` mapper changes. |
| `granularity: "M5" | "H1"` param shape | High (with mapping) | Just needs `"M5" -> "5min"`, `"H1" -> "1h"` internal lookup table; callers (`signals.functions.ts`) pass the same literals unchanged. |
| `MarketQuote.bid`/`.ask`/`.mid` fields | Medium risk | Twelve Data `/quote` has no native bid/ask; needs a synthetic spread strategy (document assumption clearly) or switch to `/price` and treat bid=ask=mid=price. Affects `buildLiveSignal`'s `executable_ask`/`executable_bid` semantics — flag for requirements. |
| `MarketQuote.source` / provider literal | High | Simple type/string change from `"OANDA"` to e.g. `"TWELVE_DATA"`; ripple only touches `hasVerifiedMarketData` string comparison and UI copy. |
| Candle order (asc/desc) | Medium risk | Must explicitly request `order=asc` or reverse array — silent correctness bug if missed, won't throw, will just produce backwards signal analysis. |
| `candle.complete` equivalent | Low-Medium | No native field; needs a reasonable synthetic rule or drop the concept (check how `signal-engine.ts` uses `complete` before deciding). |
| Rate-limit compliance at current polling cadence | Low-Medium until batching verified | Core open risk; see Rate-Limit Strategy section. Could require lowering `refetchInterval` in `signals.tsx` and/or app-wide ticker cadence in `app-shell.tsx`, plus request throttling inside `market-data.server.ts`. |
| Error-throwing / no-silent-fallback pattern | High | Twelve Data's JSON error shape (`{code, message, status}`) maps cleanly to the same `throw new Error(...)` pattern OANDA uses today; 429 handling can be a distinct, more specific error message per the strategy above. |
| Overall effort | M | Core file rewrite is small (~200 lines), most effort is in the rate-limit/caching design and verifying batching behavior + XAU/USD availability with a live key. |

## Every File That Needs to Change

1. **`src/lib/market-data.server.ts`** — full rewrite: swap OANDA config/request/mapping for Twelve Data; keep exported signatures identical (`MARKET_PAIRS`, `MarketQuote`, `MarketCandle`, `getMarketProviderStatus`, `fetchMarketQuotes`, `fetchMarketCandles`). `MarketQuote.source` literal type must change from `"OANDA"` to new provider tag. Possibly add rate-limit/backoff plumbing here.
2. **`.env`** / **`.env.example`** — remove `OANDA_ENVIRONMENT`, `OANDA_ACCOUNT_ID`, `OANDA_API_TOKEN`; add `TWELVEDATA_API_KEY`. (`.env.example` already exists as untracked new file per git status — confirm it's updated too.)
3. **`src/lib/signals.functions.ts`** — update `hasVerifiedMarketData` string check (line 22) to new provider literal; update hardcoded "OANDA" text in 3 error messages (lines 32, 103, 120); reconsider `news_context.market_data.environment` field, which assumed OANDA practice/live — decide replacement or removal in requirements phase.
4. **`src/routes/_authenticated/signals.tsx`** — update hardcoded "OANDA" UI copy (`OANDA_{env}_CONNECTED`, "Live OANDA feed needs configuration", "OANDA credentials", ~lines 175/186-191); potentially adjust `refetchInterval` (currently 15_000) per the rate-limit strategy decided in requirements/design.
5. **`src/components/app-shell.tsx`** — confirm actual ticker polling behavior (grep found import but no explicit interval in this file); adjust if it independently polls or relies on shared query cache, per rate-limit strategy.
6. **`src/routes/_authenticated/chart.tsx`** — no direct market-data usage found via grep; needs a direct read to confirm whether "Live Chart" (referenced in signals.tsx copy) is wired to this provider at all, is a separate legacy path, or is unimplemented. This is an open question, not a confirmed change, but must be resolved before requirements sign-off since the user's original ask explicitly named chart.tsx as a polling surface to check.
7. **`src/routes/_authenticated/dashboard.tsx`** — no direct provider calls found (reads only `market_data_verified` from stored signal rows); likely no change needed beyond any copy referencing OANDA, but re-check once chart.tsx question above is resolved (dashboard may embed the same ticker/chart components).
8. No changes needed to: `src/lib/signal-engine.ts` (consumes `MarketQuote`/`MarketCandle` types + `quote`/`candles` objects, provider-agnostic) or `src/lib/market-data.functions.ts` (thin wrapper, unaffected by provider swap as long as `market-data.server.ts` signatures hold) — confirms the user's core constraint is achievable.

## Open Risks / Questions for Requirements Phase

1. **Multi-symbol batching**: Does Twelve Data's free tier actually support comma-separated `symbol=A,B,C` on `/quote` and `/time_series` in one HTTP call (1 call, N credits) vs. requiring N separate HTTP calls? This is the single most consequential unknown for whether the current UI polling cadence is viable at all without redesign. **Action: manual test with a live free-tier key before design phase.**
2. **No account/country verification confirmed** for Twelve Data signup — the entire premise of this migration depends on Twelve Data not replicating OANDA's country block. Docs didn't surface any restriction, but this should be confirmed by actually completing signup, not just trusting docs silence.
3. **Bid/ask/mid derivation**: `/quote` returns a single price, not a two-sided market. Need a product decision: synthetic fixed-pip spread? Use `close` for all three fields? This affects `signal-engine.ts` consumers indirectly through `MarketQuote` shape (even though the type itself doesn't need to change, the *values* populating bid/ask matter for signal logic quality).
4. **Candle order and `complete` flag**: needs explicit `order=asc` param or array reversal; `complete` needs a synthetic rule or removal — must check how `signal-engine.ts` uses `complete` (not yet read in this pass, flagged for requirements/design).
5. **XAU/USD (gold) availability on free tier**: commodities are sometimes gated to paid plans on financial data APIs; needs live verification, otherwise `MARKET_PAIRS` may need to drop or special-case gold.
6. **`app-shell.tsx` ticker's actual polling behavior** is unconfirmed from grep alone (no `refetchInterval`/`setInterval` match despite importing market-data functions) — needs a direct read.
7. **`chart.tsx` has zero grep matches** for market-data/candle/quote despite being named as a polling surface in the task description and referenced in signals.tsx's UI copy ("same OANDA instrument feed selected in Live Chart") — needs a direct read to determine if it's in scope for this migration at all, or a separate/future feature.
8. **`news_context.market_data.environment` field** semantics (practice/live) have no Twelve Data equivalent — decide whether to drop, hardcode, or repurpose (e.g. plan tier) during requirements.
9. Rate-limit **backoff/retry UX**: should a 429 surface as a hard error (consistent with today's no-silent-fallback philosophy) or should the app queue/retry transparently? Recommend deciding this explicitly rather than defaulting, since it changes both `market-data.server.ts` internals and potentially `getMarketProviderStatus()`'s return shape.

## Sources
- https://twelvedata.com/docs (fetched sections: #quote, #price, #time-series)
- https://twelvedata.com/pricing
- https://www.codewords.ai/blog/twelve-data-api
- https://github.com/we-promise/sure/issues/785
- `C:\Users\mrmts\Downloads\LovableMDTAlphaFX\src\lib\market-data.server.ts`
- `C:\Users\mrmts\Downloads\LovableMDTAlphaFX\src\lib\market-data.functions.ts`
- `C:\Users\mrmts\Downloads\LovableMDTAlphaFX\src\lib\signals.functions.ts`
- `C:\Users\mrmts\Downloads\LovableMDTAlphaFX\src\routes\_authenticated\signals.tsx`
