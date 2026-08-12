# Handoff — MDTAlphaFX signal accuracy programme

**Written:** 2026-08-10. Supersedes the 2026-08-08 handoff entirely.

**State:** 258 tests passing · `npx tsc --noEmit` clean · `npm run build` green.
Verify everything with one command: `bash tools/verify.sh`

**Commits:** `d8ef020` (the programme) and `a25908f` (a scorer fix). Everything before that was untracked on disk for eleven days; it is now in git.

---

## XAUUSD Auto-Paper — activation state (2026-08-12)

**State: MIGRATIONS APPLIED, NOT LIVE.** On 2026-08-12 the Task 6/7/11 migrations were pushed to the live project `mggqzhcacqthwoygmrhg` (`supabase db push`, CLI 2.113.0): all five xauusd migrations applied cleanly, and the auto-paper panel flipped from `NOT_DEPLOYED` to `WORKER_STANDBY` in the live preview. Still NOT LIVE: the worker Edge function is not deployed, the minute cron is not scheduled (no Vault secrets / `configure_xauusd_paper_minute_job()` yet), and no profile is enabled. Do not claim the worker runs anywhere.

**Keyless feed cutover (2026-08-12):** the worker no longer needs an OANDA account. `src/lib/tv-keyless-provider.ts` implements the same `XauusdMarketDataProvider` contract against the free TradingView scanner (OANDA's retail XAUUSD bid/ask, no API key) plus Yahoo Finance candles, synthesizing two-sided bid/ask OHLC from mid + live spread (migration `20260812000000` relaxes the `market_snapshots.provider` CHECK to `('OANDA_V20_PRACTICE','TV_OANDA_FEED')`). The Edge function now reads only `XAUUSD_WORKER_CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; the OANDA secrets are gone. The Signal Center gained an MT5-style open-position block (`src/components/xauusd-paper-position.tsx` + pure `src/lib/xauusd-paper-pnl.ts`): live price, floating P&L in $ and R, and a TP1/TP2/SL price ladder.

**Commits (newest first):** `9388298` (Task 10 UI), `155744a` (Task 9 canonical read APIs), `faac17d` (Task 8 worker), `0c5a744` (Task 7 atomic RPCs), `39055aa` (Task 6 schema), `bb9904c` (pgTAP fixes), plus the Task 11 commit (`feat: secure and schedule XAUUSD paper trading`).

**Local gates (all green on 2026-08-12):** 366 unit tests · `bunx tsc --noEmit` · `bun run build` · eslint focused · 20 static contract tests in `src/lib/paper-schema-contract.test.ts` · **94/94 pgTAP assertions** across all seven `supabase/tests/database/*.test.sql` files. Run the database tests with `bun run test:db` — a committed PGlite harness (`tools/pgtap-run.mjs`, WASM Postgres 16 + pgTAP 1.3.3 vendored under `tools/pgtap/`, Supabase role/auth/cron/net/vault stubs) that needs no Postgres server, Docker, or Supabase CLI. Individual files: `node tools/pgtap-run.mjs 002` etc. `007` is the scheduler end-to-end: it inserts the three Vault secrets, runs `configure_xauusd_paper_minute_job()`, EXECUTEs the stored cron command through the `net.http_post` stub (which records into `net.http_request`), and asserts the recorded request satisfies every `createWorkerHandler` check (POST by construction, `x-worker-secret` equal to the vault secret, empty `{}` body) — the TS acceptance side is proven by `xauusd-paper-handler.test.ts`.

**Deployment facts (as of 2026-08-12, after the push):**
- `supabase/config.toml` now targets `mggqzhcacqthwoygmrhg` (was the unreachable `lcyxfrprcpyarhagkryz`); `.gitignore` gained `supabase/.temp/` (CLI link state).
- Supabase CLI 2.113.0 installed globally (npm, user-scoped); project linked; `SUPABASE_ACCESS_TOKEN` provided by the operator (never written to the repo).
- The remote had NO CLI migration history (schema was created via the dashboard SQL editor). **Baseline reconciliation:** the four legacy migrations (`20260729003507`, `20260729003547`, `20260807000001`, `20260807000002`) were marked applied in `supabase_migrations.schema_migrations` via `supabase db query --linked` (bookkeeping only, no schema change), then `db push` applied the five xauusd migrations (`20260811010000` expand, `20260811010100` catalog backfill, `20260811010200` worker RPCs, `20260811020000` RLS cutover, `20260811030000` cron). All 9 now show Applied/Remote.
- Verified live: `paper_worker_health`, `scan_runs`, `market_snapshots` return HTTP 200 (were `PGRST205`); `signals` resolves with the new provenance columns; the panel shows `WORKER_STANDBY` + "The worker has not reported health yet…" with `DEGRADATION: NONE`.
- Still unset on this machine: `SUPABASE_SERVICE_ROLE_KEY` (the worker's own DB key — from Project Settings → API). No broker credentials are needed anymore.

**Secrets required before activation:**
- Edge-function secrets: `XAUUSD_WORKER_CRON_SECRET` (matches the worker handler's `x-worker-secret` header) and `SUPABASE_SERVICE_ROLE_KEY` (the worker writes health/scan/signal/trade rows with it). `SUPABASE_URL` is provided automatically by the platform.
- Vault secrets: `project_url` (e.g. `https://mggqzhcacqthwoygmrhg.supabase.co`), `publishable_key`, `xauusd_worker_cron_secret`.
- Operator tooling: `SUPABASE_ACCESS_TOKEN`.

**Exact activation sequence (once tooling + credentials exist):** run `tools/deploy-xauusd-paper.sh` — dry-run by default (checks `.env` vs `config.toml` project ref, CLI, credentials, secrets file; prints the staged plan, touches nothing), `--go` to execute in the safe order. Raw commands for reference:
```powershell
supabase link --project-ref mggqzhcacqthwoygmrhg   # after fixing config.toml (--fix-config does it)
supabase migration list
supabase db push            # applies Tasks 6, 7, and the Task 11 cutover + cron
supabase functions deploy xauusd-paper-worker
supabase secrets set --env-file "$env:TEMP\xauusd-paper-secrets.env"  # operator-owned, outside repo
# The runbook stages vault.create_secret(...) SQL for project_url, publishable_key,
# xauusd_worker_cron_secret into a 0600 file; paste into the SQL editor, then:
# select configure_xauusd_paper_minute_job();  (service-role only; fails unless all 3 Vault secrets exist)
# Verify provider health row, then enable the owner profile through the authenticated UI toggle.
```
The minute job (`* * * * *` via pg_net POST to `/functions/v1/xauusd-paper-worker` with `x-worker-secret`) only exists after `configure_xauusd_paper_minute_job()` runs. The archive job (`5 16 * * *`) is scheduled by the cron migration itself. **Nothing auto-enables a profile.**

**Definition of live:** migration applied AND worker deployed AND `configure_xauusd_paper_minute_job()` scheduled AND provider health `ok=true` AND owner profile `enabled=true`. Until all five hold, the auto-paper panel correctly shows standby/migration-required states.

**Pre-deploy panel messaging (verified live 2026-08-12, PGRST205):** the panel is supposed to show the amber `NOT_DEPLOYED` badge (the label was renamed from `MIGRATION_REQUIRED` — at 9px mono that reads as "migration expired") with "Auto-Paper is not deployed yet — paper signals appear once the worker is running." and the toggle blocked. That path was unreachable: `isMissingSchemaError` matched on `error.message` for `42P01`/`PGRST205`, but supabase-js returns PostgREST failures as plain `{ code, message, ... }` objects (not `Error` instances) with the code in `.code` — the live project returns HTTP 404 `{"code":"PGRST205","message":"Could not find the table 'public.X' in the schema cache"}` — so the predicate never fired and the panel fell into `WORKER_STANDBY`/"Worker health has not been reported yet.". Fixed in `src/lib/xauusd-paper-schema-detection.ts` (code-first: `PGRST205`/`PGRST204`/`PGRST200`/`PGRST202`/`42P01`, message fallback), unit-tested against the live shapes, and the dashboard/signals empty states now say the schema is not deployed instead of telling the user to "enable Auto-Paper above". A static contract (`src/lib/xauusd-paper-functions-contract.test.ts`, 4 tests) now pins the wiring: every authenticated server function must route missing-schema errors through `isMissingSchemaError` (returning `DISABLED_PROFILE` / `migration_required` health / throwing the canonical `"migration_required"` marker) before any raw PostgREST-text throw — which surfaced and fixed the one unguarded path, `setXauusdPaperEnabled` (pre-deploy its RPC is `PGRST202`).

**Post-migration standby messaging (worker never reported):** once the schema exists but `paper_worker_health` has no row, `getXauusdPaperHealth` now returns `code: "no_health_reported"` (was `"unknown"`), so the panel's `WORKER_STANDBY` toggle reason reads "The worker has not reported health yet — it posts once per minute once deployed and the minute cron is running; activation unlocks on the first healthy report." instead of the old "Live provider health failed (unknown)". The dashboard/signals empty states show the same standby copy instead of telling the user to enable Auto-Paper. A genuine provider failure (row exists, `ok=false`) still reads "Live provider health failed (<code>)".

---

## 0. Orientation — read this before touching anything

### Build from a sandbox copy, not in place

`tools/verify.sh` exists because two environment facts make an in-place build impossible. Neither is a code problem:

- **`node_modules` holds win32 native bindings only.** Linux needs its own for rolldown, lightningcss, tailwind-oxide, oxc-parser and rollup. These have been fetched and placed alongside the win32 ones. **They are lost the moment anyone reinstalls `node_modules`.** If the build starts failing with `Cannot find module '../*.linux-x64-gnu.node'`, that is what happened — re-fetch the matching versions.
- **Some Windows-created files cannot be unlinked from Linux**, so vite cannot clear `.output` in place. Hence the sandbox copy with per-entry symlinked `node_modules` and local build-cache directories.

### Package manager

**This repo uses bun. Never run `npm install`.** A dry run of `npm install --save-dev` wanted to change 193 packages and remove 39. Use `bun add`.

### Git

If `git add` reports *"Unable to create index.lock: File exists"*, a stale lock is present — a git process was killed by the mount's unlink restriction. `rm -f .git/index.lock` and retry. Nothing is running.

`.env` is **tracked despite being gitignored**, and its working-tree values differ from HEAD. It holds only Supabase publishable keys and URLs (no service-role; the `VITE_` ones ship to the browser by design), so nothing is leaking, but it is deliberately excluded from both commits. Decide what you want: `git rm --cached .env` stops future churn but will break anything that expects it in the repo, so it is left as-is.

---

## 1. What this programme was for

The engine emitted uncalibrated confluence scores, measured its own performance optimistically, and had no concept of *where* price was — which is the mechanism behind buying tops. The owner's brief was explicit: **calibrate the strategies, do not add gates.** Every change below is a re-weighting or a truth-teller. Nothing new vetoes a signal.

Owner context that shapes decisions: trades **XAUUSD primarily**, JustMarkets Standard, **fixed 0.01 lot**, ~$200 balance. Gold gets special handling throughout.

---

## 2. Measurement — was systematically optimistic

**Side-aware fills.** A long enters at the ask and exits at the bid; a short mirrors it. Both resolvers were testing those levels against **mid** candles, which under-detects stops and over-detects targets. Both errors point the same way and scale with spread.

> Worked example, real fixture: XAUUSD long, entry 3400, stop 3390, TP1 3412.5. Bar 1 low is 3390.05. Old rule: touched nothing, bar 2 reached target → **+1.25R win**. New rule: bid low is 3389.95, below the stop → **−1R on bar 1**. A **2.25R swing** on one trade.

Fixed in `replaySignalPath` (`signal-scorer.ts`) and `resolveSignalOutcome` (`real-backtest.ts`). Tests cross-check the two so they cannot drift.

**`costs.ts`** is the single source of truth for spread. Values are **PROVISIONAL** — typed from published JustMarkets figures, not measured. Replace with per-hour-of-week statistics once Dukascopy history exists. Do not invent a session curve before then.

**MAE / MFE and `barsHeld`** recorded on every trade. Not decoration — they are the data stop and target multiples will be fitted from.

### B-single execution

A 0.01 lot cannot be halved (minimum lot step *is* 0.01), so "take 50% at TP1" is unexecutable. TP1 instead **arms a breakeven stop** and the whole position runs to TP2.

| Status | Meaning | R |
| --- | --- | --- |
| `hit_tp2` | Reached TP2 | +2 |
| `hit_tp1` | **Breakeven exit after TP1 — a scratch, not a win** | 0 |
| `hit_sl` | Stopped before TP1 | −1 |

`hit_tp1` changed meaning without changing name — no enum migration was needed. **Anything counting wins must exclude it from both tallies.** Fixed in `buildPerformanceReport`, the per-strategy table and `computeStrategyLearning`; five UI strings that printed "+1.25R" now read "BE after TP1".

`breakevenLevel(entry)` returns `entry` unchanged and the comment is the whole point: a long exits on the bid, so exiting flat means the *bid* must return to entry, and the resolvers' existing side-aware conversion lands exactly there. At the instant of entry that level sits one full spread adverse — which is why it is only armed after TP1.

**The arming bar does not test its own new stop.** Intrabar order is unknowable; assuming a same-candle round trip from TP1 back to breakeven is a guess dressed as a measurement.

---

## 3. Reasoning layers

| Module | What it does |
| --- | --- |
| `regime.ts` | Wilder ADX(14), ATR percentile, Kaufman efficiency ratio → `strong_trend / weak_trend / range / expansion / contraction`. Per-category weights 0.65–1.25, **never zero**. Mean-reversion damped in trends, favoured in ranges. |
| `location.ts` | Premium/discount within the dominant swing, adverse distance from EMA21, headroom to structure. A 0.6–1.25 multiplier and a `chasing` flag. **The direct fix for buying tops.** |
| `strategy-clusters.ts` | Confluence counts **clusters, not votes**. |
| `mode-arbiter.ts` | scalp / intraday / wait / stand_down, with the evidence stated in a sentence. |
| `armed-setup.ts` | Forming-but-not-triggered setups: five conditions, trigger, invalidation, expiry. Replaces a bare "no setup". |
| `calibration.ts` | Isotonic (PAVA) reliability curve. Refuses to report below 20 samples per bin. |
| `replay-analytics.ts` | Excursion diagnostics: is TP1 too far, is the stop inside the noise. Descriptive, **not** an optimiser. |

**Clustering, measured:** six moving averages all agreeing scored **95 → 74**. Four genuinely independent reads scored **84 → 84**. It discounts duplication and leaves real confluence untouched. The old independence proxy (`categories.size >= 2`) never caught this, because those six span *trend* and *breakout* and `macd_hist` sits in *momentum* while being EMA-derived.

**Direction** is decided by summed weighted strength, not vote count, with `DIRECTION_MARGIN = 0.58`. Exact ties no longer default long.

### Five new strategies

The catalog had **nothing detecting exhaustion** — it could say a move was running, never that it was ending. Added: `rsi_divergence`, `macd_divergence`, `climax_exhaustion`, `stop_run_reversal`, `failed_breakout`. All five draw on the chart; `chart-overlays.test.ts` has a guard test that fails if any strategy has neither geometry nor an explicit `NO_GEOMETRY` entry.

### Macro/news — four bugs

- **`eventWithinWindow` discarded the event date**, matching ±8h on time-of-day alone — roughly two-thirds of the clock. `news_reactive` fired on essentially any calendar week. Timestamps are now parsed once at source; the window is `(-30, +60]` minutes around the real release.
- **The macro nudge added +5 confluence** for any high-impact event, unconditionally. Now a proximity-scaled penalty — 0 at 60 minutes out, −8 at release — with **no positive branch anywhere**.
- **COT voted at full strength when stale.** Now decays on a 5-day half-life, abstains past 14 days.
- **Injectable clock** so a replay judges "imminent" against the bar being replayed, not today. See §5.

---

## 4. Escape hatches — three, and they are load-bearing

Each exists so a change stays **measurable** rather than assumed. All three are used by tests:

| Parameter | Where | Effect |
| --- | --- | --- |
| `opts.halfSpread: 0` | both resolvers | reproduces the old mid-price behaviour |
| `opts.policy: "all_out"` | both resolvers | reproduces pre-B-single scoring |
| `regimeOverride: "none"` | `scanCandlesForSignal` | disables regime weighting entirely |
| `clusterMap` | `scanCandlesForSignal` | pass an identity map to reproduce pre-clustering confluence |

**Why this matters more than it looks.** `regimeOverride` was added *after* regime weighting silently destroyed test coverage: two tests pinning the exact-tie and strength-beats-count properties stopped exercising those boundaries because the regime table nudged their fixtures off the edge. The suite stayed green; the coverage was gone. **If you add another global re-weighting layer, expect the same and check for it.**

---

## 5. Traps that cost time to find

- **The injectable clock is a latent fix, not an active one.** `real-backtest.ts` passes no `macro`, so `news_reactive` and `ai_confluence` abstain during a replay before any clock logic runs. It earns its place as a **prerequisite for W7** — the moment event data is threaded into the backtest, wall-clock reads would corrupt every replayed bar.
- **Fixture dates.** Candles are stamped in the past, so a wall-clock COT `reportDate` sits in the *future* relative to them and reads as a negative age. Use `cotDateForCandles()`.
- **`trendCandles` ends on a red pullback bar** by design, which suppresses `news_reactive`'s 3-bar impulse gate. Build your own fixture if you need that strategy to fire.
- **`news_reactive` is declared on `["M15","H1","H4"]`** — an M5 scan filters it as incompatible before any logic runs.
- **Armed setups are deliberately not persisted.** They are a live read recomputed each scan; a table or a `signals.status` value would imply a history they do not have. Resist this when a UI wants to list "currently armed".
- **`scoreSignal`'s output is written to the database**, not just displayed — it is the fallback when no candles are available to replay. It can never return `hit_tp1`, because a snapshot cannot know whether TP1 was touched earlier (see `a25908f`).

---

## 6. Blocked on data — the only thing standing between here and the rest

`tools/fetch-history.mjs` pulls real Dukascopy bid/ask history. **It has not been run.** It must run on a normal machine — the agent sandbox has no egress to `datafeed.dukascopy.com`, and none to Yahoo or TradingView either, so the live feed and the backtester are equally unreachable from there.

```bash
bun add -d dukascopy-node
node tools/fetch-history.mjs --instrument xauusd --timeframe m1 --from 2016-08-01 --to 2026-08-01
node tools/fetch-history.mjs --instrument xauusd --timeframe tick --from 2024-08-01 --to 2026-08-01
```

Output lands in `data/history/` (gitignored — gold ticks run to gigabytes per year) with a coverage manifest. Resumable; interrupt freely. Yahoo cannot substitute: **H1 caps at one month of history, M1 at one day.**

Four workstreams are built, tested, and waiting on it:

1. **Measured cost model** — replace `costs.ts`'s provisional flat spreads with per-hour-of-week statistics.
2. **W3.1 re-derived clusters** — `computeAgreementMatrix` + `clusterByAgreement` already exist. Today's map is a *prior* based on what each strategy reads; with history it becomes a *measurement*. Two strategies agreeing 95% of the time are one signal whatever their indicators look like.
3. **W4 parameter calibration** — extract the hardcoded constants (EMA 21/55, RSI 55/45, Donchian 20, ATR ×1.25, and the rest), fit per pair/timeframe/regime with purged walk-forward, permutation testing and a plateau check. `replay-analytics.ts` deliberately stops short of this: picking a target by eyeballing an MFE percentile on the same trades that produced it is exactly the overfit that makes backtests lie.
4. **W7 event reaction profiles** — release spread blowout, first-minute range, direction persistence, surprise-to-move mapping. Predicting the *released number* is explicitly out of scope; predicting the *reaction* is where the edge is.

**A faster read available today, without Dukascopy:** open the Backtester, XAUUSD / H1, `RUN_REAL_BACKTEST`, and look at the **Level Diagnostics** panel. If it clears 30 resolved trades it will say whether TP1 at 1.25R is in the wrong place on real gold data. If it says insufficient, try H4 or D1.

---

## 7. Open decisions

- **Pairs after gold.** Everything is gold-first by design. Which order for the other 13?
- **MT5 execution** — parked. W6's paper execution replaced it and is arguably better as a learning input, since it works on replayed history too.
- **`.env`** — see §0.

## 8. Known issues

- **One flake, never reproduced.** `verify.sh` reported 191/192 once; ~20 runs since have been clean. The clock injection removed the most likely cause. If it returns, the remaining `Date.now()` sites in tests are the place to look.
- **Pre-existing prettier debt** in files this programme never touched — `integrations/supabase/types.ts` (generated), `market-data.server.ts`, `backtester.tsx`. Left alone deliberately: blanket-reformatting them would have buried the real diff. Files that *were* touched are lint-clean apart from two `react-hooks/exhaustive-deps` warnings in `chart.tsx` documented as intentional since the previous handoff.
- **Historical rows were scored under the old policy.** Anything already resolved in the database used all-out semantics and pre-spread fills. Re-scoring is correct in principle, out of scope here.

## 9. Working agreement that produced this

Every change was specified before implementation, implemented against that spec, then **independently verified by re-deriving the result rather than re-reading the code** — property tests over hundreds of seeded series for the statistical parts, adversarial fixtures for the rest. Several defects were caught that way and not by the tests as written, including the coverage loss in §4 and the inert-wiring risk in clustering.

If you continue this work: the escape hatches in §4 are how you check a change did what it claims. Use them.
