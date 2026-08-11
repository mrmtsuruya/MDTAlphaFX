# XAUUSD Auto-Paper Trading Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an unattended, fail-closed XAUUSD paper-trading path that scans every enabled compatible engine, creates exactly one 0.01-lot simulated trade per eligible signal, displays PHT timestamps, and soft-archives terminal history after 30 days.

**Architecture:** Supabase Cron calls a secret-protected Edge Function once per minute. Pure TypeScript modules validate OANDA practice bid/ask data, run the existing strategy engine, and advance a B-single paper state machine; service-role RPCs make signal/trade/event writes atomic and idempotent. React routes only toggle the authenticated profile and read canonical worker state.

**Tech Stack:** TypeScript 5.8, Node test runner, React 19, TanStack Start/Query, Supabase Postgres/RLS/Edge Functions/Cron, OANDA v20 practice pricing API, Bun.

## Global Constraints

- Symbol is exactly `XAUUSD`; OANDA instrument is exactly `XAU_USD`.
- Lot size is exactly `0.01`; execution policy is exactly `b_single_v1`; instrument-spec metadata version is exactly `xauusd_0_01_lot_v1`.
- Display timezone is exactly `Asia/Manila`; visible suffix is exactly `PHT`.
- Database timestamps remain UTC `timestamptz`.
- No MT5 module, broker order SDK, order endpoint, or order-capable interface may enter the worker dependency graph.
- OANDA host is fixed to `https://api-fxpractice.oanda.com`; all requests use HTTP `GET`.
- Missing credentials, unsupported XAU instrument, stale data, missing bid/ask, mixed instruments, incomplete candles, or excessive spread fail closed with zero signals and zero fills.
- Current TradingView/Yahoo XAUUSD data stays `reference_only`; never rebase `GC=F` into canonical spot data.
- Current 36 registered engines are enabled at owner activation; explicit later disables remain authoritative.
- Existing learned multipliers never affect the canonical paper cohort. New learning remains shadow-only.
- `hit_tp2 = +2R`, `hit_tp1 = breakeven scratch = 0R`, `hit_sl = -1R`.
- Terminal canonical signals soft-archive when `created_at <= now() - interval '30 days'`; no hard delete.
- Preserve tracked user modification `.env`; never stage, rewrite, print, or commit its values.
- Update `.env.example` only. Never add secrets.
- Use Bun commands; do not run `npm install`.
- Do not rewrite Lovable-published history. No force push, reset, rebase, amend, or squash.
- No new UI-test dependency. Extract deterministic view logic into Node-tested modules; perform authenticated browser acceptance manually.
- Local machine currently lacks Docker, Supabase CLI, and Deno. Do not install them without user authority. Commit database/Edge tests, run every locally available gate, and report infrastructure-only gates as unverified until tools or linked credentials exist.
- Every task uses TDD, touches only listed files, ends green for its focused tests, and creates its own commit.

---

## File Structure

### New application files

- `src/lib/pht-time.ts` — fixed PHT formatter and UTC tooltip formatter.
- `src/lib/pht-time.test.ts` — PHT boundary tests.
- `src/lib/xauusd-market-data.ts` — pure provider contract, two-sided candle types, validation, mid-candle conversion.
- `src/lib/xauusd-market-data.test.ts` — fail-closed contract tests.
- `src/lib/oanda-xauusd-provider.ts` — injected-fetch OANDA practice quote/candle adapter; read methods only.
- `src/lib/oanda-xauusd-provider.test.ts` — parsing, host, method, and incomplete-candle tests.
- `src/lib/paper-trade-state.ts` — pure B-single state machine.
- `src/lib/paper-trade-state.test.ts` — long/short/expiry/ambiguity tests.
- `src/lib/paper-scan-orchestration.ts` — strategy selection, timeframe coverage, engine accounting, frozen-policy scan adapter.
- `src/lib/paper-scan-orchestration.test.ts` — 36-engine coverage and abstention tests.
- `src/lib/xauusd-paper-worker.ts` — dependency-injected worker cycle.
- `src/lib/xauusd-paper-worker.test.ts` — idempotency and failure-injection tests.
- `src/lib/xauusd-paper-handler.ts` — Web-standard secret/method/body HTTP boundary.
- `src/lib/xauusd-paper-handler.test.ts` — unauthorized and bounded-response tests.
- `src/lib/xauusd-paper-repository.ts` — Supabase service-role RPC adapter.
- `src/lib/xauusd-paper.functions.ts` — authenticated profile, health, history, and performance reads.
- `src/lib/xauusd-paper-view.ts` — pure database-row to UI DTO mapper.
- `src/lib/xauusd-paper-view.test.ts` — canonical/archived/PHT view mapping tests.
- `src/components/xauusd-auto-paper-panel.tsx` — profile toggle and worker-health presentation.
- `src/lib/paper-schema-contract.test.ts` — executable static assertions over forward-only migrations.

### New Supabase files

- `supabase/migrations/20260811010000_xauusd_paper_expand.sql` — enums, canonical tables, provider-health state, nullable signal provenance, read RLS.
- `supabase/migrations/20260811010100_xauusd_strategy_catalog_backfill.sql` — five missing reversal engines and all-user settings.
- `supabase/migrations/20260811010200_xauusd_paper_worker_rpcs.sql` — profile toggle, scan claim/commit/fail/transition/archive RPCs.
- `supabase/migrations/20260811020000_xauusd_canonical_rls_cutover.sql` — revoke authenticated canonical writes after UI cutover.
- `supabase/migrations/20260811030000_xauusd_paper_cron.sql` — archive schedule and explicit minute-worker scheduler function.
- `supabase/tests/database/001_xauusd_paper_schema.test.sql` — table/check/index coverage.
- `supabase/tests/database/002_xauusd_paper_rls.test.sql` — authenticated write denial.
- `supabase/tests/database/003_xauusd_paper_idempotency.test.sql` — duplicate claim/commit behavior.
- `supabase/tests/database/004_xauusd_paper_atomicity.test.sql` — transition/event transaction behavior.
- `supabase/tests/database/005_xauusd_paper_archive.test.sql` — 30-day soft archive behavior.
- `supabase/functions/xauusd-paper-worker/index.ts` — thin secret-authenticated HTTP handler.
- `supabase/functions/xauusd-paper-worker/deno.json` — Edge Function import configuration.
- `supabase/functions/.env.example` — secret names with fake values only.

### Existing files modified

- `src/lib/signal-learning.ts`, `src/lib/real-backtest.ts`, `src/lib/real-backtest.test.ts`, `src/routes/_authenticated/backtester.tsx` — correct B-single scratch accounting.
- `src/lib/signals.functions.ts` — prevent browser scoring/writes from touching canonical worker rows; retire browser generation endpoint.
- `src/integrations/supabase/types.ts` — schema/RPC type mirror.
- `src/routes/_authenticated/dashboard.tsx` — canonical recent rows with PHT.
- `src/routes/_authenticated/signals.tsx` — auto-paper control, active/archive history, no browser scoring loop.
- `src/routes/_authenticated/chart.tsx` — read-only canonical overlays, no browser paper loop.
- `src/routes/_authenticated/strategies.tsx` — PHT timestamp formatter.
- `.env.example`, `supabase/config.toml` — documented practice data and Edge settings.

---

### Task 1: Repair B-Single Accounting Before Creating New Evidence

**Files:**
- Create: `src/lib/signal-learning.test.ts`
- Modify: `src/lib/signal-learning.ts`
- Modify: `src/lib/real-backtest.ts`
- Modify: `src/lib/real-backtest.test.ts`
- Modify: `src/routes/_authenticated/backtester.tsx`

**Interfaces:**
- Consumes: existing `ResolvedSignalForLearning`, `BacktestTrade`, `SampleStats`.
- Produces: `summarizeBacktestTrades(label: string, trades: BacktestTrade[]): SampleStats`; `SampleStats.scratches: number`.

- [x] **Step 1: Write failing learning tests**

Create `src/lib/signal-learning.test.ts` with fixtures containing one `hit_tp2`, one `hit_tp1`, and one `hit_sl` for the same strategy and mode:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildLearningReport, buildSignalAutopsy } from "./signal-learning.ts";

const base = {
  pair: "XAUUSD",
  direction: "long" as const,
  mode: "intraday",
  timeframe: "H1",
  confluence: 70,
  contributing_strategies: ["ema_trend"],
  created_at: "2026-08-01T00:00:00.000Z",
};

