# XAUUSD Auto-Paper Trading Core

**Date:** 2026-08-11  
**Status:** Approved design  
**Display timezone:** `Asia/Manila` (PHT, UTC+08:00)

## 1. Goal

Build a trustworthy, unattended, paper-only XAUUSD vertical slice. Every newly generated eligible XAUUSD signal opens exactly one simulated 0.01-lot trade. Scanning continues when every browser is closed. No component in this slice can submit a broker or MT5 order.

The slice must also show complete PHT timestamps on recent and generated signals, then soft-archive terminal signals after 30 days without destroying their outcomes or audit events.

## 2. Scope

### Included

- XAUUSD only.
- Fixed 0.01 lot using the existing B-single policy.
- Server-side scans every minute during provider-reported market availability.
- Every registered and user-enabled strategy is considered on every compatible newly completed timeframe candle. The current runtime contains 36 strategy IDs.
- Strict market-data validation and fail-closed behavior.
- Idempotent signal generation and paper-trade creation.
- Side-aware simulated fills and an append-only event ledger.
- Complete PHT timestamps in Recent Signals and generated-signal views.
- Automatic soft archive after 30 days.
- Shadow learning candidates based only on canonical paper outcomes.
- Authenticated, tenant-isolated read access to signals and paper trades.

### Excluded

- Real-money orders, MT5 order submission, broker credentials, or an execution adapter.
- Symbols other than XAUUSD.
- Automatic promotion of learned weights into production scanning.
- Historical signal backfill.
- Permanent deletion of signals or events.
- A claim that all 36 strategy implementations are canonically correct. They remain research engines until separately validated.
- Broad microservice extraction.

## 3. Current-State Constraints

The current application generates and scores signals from authenticated browser activity. Closing the page stops that orchestration. Standard Signal Center scans use H1 or M5; only the sweep path covers all timeframes supported by enabled engines.

Current XAUUSD data is not eligible for the new worker. Quotes are labelled OANDA spot through a TradingView scanner, while candles are Yahoo `GC=F` COMEX futures shifted onto the current spot level. Quote timestamps are server receipt times, missing sides can collapse to `close`, and the adapter hardcodes `tradeable: true`. The new worker must never silently accept this mixture or fallback.

Existing signal rows are user-mutable under RLS and existing learning includes historical rows produced under older execution semantics. Neither source may drive the new canonical paper ledger.

## 4. Chosen Architecture

Supabase Cron invokes a secured Supabase Edge Function every minute through `pg_net`. Project URL and service credential are read from Supabase Vault. Browser routes only read worker results and change the authenticated user's paper-profile enablement; they do not scan, fill, resolve, or archive canonical trades.

```text
Supabase Cron, once per minute
  -> secured XAUUSD worker
      -> acquire idempotency lease
      -> load enabled paper profiles
      -> discover newly completed timeframe candles
      -> fetch one native XAUUSD spot quote plus required timeframe snapshots
      -> validate quote and candle provenance/quality
      -> run every enabled compatible strategy
      -> publish immutable eligible signal
      -> create one 0.01-lot paper trade
      -> advance existing paper trades
      -> append state-transition events
      -> record run health and release lease

Daily retention job
  -> expire any impossible stale pending state
  -> set archived_at on terminal signals older than 30 days
```

Supabase is the selected scheduler because it is already the system of record and supports minute-level `pg_cron` jobs that call Edge Functions. An application-host cron would bind the feature to a hosting provider; an always-on Node worker would add unnecessary operations work.

## 5. Component Boundaries

### 5.1 Market-data contract

`XauusdMarketDataProvider` exposes read-only quote and completed-candle methods. It has no order method.

Every accepted quote carries:

- canonical symbol `XAUUSD`;
- provider and provider instrument ID;
- native bid and ask;
- provider timestamp and server receipt timestamp;
- provider-reported market availability;
- an explicit quality classification.

Every candle set carries:

- the same provider instrument ID as the quote;
- timeframe and provider timestamps;
- ascending, unique, completed candles only;
- expected session-aware continuity;
- no synthetic spot/futures rebasing.

Pre-scan validation fails when bid or ask is absent, `ask <= bid`, quote age exceeds 15 seconds, instruments differ, candles are descending/duplicated/incomplete, or a required candle gap exists. After the engine proposes a signal, eligibility also fails when observed spread exceeds 10% of that signal's initial stop distance. Either failure records a machine-readable reason and emits no canonical signal or trade.

The present TradingView/Yahoo adapter is classified `reference_only` and cannot satisfy this contract. Production auto-paper activation remains visibly blocked until a compliant spot adapter is configured. Test and local-development flows use deterministic recorded fixtures, never fabricated live status.

### 5.2 Scan orchestrator

The worker runs each minute but evaluates a timeframe only after the provider marks a new candle complete. A unique key over user, symbol, timeframe, candle close, scan mode, and engine version makes repeated or overlapping invocations harmless.

Activating the approved account enables every currently registered engine. A later explicit user disable remains authoritative. Each enabled engine is recorded as one of:

- evaluated with vote and weight;
- evaluated and abstained;
- incompatible with the timeframe;
- excluded by an explicit versioned weighting policy;
- failed with a named error.

An engine must never disappear silently from a scan report. The current confluence, regime, location, clustering, and multi-timeframe rules may produce an eligible signal, but the worker stores the exact engine and policy versions used. Existing learned multipliers are excluded from this canonical cohort; its live weighting policy stays versioned and frozen while new learning runs in shadow mode.

No existing signal is backfilled. Only signals created after the user's profile activation time are eligible.

### 5.3 Paper execution state machine

Each eligible signal creates exactly one `paper_trade`; `signal_id` is unique. Lot size is constrained to `0.01` in both application validation and the database.

States are:

- `waiting_entry`;
- `open`;
- `tp1_protected`;
- `closed_tp2`;
- `closed_breakeven`;
- `closed_stop`;
- `expired`.

Long trades enter at ask and exit at bid. Short trades enter at bid and exit at ask. Only market observations after signal creation may affect state. An entry not touched before signal expiry becomes `expired`.

The B-single policy governs an open position:

- the entire 0.01 lot stays open at TP1;
- TP1 arms a breakeven stop at entry;
- the TP1 arming candle cannot also trigger the newly armed stop because intrabar order is unknowable;
- TP2 closes at `+2R`;
- breakeven after TP1 closes at `0R`;
- stop before TP1 closes at `-1R`.

If an older timeframe candle makes stop/target ordering unknowable, resolution uses the conservative adverse outcome and stores `ambiguous_intrabar=true`. A future tick-backed adapter may replace that approximation without changing the state-machine interface.

### 5.4 Retention

Signals and their paper trades become archive-eligible when terminal and `signals.created_at <= now() - interval '30 days'`. A daily job runs at 00:05 PHT, so archival occurs no later than 24 hours after eligibility. The job sets `archived_at`; it never deletes rows. Active queries include `archived_at IS NULL`. Archive queries expose the same immutable history.

Pending and open trades are resolved or expired according to their original lifecycle before the 30-day boundary. Any impossible non-terminal row surviving to that boundary remains visible and creates an incident instead of being hidden.

Archived resolved outcomes remain available to audit and shadow-learning queries. `signal_events` and `paper_trade_events` are never cascade-deleted by this feature.

### 5.5 PHT timestamp presentation

Database timestamps remain `timestamptz` in UTC. Every Recent Signals and generated-signal timestamp is formatted with the fixed IANA zone `Asia/Manila`, independent of browser locale settings.

Visible format:

```text
Tue, 11 Aug 2026 · 3:42:18 PM PHT
```

An accessible tooltip exposes the canonical UTC ISO timestamp. Relative age may remain secondary but never replaces the full timestamp.

## 6. Data Model

### `paper_trading_profiles`

- `user_id` primary key and foreign key to `auth.users`;
- `enabled` boolean, default false;
- `symbol` constrained to `XAUUSD`;
- `lot_size` constrained to `0.01`;
- `timezone` constrained to `Asia/Manila` for this slice;
- `strategy_scope` constrained to `all_registered`;
- `activated_at`, `updated_at`.

### `scan_runs`

- tenant, symbol, timeframe, completed-candle timestamp, engine version;
- status: `running`, `completed`, `degraded`, or `failed`;
- lease timestamps, data-quality result, evaluated/abstained/excluded engine lists;
- machine-readable error code and safe diagnostic detail;
- unique idempotency fingerprint.

### `market_snapshots`

- canonical provider/instrument identity;
- native bid/ask and provider/receipt timestamps;
- timeframe and exact completed candles used by the engine;
- content hash and quality result;
- unique provider/instrument/timeframe/candle-close identity.

Snapshots are shared between tenant scans when inputs are identical. Signals reference snapshot IDs, preventing duplicated input storage per user.
Clients cannot query raw snapshots directly; only the worker and controlled diagnostic functions can read them.

### `signals` additions

- `scan_run_id` and snapshot references;
- `engine_version` and policy version;
- unique `scan_fingerprint`;
- `generated_by = 'xauusd_paper_worker'`;
- `archived_at` and `archive_reason`.

Canonical worker-generated signals become client read-only. User actions such as invalidation must call a narrow server operation that appends a named event; direct arbitrary CRUD is removed.

### `paper_trades`

- unique `signal_id`, tenant, direction, state;
- lot size fixed at `0.01`;
- planned entry, stop, TP1, TP2;
- actual side-aware entry/exit prices and timestamps;
- `result_r`, MAE/MFE, bars held, ambiguity flag;
- instrument-cost/specification version;
- creation, update, close, and archive timestamps.

### `paper_trade_events`

- trade ID, ordered sequence number, event type, nullable provider timestamp, required worker timestamp;
- before/after state and minimal price evidence;
- append-only creation timestamp;
- unique trade/sequence identity.

## 7. Security and Zero-Order Guarantee