test("B-single scratch is resolved but never counted as a win or loss", () => {
  const report = buildLearningReport([
    { ...base, id: "tp2", status: "hit_tp2" },
    { ...base, id: "be", status: "hit_tp1" },
    { ...base, id: "sl", status: "hit_sl" },
  ], Date.parse("2026-08-02T00:00:00.000Z"));
  assert.equal(report.resolved, 3);
  assert.equal(report.wins, 1);
  assert.equal(report.losses, 1);
  assert.equal(report.winRate, 33);
  assert.equal(report.totalR, 1);
});

test("B-single scratch autopsy says breakeven and 0R", () => {
  const autopsy = buildSignalAutopsy({ ...base, id: "be", status: "hit_tp1" });
  assert.equal(autopsy?.r, 0);
  assert.match(autopsy?.headline ?? "", /breakeven|scratch/i);
  assert.doesNotMatch(JSON.stringify(autopsy), /1\.25R|winner/i);
});
```

- [x] **Step 2: Write failing backtest summary test**

Export `summarizeBacktestTrades` in the test import before implementation. Add a test using three minimal `BacktestTrade` rows and assert:

```ts
assert.deepEqual(
  {
    wins: stats.wins,
    scratches: stats.scratches,
    losses: stats.losses,
    winRate: stats.winRate,
  },
  { wins: 1, scratches: 1, losses: 1, winRate: 33.3 },
);
assert.equal(stats.trades, stats.wins + stats.scratches + stats.losses + stats.open);
```

- [x] **Step 3: Run focused tests and confirm failure**

```powershell
node --test src/lib/signal-learning.test.ts src/lib/real-backtest.test.ts
```

Expected: learning assertions fail because global wins include `hit_tp1`; import fails because `summarizeBacktestTrades` is not exported.

- [x] **Step 4: Implement exact accounting**

In `buildLearningReport` use:

```ts
const wins = resolved.filter((signal) => signal.status === "hit_tp2").length;
const losses = resolved.filter((signal) => signal.status === "hit_sl").length;
```

Rewrite `hit_tp1` autopsy copy to say whole 0.01 lot exited at breakeven after TP1 and returned `0R`.

Rename/export `computeSampleStats` as `summarizeBacktestTrades`, add `scratches`, and calculate:

```ts
const resolved = trades.filter((trade) => trade.outcome !== "open");
const wins = resolved.filter((trade) => trade.outcome === "hit_tp2");
const scratches = resolved.filter((trade) => trade.outcome === "hit_tp1");
const losses = resolved.filter((trade) => trade.outcome === "hit_sl");
```

Update `backtester.tsx` sample size from `o.wins + o.losses` to `o.wins + o.scratches + o.losses`, and show `W/S/L` counts.

- [x] **Step 5: Run focused and full tests**

```powershell
node --test src/lib/signal-learning.test.ts src/lib/real-backtest.test.ts
bun run test
```

Expected: all tests pass; existing invariants include scratches.

- [x] **Step 6: Commit**

```powershell
git add -- src/lib/signal-learning.test.ts src/lib/signal-learning.ts src/lib/real-backtest.ts src/lib/real-backtest.test.ts src/routes/_authenticated/backtester.tsx
git commit -m "fix: count B-single scratches consistently"
```

---

### Task 2: Add Fixed Philippine-Time Formatting

**Files:**
- Create: `src/lib/pht-time.ts`
- Create: `src/lib/pht-time.test.ts`

**Interfaces:**
- Produces: `PHT_TIME_ZONE`, `formatPhtTimestamp(value: string | Date): string`, `utcIsoTitle(value: string | Date): string`.

- [x] **Step 1: Write failing formatter tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatPhtTimestamp, utcIsoTitle } from "./pht-time.ts";

test("formats approved PHT timestamp", () => {
  assert.equal(
    formatPhtTimestamp("2026-08-11T07:42:18.000Z"),
    "Tue, 11 Aug 2026 · 3:42:18 PM PHT",
  );
});

test("uses Manila date after UTC day boundary", () => {
  assert.equal(
    formatPhtTimestamp("2026-08-10T16:15:00.000Z"),
    "Tue, 11 Aug 2026 · 12:15:00 AM PHT",
  );
});

test("normalizes UTC tooltip and survives invalid input", () => {
  assert.equal(utcIsoTitle("2026-08-11T07:42:18Z"), "2026-08-11T07:42:18.000Z");
  assert.equal(formatPhtTimestamp("not-a-date"), "Invalid timestamp");
});
```

- [x] **Step 2: Run and confirm missing-module failure**

```powershell
node --test src/lib/pht-time.test.ts
```

- [x] **Step 3: Implement formatter using `formatToParts`**

```ts
export const PHT_TIME_ZONE = "Asia/Manila";

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PHT_TIME_ZONE,
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

function validDate(value: string | Date): Date | null {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function formatPhtTimestamp(value: string | Date): string {
  const date = validDate(value);
  if (!date) return "Invalid timestamp";
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year} · ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod} PHT`;
}

export function utcIsoTitle(value: string | Date): string {
  return validDate(value)?.toISOString() ?? "Invalid timestamp";
}
```

- [x] **Step 4: Run test and commit**

```powershell
node --test src/lib/pht-time.test.ts
git add -- src/lib/pht-time.ts src/lib/pht-time.test.ts
git commit -m "feat: add fixed PHT signal timestamps"
```

Expected: three tests pass.

---

### Task 3: Define Fail-Closed XAUUSD Market-Data Contract

**Files:**
- Create: `src/lib/xauusd-market-data.ts`
- Create: `src/lib/xauusd-market-data.test.ts`

**Interfaces:**
- Produces: `PaperTimeframe`, `NativeXauusdQuote`, `TwoSidedCandle`, `XauusdMarketDataProvider`, `validateQuote`, `validateCandles`, `validateSpreadForSignal`, `toMidCandles`, `snapshotContentHash`.

- [x] **Step 1: Write contract tests**

Build one valid quote at `2026-08-11T07:42:10Z` and 60 ascending completed bid/ask candles. Test exact rejection codes:

```ts
assert.deepEqual(validateQuote(validQuote, Date.parse("2026-08-11T07:42:18Z")), { ok: true });
assert.equal(validateQuote({ ...validQuote, providerTime: "2026-08-11T07:41:00Z" }, now).code, "stale_quote");
assert.equal(validateQuote({ ...validQuote, ask: validQuote.bid }, now).code, "crossed_quote");
assert.equal(validateQuote({ ...validQuote, instrument: "GC=F" } as never, now).code, "instrument_mismatch");
assert.equal(validateCandles([...validCandles].reverse(), "M1").code, "candles_not_ascending");
assert.equal(validateCandles([{ ...validCandles[0], complete: false } as never], "M1").code, "incomplete_candle");
assert.equal(validateSpreadForSignal(validQuote, 3400, 3399).code, "spread_too_wide");
```

Also assert `toMidCandles` averages each bid/ask OHLC field and preserves provider time/volume. Assert identical quote/candle inputs produce the same 64-character SHA-256 hex hash and changing one bid value changes the hash.

- [x] **Step 2: Run and confirm missing-module failure**

```powershell
node --test src/lib/xauusd-market-data.test.ts
```

- [x] **Step 3: Implement exact public contract**

```ts
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

export function validateQuote(quote: NativeXauusdQuote, now: number): ValidationResult;
export function validateCandles(candles: TwoSidedCandle[], timeframe: PaperTimeframe): ValidationResult;
export function validateSpreadForSignal(
  quote: NativeXauusdQuote,
  entry: number,
  stopLoss: number,
): ValidationResult;
export function toMidCandles(candles: TwoSidedCandle[]): SignalEngineCandle[];
export function snapshotContentHash(
  quote: NativeXauusdQuote,
  timeframe: PaperTimeframe,
  candles: TwoSidedCandle[],
): Promise<string>;
```

Quote maximum age is 15,000 ms. `validateSpreadForSignal` rejects non-positive stop distance and spread greater than 10% of `Math.abs(entry - stopLoss)`. `validateCandles` accepts completed ascending unique rows only and validates bid/ask OHLC invariants. `snapshotContentHash` hashes a fixed-order JSON array through `crypto.subtle.digest("SHA-256", ...)`; never hash object enumeration order.

- [x] **Step 4: Run focused tests and typecheck**

```powershell
node --test src/lib/xauusd-market-data.test.ts
bunx tsc --noEmit
```

Expected: tests and typecheck pass.

- [x] **Step 5: Commit**

```powershell
git add -- src/lib/xauusd-market-data.ts src/lib/xauusd-market-data.test.ts
git commit -m "feat: define verified XAUUSD market data contract"
```

---

### Task 4: Implement OANDA Practice Read-Only Adapter

**Files:**
- Create: `src/lib/oanda-xauusd-provider.ts`
- Create: `src/lib/oanda-xauusd-provider.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `XauusdMarketDataProvider` and market types from Task 3.
- Produces: `createOandaPracticeXauusdProvider(config, fetchImpl?)`.