- Authenticated users may select only their own profiles, signals, trades, and events.
- Browser roles cannot insert or alter canonical signals, trades, fills, outcomes, or events.
- Only the secured worker role can write canonical rows.
- The worker accepts no arbitrary user ID or symbol from the cron request; it discovers enabled profiles from the database.
- Service credentials remain in Vault/server environment and never enter browser bundles or logs.
- The provider interface contains read methods only.
- No MT5 module, broker SDK, order endpoint, account credential, or generic execution port is imported into the worker dependency graph.
- A static dependency test fails if an order-capable module enters that graph.
- Every relevant screen displays `PAPER ONLY · NO BROKER CONNECTION`.

## 8. Learning Policy

Only canonical, server-generated paper outcomes produced under the same execution-policy version enter new learning reports. Historical rows scored under older semantics remain excluded from this cohort.

Learning calculates shadow candidate weights and diagnostics. It does not modify live strategy weights. Promotion requires a later design covering minimum sample sizes, purged walk-forward validation, holdout evidence, approval, versioning, and rollback.

## 9. UI Behavior

Authenticated users receive an `XAUUSD Auto-Paper` control. Enabling it creates or updates their profile with fixed symbol, lot, timezone, and strategy scope. Activation is refused with a visible data-quality message until a compliant market-data adapter passes a live health check.

Recent and generated-signal rows show:

- full PHT timestamp;
- direction, timeframe, confluence, contributing engines;
- paper state and fixed 0.01 lot;
- entry/stop/targets and actual fill/exit when present;
- R result and B-single milestone;
- provider, freshness, and last successful scan;
- paper-only/no-broker label.

Default history excludes archived signals. An Archive filter loads them without changing learning eligibility or the audit ledger. Worker degradation appears as an explicit status with its last success time and reason; stale information never looks live.

## 10. Failure Handling and Observability

- Market-data, schema, authentication, or validation failures fail closed with zero new signals or fills.
- A database lease plus unique constraints prevent concurrent duplicate work.
- State update and event append occur in one transaction.
- A failed transaction leaves the prior canonical state intact and is retried on a later worker run.
- Every run records start, finish, result, duration, data freshness, snapshot hash, strategy counts, and safe error code.
- Health UI shows last attempted scan, last successful scan, provider/instrument, quote age, spread, and degradation reason in PHT.
- Repeated worker failure, lease expiry, impossible non-terminal age, or append/update inconsistency creates a visible in-app incident derived from `scan_runs`. External paging is excluded from this slice.
- No fallback transforms futures candles into spot candles or substitutes a close for a missing executable side.

## 11. Verification

### Unit tests

- Market-data validation rejects stale, one-sided, crossed, mixed-instrument, descending, duplicate, incomplete, and gapped inputs.
- PHT formatter handles UTC day rollover and always prints the approved zone label.
- Eligibility records every enabled engine as evaluated, abstained, incompatible, excluded, or failed.
- Paper state machine covers entry, expiry, TP1 arming, next-candle breakeven, TP2, direct stop, gaps, and ambiguous ordering.
- Long and short fixtures prove correct bid/ask sides.
- Lot-size and symbol constraints reject every value except XAUUSD/0.01.

### Database and worker integration tests

- Repeated and concurrent invocations produce at most one scan, signal, and paper trade per fingerprint.
- State and event writes are atomic and ordered.
- Browser-role attempts to forge canonical rows fail under RLS.
- Provider timeout or invalid data produces a degraded run and zero trades.
- Terminal signals cross the 30-day threshold into archive without losing events or shadow-learning visibility.
- Historical pre-policy rows cannot enter the canonical cohort.

### Browser tests

- Authenticated user enables auto-paper and sees fixed XAUUSD/0.01/PHT settings.
- Browser closes; scheduled worker runs; reopening shows resulting signal/trade.
- Recent, generated, detail, and archive views show identical PHT timestamps.
- Degraded provider state is visible and cannot be mistaken for live operation.

### Delivery gates

- Full test suite passes.
- TypeScript passes with no errors.
- Production build succeeds.
- Touched files pass formatting and focused lint checks.
- Independent TypeScript, React, security, and code review finds no unresolved blocker.

## 12. Acceptance Criteria

1. Scanning continues unattended when every browser is closed.
2. Every newly completed supported timeframe is scanned once for all enabled compatible engines.
3. Every eligible new signal creates exactly one 0.01-lot paper trade.
4. Invalid or degraded data creates zero signals and zero fills.
5. No worker dependency can submit a real order.
6. Paper fills and B-single outcomes are side-aware, deterministic, and auditable.
7. Every displayed signal carries day, date, time, and `PHT` using `Asia/Manila`.
8. Terminal signals soft-archive after 30 days; events and canonical outcomes remain intact.
9. Closing or reopening the browser does not affect scanning or trade progression.
10. Existing `.env` contents and unrelated user changes remain untouched.

## 13. Rollout

1. Deploy schema and RLS changes with auto-paper disabled.
2. Deploy worker, deterministic fixtures, and health reporting.
3. Configure a compliant read-only XAUUSD spot provider and pass its live health check.
4. Enable the authenticated owner's profile at XAUUSD, 0.01 lot, all registered strategies, `Asia/Manila`.
5. Run a monitored paper-only soak period; inspect duplicate rate, data rejections, latency, and state/event consistency.
6. Keep learning in shadow mode. Real-order integration requires a separate approved design and cannot be enabled by this rollout.