- [x] **Step 1: Write fake-fetch tests before adapter**

Capture every request. Return representative OANDA pricing and `price=BA` candle payloads. Assert:

```ts
assert.equal(requests.every((request) => request.method === "GET"), true);
assert.equal(requests.every((request) => request.url.startsWith("https://api-fxpractice.oanda.com/v3/accounts/")), true);
assert.equal(requests.some((request) => /orders|trades|positions|transactions/i.test(request.url)), false);
assert.deepEqual(await provider.quote(), {
  provider: "OANDA_V20_PRACTICE",
  instrument: "XAU_USD",
  bid: 3400.1,
  ask: 3400.3,
  providerTime: "2026-08-11T07:42:10.000000000Z",
  receivedAt: "2026-08-11T07:42:11.000Z",
  tradeable: true,
});
```

Assert empty bids, empty asks, non-`XAU_USD`, non-tradeable price, malformed numeric values, HTTP 401, and missing `complete` candles throw stable `OandaMarketDataError` codes. Assert adapter drops final incomplete candle instead of relabeling it complete.

- [x] **Step 2: Run and confirm missing-module failure**

```powershell
node --test src/lib/oanda-xauusd-provider.test.ts
```

- [x] **Step 3: Implement practice-only endpoints**

```ts
const OANDA_PRACTICE_BASE_URL = "https://api-fxpractice.oanda.com";
const OANDA_INSTRUMENT = "XAU_USD";
const GRANULARITY = { M1: "M1", M5: "M5", M15: "M15", M30: "M30", H1: "H1", H4: "H4", D1: "D" } as const;

export function createOandaPracticeXauusdProvider(
  config: { accountId: string; token: string; now?: () => Date },
  fetchImpl: typeof fetch = fetch,
): XauusdMarketDataProvider;

export class OandaMarketDataError extends Error {
  constructor(
    public readonly code:
      | "credentials_missing"
      | "unauthorized"
      | "instrument_unavailable"
      | "quote_unavailable"
      | "candles_unavailable"
      | "malformed_response",
    message: string,
  );
}
```

Endpoints:

- quote: `/v3/accounts/{accountId}/pricing?instruments=XAU_USD`;
- latest closes: `/v3/accounts/{accountId}/candles/latest?candleSpecifications=XAU_USD:M1:BA,...`;
- history: `/v3/accounts/{accountId}/instruments/XAU_USD/candles?price=BA&granularity={g}&count={count}`.

Set `Authorization: Bearer <token>` and `Accept-Datetime-Format: RFC3339`. Never accept configurable host. Never create generic request accepting arbitrary paths or HTTP methods.

Official response contracts: [OANDA pricing endpoints](https://developer.oanda.com/rest-live-v20/pricing-ep/) and [bid/ask candlestick fields](https://developer.oanda.com/rest-live-v20/instrument-df/).

- [x] **Step 4: Tighten example environment copy**

Keep existing fake OANDA names. Change comments to state `practice data only`, `GET-only`, and `never commit tokens`. Add no live-host variable.

- [x] **Step 5: Run tests, typecheck, and dependency scan**

```powershell
node --test src/lib/oanda-xauusd-provider.test.ts
bunx tsc --noEmit
rg -n "orders|api-fxtrade|POST|PUT|PATCH|DELETE" src/lib/oanda-xauusd-provider.ts
```

Expected: tests/typecheck pass; `rg` returns no order endpoint, live host, or mutating HTTP method in executable code.

- [x] **Step 6: Commit**

```powershell
git add -- .env.example src/lib/oanda-xauusd-provider.ts src/lib/oanda-xauusd-provider.test.ts
git commit -m "feat: add read-only OANDA XAUUSD provider"
```

---

### Task 5: Build Deterministic 0.01-Lot Paper State Machine

**Files:**
- Create: `src/lib/paper-trade-state.ts`
- Create: `src/lib/paper-trade-state.test.ts`

**Interfaces:**
- Consumes: `NativeXauusdQuote` and `TwoSidedCandle` from Task 3.
- Produces: `PAPER_LOT_SIZE`, `PAPER_POLICY_VERSION`, `PAPER_INSTRUMENT_SPEC_VERSION`, `PaperTradeState`, `PaperTrade`, `PaperObservation`, `PaperTransition`, `advancePaperTrade`.

- [x] **Step 1: Write failing state tests**

Cover these exact cases for long and mirrored short fixtures:

1. generation quote fills long at native ask and short at native bid, storing actual executable side price;
2. later candle fills pending long only when ask range touches entry and pending short only when bid range touches entry;
3. signal expires without fill;
4. direct stop closes at `-1R`;
5. TP1 changes `open` to `tp1_protected` and does not close;
6. TP1 arming candle cannot also trigger new breakeven stop;
7. later breakeven closes at `0R`;
8. TP2 closes at `+2R`;
9. initial stop and TP touched in one candle resolves adverse with `ambiguousIntrabar=true`;
10. duplicate/older provider timestamp returns no transition and cannot increment bars twice;
11. terminal state returns no transition;
12. lot size other than `0.01` throws.

Representative assertion:

```ts
const armed = advancePaperTrade(openLong, candle({ bidHigh: 3413, bidLow: 3401 }), NOW);
assert.deepEqual(
  { to: armed?.next.state, resultR: armed?.next.resultR, event: armed?.event.type },
  { to: "tp1_protected", resultR: null, event: "tp1_protected" },
);
```

- [x] **Step 2: Run and confirm missing-module failure**

```powershell
node --test src/lib/paper-trade-state.test.ts
```

- [x] **Step 3: Implement state and transition types**

```ts
export const PAPER_LOT_SIZE = 0.01 as const;
export const PAPER_POLICY_VERSION = "b_single_v1" as const;
export const PAPER_INSTRUMENT_SPEC_VERSION = "xauusd_0_01_lot_v1" as const;

export type PaperTradeState =
  | "waiting_entry"
  | "open"
  | "tp1_protected"
  | "closed_tp2"
  | "closed_breakeven"
  | "closed_stop"
  | "expired";

export type PaperTrade = {
  id: string;
  signalId: string;
  userId: string;
  symbol: "XAUUSD";
  lotSize: 0.01;
  executionPolicyVersion: "b_single_v1";
  instrumentSpecVersion: "xauusd_0_01_lot_v1";
  direction: "long" | "short";
  timeframe: PaperTimeframe;
  state: PaperTradeState;
  stateVersion: number;
  plannedEntry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  expiresAt: string;
  entryPrice: number | null;
  entryTime: string | null;
  exitPrice: number | null;
  exitTime: string | null;
  tp1ArmedAt: string | null;
  lastObservedAt: string | null;
  resultR: number | null;
  maeR: number;
  mfeR: number;
  barsHeld: number;
  ambiguousIntrabar: boolean;
  createdAt: string;
};

export type PaperObservation =
  | { kind: "quote"; value: NativeXauusdQuote }
  | { kind: "candle"; value: TwoSidedCandle };

export type PaperTransition = {
  expectedVersion: number;
  next: PaperTrade;
  event: {
    eventKey: string;
    type: "market_observed" | "entry_filled" | "tp1_protected" | "closed_tp2" | "closed_breakeven" | "closed_stop" | "expired";
    providerTimestamp: string | null;
    evidence: Record<string, number | string | boolean | null>;
  };
};

export function advancePaperTrade(
  trade: PaperTrade,
  observation: PaperObservation | null,
  now: number,
): PaperTransition | null;
```

Use generation quote ask for long entry and quote bid for short entry. Use ask candle OHLC for later long entry, bid candle OHLC for later short entry, bid OHLC for long exit, and ask OHLC for short exit. Reject observations at or before `lastObservedAt`. Every accepted observation advances `lastObservedAt`; candles also update MAE/MFE and `barsHeld`. An observation with no state change emits idempotent key `observation:{providerTimestamp}` and event type `market_observed`. Check initial stop before targets when ordering is ambiguous. Once TP1 is armed, ignore breakeven on that same provider candle by recording `tp1ArmedAt` and requiring a later timestamp.

- [x] **Step 4: Run tests and commit**

```powershell
node --test src/lib/paper-trade-state.test.ts
bunx tsc --noEmit
git add -- src/lib/paper-trade-state.ts src/lib/paper-trade-state.test.ts
git commit -m "feat: add B-single paper trade state machine"
```

---

### Task 6: Add Forward-Only Paper Schema and Complete 36-Engine Catalog

**Files:**
- Create: `supabase/migrations/20260811010000_xauusd_paper_expand.sql`
- Create: `supabase/migrations/20260811010100_xauusd_strategy_catalog_backfill.sql`
- Create: `supabase/tests/database/001_xauusd_paper_schema.test.sql`
- Create: `src/lib/paper-schema-contract.test.ts`
- Modify: `src/integrations/supabase/types.ts`

**Interfaces:**
- Produces tables `paper_trading_profiles`, `paper_worker_health`, `scan_runs`, `market_snapshots`, `signal_market_snapshots`, `paper_trades`, `paper_trade_events`; signal provenance columns; five catalog rows.

- [x] **Step 1: Write executable static schema test first**

Read both migrations with `readFileSync(new URL(..., import.meta.url), "utf8")`. Assert exact table names, fixed checks, unique keys, `ON DELETE RESTRICT`, `archived_at`, all five missing strategy IDs, and absence of `DROP TABLE`, `DELETE FROM public.signals`, or signal-history cascade creation.

```ts
for (const table of ["paper_trading_profiles", "paper_worker_health", "scan_runs", "market_snapshots", "signal_market_snapshots", "paper_trades", "paper_trade_events"]) {
  assert.match(expandSql, new RegExp(`CREATE TABLE public\\.${table}`, "i"));
}
assert.match(expandSql, /CHECK \(symbol = 'XAUUSD'\)/i);
assert.match(expandSql, /CHECK \(lot_size = 0\.01\)/i);
assert.match(expandSql, /REFERENCES public\.paper_trades\(id\) ON DELETE RESTRICT/i);
for (const id of ["rsi_divergence", "macd_divergence", "climax_exhaustion", "stop_run_reversal", "failed_breakout"]) {
  assert.match(catalogSql, new RegExp(id));
}
```

- [x] **Step 2: Run and confirm missing-migration failure**

```powershell
node --test src/lib/paper-schema-contract.test.ts
```

- [x] **Step 3: Create expansion migration**

Create enums for scan status and paper-trade state. Add nullable canonical columns to `signals`:

```sql
scan_run_id uuid,
market_snapshot_id uuid,
engine_version text,
policy_version text,
execution_policy_version text,
scan_fingerprint text,
generated_by text NOT NULL DEFAULT 'legacy_browser',
archived_at timestamptz,
archive_reason text
```

Use these exact table contracts:

```text
paper_trading_profiles
  user_id uuid PK -> auth.users ON DELETE CASCADE
  enabled boolean NOT NULL DEFAULT false
  symbol text NOT NULL DEFAULT 'XAUUSD' CHECK symbol='XAUUSD'
  lot_size numeric(4,2) NOT NULL DEFAULT 0.01 CHECK lot_size=0.01
  timezone text NOT NULL DEFAULT 'Asia/Manila' CHECK timezone='Asia/Manila'
  strategy_scope text NOT NULL DEFAULT 'all_registered' CHECK strategy_scope='all_registered'
  activated_at timestamptz NULL, created_at timestamptz, updated_at timestamptz

paper_worker_health
  id text PK DEFAULT 'xauusd' CHECK id='xauusd'
  provider text NOT NULL, instrument text NOT NULL
  ok boolean NOT NULL, code text NOT NULL, checked_at timestamptz NOT NULL
  quote_provider_time timestamptz NULL, quote_age_ms integer NULL, spread numeric(18,6) NULL
  detail jsonb NOT NULL DEFAULT '{}'

scan_runs
  id uuid PK, user_id uuid -> auth.users ON DELETE CASCADE
  scan_fingerprint text NOT NULL UNIQUE, symbol text CHECK symbol='XAUUSD'
  timeframe text NOT NULL, candle_closed_at timestamptz NOT NULL
  scan_mode public.trader_profile NOT NULL
  engine_version text NOT NULL, policy_version text NOT NULL
  status public.paper_scan_status NOT NULL, lease_expires_at timestamptz NULL
  quality_result jsonb NOT NULL DEFAULT '{}', engine_accounting jsonb NOT NULL DEFAULT '{}'
  error_code text NULL, error_detail text NULL
  started_at timestamptz, finished_at timestamptz NULL, created_at timestamptz, updated_at timestamptz

market_snapshots
  id uuid PK, provider text CHECK provider='OANDA_V20_PRACTICE'
  instrument text CHECK instrument='XAU_USD', timeframe text NOT NULL
  candle_closed_at timestamptz NOT NULL, bid numeric(18,6), ask numeric(18,6)
  provider_time timestamptz, received_at timestamptz
  candles jsonb NOT NULL, content_hash text NOT NULL UNIQUE
  quality_result jsonb NOT NULL, created_at timestamptz

signal_market_snapshots
  signal_id uuid -> signals ON DELETE RESTRICT
  market_snapshot_id uuid -> market_snapshots ON DELETE RESTRICT
  role text CHECK role IN ('entry','mtf_direction')
  PRIMARY KEY (signal_id, market_snapshot_id, role)

paper_trades
  id uuid PK, signal_id uuid UNIQUE -> signals ON DELETE RESTRICT
  user_id uuid -> auth.users ON DELETE CASCADE
  symbol text CHECK symbol='XAUUSD', lot_size numeric(4,2) CHECK lot_size=0.01
  direction public.signal_direction, timeframe text, state public.paper_trade_state, state_version integer DEFAULT 0
  planned_entry/stop_loss/take_profit_1/take_profit_2 numeric(18,6)
  expires_at timestamptz, entry_price/exit_price numeric(18,6) NULL
  entry_time/exit_time/tp1_armed_at/last_observed_at timestamptz NULL
  result_r/mae_r/mfe_r numeric NULL, bars_held integer DEFAULT 0
  ambiguous_intrabar boolean DEFAULT false
  execution_policy_version text CHECK execution_policy_version='b_single_v1'
  instrument_spec_version text CHECK instrument_spec_version='xauusd_0_01_lot_v1'
  archived_at timestamptz NULL, created_at timestamptz, updated_at timestamptz
  directional CHECK enforces SL < entry < TP1 < TP2 for long and reverse order for short

paper_trade_events
  id uuid PK, paper_trade_id uuid -> paper_trades ON DELETE RESTRICT
  user_id uuid -> auth.users ON DELETE CASCADE
  sequence_no integer CHECK sequence_no>0, event_key text, event_type text
  provider_timestamp timestamptz NULL, worker_timestamp timestamptz NOT NULL DEFAULT now()
  before_state/after_state public.paper_trade_state NULL, evidence jsonb NOT NULL DEFAULT '{}'
```

After creating canonical tables, add foreign keys from `signals.scan_run_id` to `scan_runs.id` and `signals.market_snapshot_id` to `market_snapshots.id`, both `ON DELETE RESTRICT`. Add a conditional signal constraint requiring all provenance/version fields, `pair='XAUUSD'`, and `scan_fingerprint IS NOT NULL` whenever `generated_by='xauusd_paper_worker'`.

Create tables with constraints from design. Required unique indexes:

```sql
CREATE UNIQUE INDEX scan_runs_fingerprint_uidx ON public.scan_runs (scan_fingerprint);
CREATE UNIQUE INDEX canonical_signal_fingerprint_uidx ON public.signals (scan_fingerprint) WHERE scan_fingerprint IS NOT NULL;
CREATE UNIQUE INDEX paper_trades_signal_uidx ON public.paper_trades (signal_id);
CREATE UNIQUE INDEX paper_trade_event_sequence_uidx ON public.paper_trade_events (paper_trade_id, sequence_no);
CREATE UNIQUE INDEX paper_trade_event_key_uidx ON public.paper_trade_events (paper_trade_id, event_key);
CREATE INDEX active_signal_history_idx ON public.signals (user_id, created_at DESC) WHERE archived_at IS NULL;
```

Give authenticated users own-row `SELECT` on profile/run/trade/event tables. Give authenticated users read-only `SELECT` on the singleton `paper_worker_health` row because it contains bounded non-secret health fields. Profile mutations use a later RPC. Give no authenticated grant on `market_snapshots`. Profiles default disabled. Do not revoke existing signal writes in this migration.

- [x] **Step 4: Backfill five strategy rows**

Insert exact category/timeframe/description metadata from `IMPLEMENTED_STRATEGIES` for `rsi_divergence`, `macd_divergence`, `climax_exhaustion`, `stop_run_reversal`, and `failed_breakout`. Use `ON CONFLICT (id) DO UPDATE`. Insert enabled `strategy_settings` for every existing user only when absent.

- [x] **Step 5: Write pgTAP schema test**

`001_xauusd_paper_schema.test.sql` asserts all seven tables, fixed symbol/lot checks, unique signal/trade keys, profile default false, snapshot authenticated denial, signal/snapshot restrictive links, singleton worker-health constraint, and five catalog rows. Wrap in `BEGIN; SELECT plan(...); ... SELECT * FROM finish(); ROLLBACK;`.

- [x] **Step 6: Update generated application types mechanically**

Add Row/Insert/Update/Relationships entries for all seven new tables, new signal columns, and new enums. Do not reformat unrelated generated sections.

- [x] **Step 7: Run available tests**

```powershell
node --test src/lib/paper-schema-contract.test.ts
bunx tsc --noEmit
```

If Docker and Supabase CLI are already available, also run:

```powershell
supabase db reset --local
supabase test db
```

Current machine lacks both. VERIFIED on 2026-08-12 via a PGlite harness (WASM Postgres + pgTAP 1.3.3 loaded from its install script, with Supabase role/auth stubs): all 33 assertions in `001` pass after fixing genuine test bugs — `plan(24)` vs 33 assertions, `col_default` (does not exist; → `col_default_is`), `has_constraint` (does not exist; → EXISTS-by-conname), `has_fk`/`row_security_active`/`set_has` array form (wrong pgTAP APIs; → EXISTS-by-confrelid / relrowsecurity / SQL-string forms), and schema-qualified calls with bare string literals (`has_table('public','x')`) resolving to TEXT-preferred overloads (→ documented description forms).

- [x] **Step 8: Commit**

```powershell
git add -- supabase/migrations/20260811010000_xauusd_paper_expand.sql supabase/migrations/20260811010100_xauusd_strategy_catalog_backfill.sql supabase/tests/database/001_xauusd_paper_schema.test.sql src/lib/paper-schema-contract.test.ts src/integrations/supabase/types.ts
git commit -m "feat: add canonical XAUUSD paper schema"
```

---

### Task 7: Add Atomic Worker RPCs and Repository Adapter

**Files:**
- Create: `supabase/migrations/20260811010200_xauusd_paper_worker_rpcs.sql`
- Create: `supabase/tests/database/003_xauusd_paper_idempotency.test.sql`
- Create: `supabase/tests/database/004_xauusd_paper_atomicity.test.sql`
- Create: `src/lib/xauusd-paper-repository.ts`
- Modify: `src/lib/paper-schema-contract.test.ts`
- Modify: `src/integrations/supabase/types.ts`

**Interfaces:**
- Produces RPCs `set_xauusd_paper_enabled`, `worker_record_xauusd_health`, `worker_claim_xauusd_scan`, `worker_commit_xauusd_scan`, `worker_fail_xauusd_scan`, `worker_apply_paper_transition`, `archive_xauusd_terminal_signals`.
- Produces `PaperWorkerRepository` and `createSupabasePaperRepository(client)`.

- [x] **Step 1: Extend static tests before SQL**

Assert every RPC name exists, every worker RPC contains `SECURITY DEFINER SET search_path = public`, and SQL revokes execution from `PUBLIC`, `anon`, and `authenticated`. Assert only `set_xauusd_paper_enabled(boolean)` is granted to `authenticated`.

- [x] **Step 2: Run and confirm failure**

```powershell
node --test src/lib/paper-schema-contract.test.ts
```

- [x] **Step 3: Implement profile and claim RPCs**

`set_xauusd_paper_enabled(p_enabled boolean)` derives `auth.uid()`, upserts fixed `XAUUSD`, `0.01`, `Asia/Manila`, `all_registered`, sets `activated_at` only on false-to-true transition, and enables missing settings for all catalog strategies. Enabling requires `paper_worker_health.ok=true` with `checked_at >= now() - interval '2 minutes'`; disabling always succeeds.

`worker_record_xauusd_health(...)` upserts the singleton health row with bounded safe fields. It never stores a token, account ID, response body, or request headers.

`worker_claim_xauusd_scan(...)` inserts `scan_runs` by fingerprint with `ON CONFLICT DO NOTHING`, then returns:

```sql
RETURNS TABLE (scan_run_id uuid, claimed boolean)
```

- [x] **Step 4: Implement atomic scan commit RPC**

Use explicit typed parameters for user, scan, snapshot, signal, versions, levels, diagnostics, and expiry. Inside one function:

1. lock claimed run;
2. insert/reuse every entry/MTF snapshot by content hash;
3. insert canonical signal with `generated_by='xauusd_paper_worker'`, fingerprint, and primary entry snapshot;
4. insert `signal_market_snapshots` links for every snapshot and role;
5. insert exactly one 0.01-lot `waiting_entry` trade by unique `signal_id`;
6. insert initial event key `trade_created`;
7. mark run completed;
8. return `signal_id`, `paper_trade_id`, and `created`.

Any constraint failure rolls back every step.

- [x] **Step 5: Implement compare-and-swap transition RPC**

`worker_apply_paper_transition` locks trade, requires exact state plus state version, updates state/fill/result/metrics, increments version, and appends one event with next sequence. Duplicate `event_key` returns `applied=false`; it never appends second event.

- [x] **Step 6: Implement failure and archive RPCs**

`worker_fail_xauusd_scan` stores only enumerated safe codes and bounded diagnostics. `archive_xauusd_terminal_signals(p_now)` sets both signal/trade `archived_at` for terminal canonical trades whose signal is at least 30 days old. It returns archived count and contains no `DELETE`.

- [x] **Step 7: Write pgTAP idempotency and atomicity tests**

Test duplicate claim, duplicate commit, exactly one trade/event, stale transition version rejection, duplicate event key rejection, and transaction rollback when an invalid next state is submitted.

- [x] **Step 8: Implement repository interface**

```ts
export type PaperProfile = {
  userId: string;
  enabled: true;
  activatedAt: string;
  symbol: "XAUUSD";
  lotSize: 0.01;
};

export type ScanClaim = {
  scanFingerprint: string;
  userId: string;
  timeframe: PaperTimeframe;
  candleClosedAt: string;
  scanMode: "intraday" | "scalper";
  engineVersion: string;
  policyVersion: string;
};

export type CommitPaperSignal = {
  scanRunId: string;
  userId: string;
  scanFingerprint: string;
  snapshots: {
    quote: NativeXauusdQuote;
    timeframe: PaperTimeframe;
    candleClosedAt: string;
    candles: TwoSidedCandle[];
    contentHash: string;
    qualityResult: Record<string, unknown>;
    role: "entry" | "mtf_direction";
  }[];
  signal: {
    mode: "intraday" | "scalper";
    timeframe: PaperTimeframe;
    direction: "long" | "short";
    entry: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    atr: number;
    confluence: number;
    contributingStrategies: string[];
    rationale: string;
    diagnostics: Record<string, unknown>;
    expiresAt: string;
    engineVersion: string;
    policyVersion: string;
  };
};

export type FailScan = {
  scanRunId: string;
  code: string;
  detail: string;
  engineAccounting?: Record<string, unknown>;
};

export type PaperTransitionWrite = {
  tradeId: string;
  expectedState: PaperTradeState;
  expectedVersion: number;
  next: PaperTrade;
  event: PaperTransition["event"];
};

export interface PaperWorkerRepository {
  recordWorkerHealth(input: {
    ok: boolean;
    code: string;
    checkedAt: string;
    providerTime: string | null;
    quoteAgeMs: number | null;
    spread: number | null;
  }): Promise<void>;
  listEnabledProfiles(): Promise<PaperProfile[]>;
  listEnabledStrategyIds(userId: string): Promise<string[]>;
  claimScan(input: ScanClaim): Promise<{ scanRunId: string; claimed: boolean }>;
  commitSignal(input: CommitPaperSignal): Promise<{ signalId: string; tradeId: string; created: boolean }>;
  failScan(input: FailScan): Promise<void>;
  listLiveTrades(userId: string): Promise<PaperTrade[]>;
  applyTransition(input: PaperTransitionWrite): Promise<boolean>;
}
```

`createSupabasePaperRepository` calls RPCs only for canonical writes. It never calls `.from("signals").insert/update/delete` or `.from("paper_trades").insert/update/delete` directly.

- [x] **Step 9: Update generated RPC types and run gates**

```powershell
node --test src/lib/paper-schema-contract.test.ts
bunx tsc --noEmit
```

Run pgTAP only when local Supabase exists; otherwise retain infrastructure-blocked status. VERIFIED on 2026-08-12 via the PGlite harness: `003` (7/7) and `004` (10/10, after fixing plan(7)→plan(10)) pass, which surfaced and fixed three real worker-RPC bugs in `20260811010200`: (1) `(p_signal->>'contributing_strategies')::text[]` is not valid Postgres array-literal syntax and crashed every commit with strategies → `ARRAY(SELECT jsonb_array_elements_text(...))`; (2) duplicate `worker_claim_xauusd_scan` returned `claimed=true` so concurrent workers would double-own a scan → INSERT…RETURNING CTE where claimed means "this call inserted"; (3) `WHERE signal_id = …` collided with the function's `RETURNS TABLE (signal_id …)` OUT parameter (PL/pgSQL variable_conflict=error) → table alias.

- [x] **Step 10: Commit**

```powershell
git add -- supabase/migrations/20260811010200_xauusd_paper_worker_rpcs.sql supabase/tests/database/003_xauusd_paper_idempotency.test.sql supabase/tests/database/004_xauusd_paper_atomicity.test.sql src/lib/xauusd-paper-repository.ts src/lib/paper-schema-contract.test.ts src/integrations/supabase/types.ts
git commit -m "feat: add atomic paper worker RPCs"
```

---

### Task 8: Scan All Strategies and Run Unattended Worker Cycle

**Files:**
- Create: `src/lib/paper-scan-orchestration.ts`
- Create: `src/lib/paper-scan-orchestration.test.ts`
- Create: `src/lib/xauusd-paper-worker.ts`
- Create: `src/lib/xauusd-paper-worker.test.ts`
- Create: `src/lib/xauusd-paper-handler.ts`
- Create: `src/lib/xauusd-paper-handler.test.ts`
- Create: `supabase/functions/xauusd-paper-worker/index.ts`
- Create: `supabase/functions/xauusd-paper-worker/deno.json`
- Create: `supabase/functions/.env.example`
- Modify: `supabase/config.toml`

**Interfaces:**
- Consumes: Tasks 3–5 market provider/state machine; Task 7 repository; existing `scanCandlesForSignal`, `computeStrategyWeights`, `ALL_ENGINE_STRATEGY_IDS`, `computeMtfAgreement`.
- Produces: `resolveEnabledPaperStrategies`, `scanCompletedTimeframes`, `runXauusdPaperCycle`, `createWorkerHandler`.

- [x] **Step 1: Write strategy-accounting tests**

Assert catalog parity and explicit accounting:

```ts
assert.equal(ALL_ENGINE_STRATEGY_IDS.length, 36);
assert.deepEqual(resolveEnabledPaperStrategies(allCatalogRows, allEnabledRows), ALL_ENGINE_STRATEGY_IDS);
assert.equal(resolveEnabledPaperStrategies(allCatalogRows, [{ strategyId: "ema_trend", enabled: false }]).includes("ema_trend"), false);
assert.deepEqual(
  [...accounting.evaluated, ...accounting.abstained, ...accounting.incompatible, ...accounting.excluded, ...accounting.failed.map((item) => item.strategyId)].sort(),
  [...ALL_ENGINE_STRATEGY_IDS].sort(),
);
```

Test each newly completed timeframe once, explicit macro-dependent failure labels when macro context is unavailable, and no existing learned multiplier input.

- [x] **Step 2: Write worker failure/idempotency tests**

Use in-memory provider/repository fakes. Assert:

- disabled profile performs zero provider calls;
- stale quote calls `failScan` and creates zero signals;
- same candle invoked twice claims once;
- two eligible timeframes create two independent signals/trades;
- spread over 10% stop distance fails candidate eligibility;
- provider exception records degraded run and continues next scheduled cycle;
- live trades advance through state machine with compare-and-swap writes;
- no dependency exposes an order method.

Write handler tests proving missing/wrong secret returns 401, GET returns 405, non-empty input returns 400, valid secret plus `{}` returns 200 with bounded counters, and thrown worker error returns a generic 503 without stack/token leakage.

- [x] **Step 3: Run and confirm missing-module failures**

```powershell
node --test src/lib/paper-scan-orchestration.test.ts src/lib/xauusd-paper-worker.test.ts src/lib/xauusd-paper-handler.test.ts
```

- [x] **Step 4: Implement orchestration boundary**

`resolveEnabledPaperStrategies` first compares sorted database catalog IDs with `ALL_ENGINE_STRATEGY_IDS`; any missing/unknown ID throws `strategy_catalog_drift` and prevents canonical signals. With a matching catalog, return registry order filtered only by explicit `enabled=false` settings. Activation creates missing settings as enabled, so silence never means disabled.

```ts
export type StrategyAccounting = {
  evaluated: string[];
  abstained: string[];
  incompatible: string[];
  excluded: string[];
  failed: { strategyId: string; code: string }[];
};

export type PaperSignalCandidate = {
  mode: "intraday" | "scalper";
  timeframe: PaperTimeframe;
  candleClosedAt: string;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  atr: number;
  confluence: number;
  contributingStrategies: string[];
  rationale: string;
  expiresAt: string;
  engineVersion: string;
  policyVersion: string;
  accounting: StrategyAccounting;
  mtf: MtfAgreement | null;
  snapshotRoles: { timeframe: PaperTimeframe; role: "entry" | "mtf_direction" }[];
};

export async function scanCompletedTimeframes(input: {
  quote: NativeXauusdQuote;
  candlesByTimeframe: Partial<Record<PaperTimeframe, TwoSidedCandle[]>>;
  newlyCompleted: PaperTimeframe[];
  enabledStrategyIds: string[];
  engineVersion: string;
  policyVersion: string;
}): Promise<PaperSignalCandidate[]>;
```

For each timeframe, derive mid candles, compute walk-forward weights, call `scanCandlesForSignal`, derive abstentions from active IDs minus vote IDs, and store full diagnostics. Map `M1/M5/M15/M30` to `scalper`; map `H1/H4/D1` to `intraday`. Preserve validity minutes exactly as `M1=10`, `M5=15`, `M15=30`, `M30=60`, `H1=90`, `H4=240`, `D1=1440`. Never multiply by existing `computeStrategyLearning` output. Until a canonical macro provider is separately approved, compatible `news_reactive` and `ai_confluence` evaluations are recorded under `failed` with code `macro_context_unavailable` and are removed from the engine call; incompatible timeframes remain `incompatible`. No signal may cite a failed engine. Use current MTF plan when direction candles are present; confirmed opposing tide rejects candidate with named reason. Return every eligible timeframe candidate; do not collapse them to one winner.

- [x] **Step 5: Implement worker cycle**

```ts
export async function runXauusdPaperCycle(deps: {
  now: () => Date;
  provider: XauusdMarketDataProvider;
  repository: PaperWorkerRepository;
  engineVersion: string;
  policyVersion: string;
}): Promise<{ profiles: number; scans: number; signals: number; transitions: number; failures: number }>;
```

Run provider health and call `recordWorkerHealth` before loading profiles, so initial activation has a recent health row even while every profile is disabled. Discover enabled profiles internally. Fetch one quote and latest completed map. Claim per-user/timeframe/candle/version fingerprint before full candle fetch. Validate provider data and commit every eligible candidate atomically as `waiting_entry`. Then group live trades by timeframe, fetch up to 500 completed two-sided candles, filter strictly after `lastObservedAt ?? createdAt`, add current quote as the newest observation, sort by provider timestamp with candles before quote on an exact tie, and apply oldest-first. Newly committed trades therefore fill from generation quote ask/bid without an assumed mid price; existing trades replay every completed candle before current quote. If provider history cannot bridge saved timestamp, record `trade_observation_gap` and leave trade unchanged rather than skipping unseen prices. Catch per-scan failures, store safe codes, and continue other profiles/timeframes. Top-level credential/provider failure records degraded health and returns without fabricating work.

- [x] **Step 6: Implement secret-protected thin Edge handler**

Implement `createWorkerHandler({ expectedSecret, runCycle })` in `src/lib/xauusd-paper-handler.ts`. Compare `x-worker-secret` with Web Crypto digest, accept `POST` only, accept empty JSON object only, and return bounded JSON counters. Request cannot supply user ID, symbol, lot, strategy IDs, or provider URL.

Edge `index.ts` only reads `XAUUSD_WORKER_CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OANDA_ACCOUNT_ID`, and `OANDA_API_TOKEN`, constructs provider/repository/cycle, and passes request to tested handler.

Configure:

```toml
[functions.xauusd-paper-worker]
verify_jwt = false
```

`supabase/functions/.env.example` contains fake names only.

- [x] **Step 7: Add dependency-boundary assertion**

In `xauusd-paper-worker.test.ts`, read worker, repository, provider, and Edge handler source. Parse import lines and assert none contains `mt5`, `order`, `broker`, `trade-client`, or `local-cli`. Assert OANDA adapter request methods remain GET-only.

- [x] **Step 8: Run available gates**

```powershell
node --test src/lib/paper-scan-orchestration.test.ts src/lib/xauusd-paper-worker.test.ts src/lib/xauusd-paper-handler.test.ts
bunx tsc --noEmit
bun run test
```

If Deno already exists, also run `deno check supabase/functions/xauusd-paper-worker/index.ts`; otherwise record Edge-runtime check as infrastructure-blocked.

- [x] **Step 9: Commit**

```powershell
git add -- src/lib/paper-scan-orchestration.ts src/lib/paper-scan-orchestration.test.ts src/lib/xauusd-paper-worker.ts src/lib/xauusd-paper-worker.test.ts src/lib/xauusd-paper-handler.ts src/lib/xauusd-paper-handler.test.ts supabase/functions/xauusd-paper-worker/index.ts supabase/functions/xauusd-paper-worker/deno.json supabase/functions/.env.example supabase/config.toml
git commit -m "feat: add unattended XAUUSD paper worker"
```

---

### Task 9: Add Authenticated Read/Profile APIs and Canonical View Model

**Files:**
- Create: `src/lib/xauusd-paper.functions.ts`
- Create: `src/lib/xauusd-paper-view.ts`
- Create: `src/lib/xauusd-paper-view.test.ts`
- Modify: `src/lib/signals.functions.ts`

**Interfaces:**
- Produces: `getXauusdPaperProfile`, `setXauusdPaperEnabled`, `getXauusdPaperHealth`, `listXauusdPaperSignals`, `getXauusdPaperPerformance`, `getXauusdShadowLearning`, `PaperSignalListItem`, `PaperShadowLearningReport`.

- [x] **Step 1: Write view-model tests**

Fixture one active and one archived canonical row joined to `paper_trades`. Assert mapper returns full PHT timestamp, UTC title, `PAPER ONLY`, `0.01`, B-single status copy, provider/freshness fields, and no broker/order fields. Assert archived filter is server input rather than client filtering a capped active list. Add canonical learning fixtures proving archived terminal rows remain included, legacy rows and mismatched policy versions are excluded, breakeven is a scratch, and returned candidates carry `applied: false`.

- [x] **Step 2: Run and confirm missing-module failure**

```powershell
node --test src/lib/xauusd-paper-view.test.ts
```

- [x] **Step 3: Implement pure mapper**

```ts
export type PaperSignalListItem = {
  id: string;
  pair: "XAUUSD";
  direction: "long" | "short";
  mode: "intraday" | "scalper";
  timeframe: PaperTimeframe;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  confluence: number;
  contributingStrategies: string[];
  lotSize: 0.01;
  paperOnly: true;
  paperLabel: "PAPER ONLY · 0.01 LOT · NO BROKER CONNECTION";
  timestampPht: string;
  timestampUtc: string;
  archived: boolean;
  trade: {
    state: PaperTradeState;
    entryPrice: number | null;
    exitPrice: number | null;
    resultR: number | null;
  };
  provider: { name: "OANDA_V20_PRACTICE"; instrument: "XAU_USD"; providerTime: string };
  engine: { version: string; policyVersion: string; accounting: StrategyAccounting };
};

export type PaperShadowLearningReport = {
  executionPolicyVersion: "b_single_v1";
  applied: false;
  sampleSize: number;
  candidates: {
    strategyId: string;
    mode: "intraday" | "scalper";
    resolved: number;
    wins: number;
    scratches: number;
    losses: number;
    totalR: number;
    candidateMultiplier: number;
    verdict: "boost" | "cool" | "hold" | "insufficient";
  }[];
};
```

Map decimal strings with finite-number guards. Invalid canonical rows throw safe mapping error; never show them as valid.

- [x] **Step 4: Implement authenticated server functions**

Use `requireSupabaseAuth` for every function.

- `getXauusdPaperProfile`: own profile or disabled fixed default.
- `setXauusdPaperEnabled`: call authenticated RPC with only `{ p_enabled: boolean }`.
- `getXauusdPaperHealth`: read profile, singleton `paper_worker_health`, plus latest five own `scan_runs`; never call provider.
- `listXauusdPaperSignals`: validate `{ archived: boolean }`, filter `generated_by='xauusd_paper_worker'`, use `.is("archived_at", null)` or `.not("archived_at", "is", null)`, order newest-first, limit 200, select paper-trade relation.
- `getXauusdPaperPerformance`: aggregate canonical terminal paper rows; scratches are resolved denominator but neither wins nor losses.
- `getXauusdShadowLearning`: query active and archived canonical terminal rows with `execution_policy_version='b_single_v1'`, derive per-strategy candidate multipliers through existing deterministic learning math, return `applied:false`, and never write `strategy_settings` or scan weights.

When schema is missing (`42P01` or `PGRST205`), return `migration_required` health and disabled profile instead of crashing authenticated UI.

- [x] **Step 5: Isolate legacy endpoints**

At start of `generateSignals`, throw `Browser signal generation retired; enable XAUUSD Auto-Paper.` before provider work. In `scoreSignalPerformance`, `getLearningReport`, calibration, and other legacy queries, exclude `generated_by='xauusd_paper_worker'`. Canonical rows can only be resolved by worker RPC path.

- [ ] **Step 6: Run tests/typecheck and commit**

```powershell
node --test src/lib/xauusd-paper-view.test.ts
bun run test
bunx tsc --noEmit
git add -- src/lib/xauusd-paper.functions.ts src/lib/xauusd-paper-view.ts src/lib/xauusd-paper-view.test.ts src/lib/signals.functions.ts
git commit -m "feat: expose canonical paper trading APIs"
```

---

### Task 10: Convert Dashboard, Signals, Chart, and Strategy Views to Canonical Paper Data

**Files:**
- Create: `src/components/xauusd-auto-paper-panel.tsx`
- Modify: `src/routes/_authenticated/dashboard.tsx`
- Modify: `src/routes/_authenticated/signals.tsx`
- Modify: `src/routes/_authenticated/chart.tsx`
- Modify: `src/routes/_authenticated/strategies.tsx`

**Interfaces:**
- Consumes: Task 9 server functions/DTOs; Task 2 PHT formatter.
- Produces: read-only canonical paper UI, active/archive filter, profile toggle, worker health.

- [x] **Step 1: Build focused auto-paper panel**

Panel props contain profile, health, mutation state, and `onEnabledChange`. Render exact persistent copy:

```text
PAPER ONLY · 0.01 LOT · NO BROKER CONNECTION
```

Show `Asia/Manila (PHT)`, provider/instrument, last attempt, last success, quote age, spread, and degradation code. Disable toggle for `migration_required`, missing OANDA credentials, unsupported instrument, or failed live health. Use accessible switch label `Enable unattended XAUUSD paper trading`.

- [x] **Step 2: Replace Dashboard browser generation**

Remove `generateSignals` import/mutation and `SCAN_INTRADAY`/`SCAN_SCALPER` buttons. Query `listXauusdPaperSignals({ archived: false })`, render latest eight, and extend row layout with full `timestampPht`, title=`timestampUtc`, paper state, and 0.01 lot. Empty copy says auto-paper is disabled/degraded instead of instructing browser scan.

- [x] **Step 3: Replace Signal Center polling/writes**

Remove `generateSignals`, `invalidateSignal`, and canonical `scoreSignalPerformance` polling. Add queries:

```ts
["xauusd-paper-profile"]
["xauusd-paper-health"] // 5-second stored-health poll
["xauusd-paper-signals", archived]
["xauusd-paper-performance"]
["xauusd-shadow-learning"]
```

Add Active/Archive filter backed by server query. Inspector shows fill, TP1 protection, exit, R result, engine accounting, provider timestamp, and paper-only label. Learning panel reads canonical candidate report and displays `SHADOW ONLY · NOT APPLIED`. No invalidate/delete button appears for canonical rows. (DTO extended with `entryTime`/`tp1ArmedAt`/`exitTime` so the inspector's fill/protection/exit rows have real timestamps.)

- [x] **Step 4: Make Chart history/overlay read-only**

Remove `scoreSignalPerformance` query and browser-driven paper-loop comments. Query active canonical XAUUSD rows, filter selected timeframe/pair, and feed newest selected canonical signal into existing overlay props. Render full PHT timestamp plus optional relative age. Manual `PairScanner` controls become disabled research notice linking to Auto-Paper; they cannot call `generateSignals`.

- [x] **Step 5: Normalize strategy timestamps**

Replace `new Date(signal.created_at).toLocaleString()` with `formatPhtTimestamp` and UTC tooltip.

- [x] **Step 6: Format and run compile gates**

```powershell
bunx prettier --write src/components/xauusd-auto-paper-panel.tsx src/routes/_authenticated/dashboard.tsx src/routes/_authenticated/signals.tsx src/routes/_authenticated/chart.tsx src/routes/_authenticated/strategies.tsx
bunx eslint src/components/xauusd-auto-paper-panel.tsx src/routes/_authenticated/dashboard.tsx src/routes/_authenticated/signals.tsx src/routes/_authenticated/chart.tsx src/routes/_authenticated/strategies.tsx
bunx tsc --noEmit
bun run build
```

Expected: touched files lint clean, typecheck/build pass. Existing unrelated lint debt remains untouched. (0 eslint errors, 2 pre-existing effect-dependency warnings in chart.tsx; 349 tests pass; build succeeds.)

- [x] **Step 7: Authenticated browser acceptance**

Verified live at `http://127.0.0.1:5173` (the plan's 5176 was stale):

1. Dashboard and Signal Center render with the auto-paper panel showing `WORKER_STANDBY` (no worker has reported health yet) rather than crashing.
2. Every visible signal timestamp ends `PHT` and includes weekday/date/time (DTO + strategy detail tooltips expose `UTC` ISO).
3. Active/Archive selection performs separate server queries.
4. Chart contains no browser scoring request — SIGNAL/ANALYSIS panels are read-only with the `SCANS_RETIRED` notice.
5. Paper-only/no-broker copy remains visible on panel, rows, and research card.
6. Toggle stays blocked (disabled switch) until schema/provider health succeeds.

- [x] **Step 8: Commit**

```powershell
git add -- src/components/xauusd-auto-paper-panel.tsx src/routes/_authenticated/dashboard.tsx src/routes/_authenticated/signals.tsx src/routes/_authenticated/chart.tsx src/routes/_authenticated/strategies.tsx
git commit -m "feat: show unattended XAUUSD paper trading UI"
```

---

### Task 11: Apply Canonical RLS Cutover, Archive Schedule, and Deployment Gates

**Files:**
- Create: `supabase/migrations/20260811020000_xauusd_canonical_rls_cutover.sql`
- Create: `supabase/migrations/20260811030000_xauusd_paper_cron.sql`
- Create: `supabase/tests/database/002_xauusd_paper_rls.test.sql`
- Create: `supabase/tests/database/005_xauusd_paper_archive.test.sql`
- Modify: `src/lib/paper-schema-contract.test.ts`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: deployed worker/UI/RPCs.
- Produces: authenticated canonical read-only policy; archive job; explicit worker-schedule configuration function.

- [ ] **Step 1: Extend static security tests first**

Assert cutover SQL revokes authenticated `INSERT`, `UPDATE`, and `DELETE` on `signals`; revokes authenticated `INSERT` on `signal_events`; grants own-row SELECT only for canonical tables; contains no hard delete. Assert cron names/schedules exactly:

```text
xauusd-paper-minute   * * * * *
xauusd-paper-archive  5 16 * * *
```

- [ ] **Step 2: Run and confirm failure**

```powershell
node --test src/lib/paper-schema-contract.test.ts
```

- [ ] **Step 3: Implement forward-only RLS cutover**

Drop existing `own signals` and `own signal events` `FOR ALL` policies. Revoke authenticated canonical writes. Create own-row SELECT policies. Profile mutation remains RPC-only. Service role retains required table/RPC access. Do not change legacy rows or delete events.

- [ ] **Step 4: Implement scheduler SQL safely**

Enable `pg_cron`, `pg_net`, and Vault-supported secret lookup. Schedule archive directly at `5 16 * * *` to call `archive_xauusd_terminal_signals(now())`.

Create service-only `configure_xauusd_paper_minute_job()` that refuses to schedule unless Vault contains `project_url`, `publishable_key`, and `xauusd_worker_cron_secret`. POST body is `{}` and headers include `apikey`, `Content-Type`, and `x-worker-secret`. Migration must not auto-enable any profile.

Official scheduling pattern: [Supabase scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions).

- [ ] **Step 5: Write pgTAP RLS/archive tests**

RLS test impersonates authenticated owner and another user, proving own SELECT succeeds while all canonical writes fail. Archive test inserts canonical terminal rows at 29 days and 31 days, calls RPC with fixed `p_now`, proves only 31-day row gains `archived_at`, and proves both event ledgers remain unchanged.

- [ ] **Step 6: Update handoff with exact activation state**

Document commits, local gates, unavailable infrastructure gates, required Vault/Edge secret names, and exact activation commands. State `not live` unless migration, function deployment, cron configuration, provider health, and owner profile enablement have all succeeded.

- [ ] **Step 7: Run complete local gates**

```powershell
bun run test
bunx tsc --noEmit
bun run build
bunx eslint src/lib/pht-time.ts src/lib/xauusd-market-data.ts src/lib/oanda-xauusd-provider.ts src/lib/paper-trade-state.ts src/lib/paper-scan-orchestration.ts src/lib/xauusd-paper-worker.ts src/lib/xauusd-paper-handler.ts src/lib/xauusd-paper-repository.ts src/lib/xauusd-paper.functions.ts src/lib/xauusd-paper-view.ts src/components/xauusd-auto-paper-panel.tsx
git diff --check
```

Expected: tests/typecheck/build/focused lint/diff checks pass. Run full `bun run lint` and record only pre-existing unrelated failures; fix every new failure.

- [x] **Step 8: Run deployment preflight without mutating remote state**

```powershell
Get-Command supabase -ErrorAction SilentlyContinue
Get-Command docker -ErrorAction SilentlyContinue
Get-Command deno -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object { $_.Name -in @('SUPABASE_ACCESS_TOKEN','OANDA_ACCOUNT_ID','OANDA_API_TOKEN') } | Select-Object -ExpandProperty Name
```

Never print values. VERIFIED on 2026-08-12: `supabase`, `docker`, `deno` all missing; `SUPABASE_ACCESS_TOKEN`, `OANDA_ACCOUNT_ID`, `OANDA_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` all unset. REST probes (publishable key, `?select=id&limit=1`) show the live project `mggqzhcacqthwoygmrhg` returns `PGRST205` for `scan_runs`, `paper_trading_profiles`, and `paper_worker_health` — the Task 6/7 paper schema is NOT applied there. The committed `config.toml` project id `lcyxfrprcpyarhagkryz` is unreachable (curl `000`) while the working `.env` points at `mggqzhcacqthwoygmrhg` — resolve this mismatch before any link/deploy. No remote migration/function/secret writes performed.

- [ ] **Step 9: When authorized tools/credentials already exist, deploy in safe order**

```powershell
supabase link --project-ref lcyxfrprcpyarhagkryz
supabase migration list
supabase db push --dry-run
supabase db push
supabase functions deploy xauusd-paper-worker
supabase secrets set --env-file "$env:TEMP\xauusd-paper-secrets.env"
```

Operator-provided `$env:TEMP\xauusd-paper-secrets.env` contains `OANDA_ACCOUNT_ID`, `OANDA_API_TOKEN`, and `XAUUSD_WORKER_CRON_SECRET`. It stays outside the repository. Store `project_url`, `publishable_key`, and the same worker secret in Vault, call `configure_xauusd_paper_minute_job()`, run provider health, then enable owner profile through authenticated UI. Never print or commit the secret file.

- [ ] **Step 10: Prove browser independence after activation**

Record current latest scan in PHT, close dashboard tab, wait for newly completed M1 candle, reopen, and verify newer `scan_runs` row exists. If eligible engine signal exists, verify one signal/one 0.01 trade; otherwise verify explicit evaluated/abstained accounting and no fabricated trade.

- [ ] **Step 11: Commit**

```powershell
git add -- supabase/migrations/20260811020000_xauusd_canonical_rls_cutover.sql supabase/migrations/20260811030000_xauusd_paper_cron.sql supabase/tests/database/002_xauusd_paper_rls.test.sql supabase/tests/database/005_xauusd_paper_archive.test.sql src/lib/paper-schema-contract.test.ts HANDOFF.md
git commit -m "feat: secure and schedule XAUUSD paper trading"
```

---

## Final Review Gates

Before declaring complete:

1. Inspect `git status --short`; only user's original `.env` modification may remain.
2. Compare every approved design acceptance criterion to Tasks 1–11.
3. Independently review TypeScript, React, database security, silent failures, and zero-order dependency boundary.
4. Re-run tests, typecheck, production build, focused lint, `git diff --check`, and authenticated browser acceptance.
5. Distinguish code-complete from deployed/activated. Missing Supabase/OANDA authority is deployment blocker, not permission to weaken validation or use mixed reference feed.
