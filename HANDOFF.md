# Handoff — signal accuracy programme

Session date: 2026-08-10. Supersedes the 2026-08-08 handoff, which is now wrong in several load-bearing places (it reports 44 tests, says the production build has never succeeded, and describes `hit_tp1` as a +1.25R win — none of those hold any more).

**State:** 234 tests passing, `npx tsc --noEmit` clean, `npm run build` green. Verify everything with `bash tools/verify.sh`.

---

## 0. Read this first

**Most of `src/lib` is untracked in git.** The last commit is `bfe3a42` (2026-07-30). The entire signal engine — `signal-engine.ts`, `regime.ts`, `location.ts`, `costs.ts`, `calibration.ts`, `armed-setup.ts`, `mode-arbiter.ts`, `replay-analytics.ts`, `mtf-engine.ts`, `signal-scorer.ts`, `signal-learning.ts`, `strategy-weights.ts`, `market-data.server.ts`, `macro-data.server.ts`, `chart-overlays.ts`, `order-ticket.ts`, `real-backtest*.ts` and every test file — exists only on disk. A `git checkout .` loses all of it.

There is a backup tarball at the repo root (`MDTAlphaFX-BACKUP-*.tar.gz`, gitignored), but that is not version control. **Commit before doing anything else.**

**Do not run `npm install` in this repo.** It uses bun. A dry run of `npm install --save-dev` wanted to change 193 packages and remove 39 — it would wreck the dependency tree. Use `bun add`.

---

## 1. Building and verifying

`tools/verify.sh` builds from a sandbox copy. Two environment facts make that necessary and neither is a code problem:

- `node_modules` holds **win32** native bindings only. Linux needs its own for rolldown, lightningcss, tailwind-oxide, oxc-parser and rollup. These have been fetched and placed alongside the win32 ones — additive, harmless to Windows, and lost the moment anyone reinstalls `node_modules`. If the build starts failing with `Cannot find module '../*.linux-x64-gnu.node'`, that is what happened; re-fetch the matching versions.
- Some Windows-created files **cannot be unlinked from Linux**, so vite cannot clear `.output` in place. Hence the sandbox copy with per-entry symlinked `node_modules` and local build-cache directories.

```bash
bash tools/verify.sh     # tests + typecheck + build
npm test                 # 234
npx tsc --noEmit
npm run lint             # see §6 for the pre-existing debt
```

---

## 2. What changed, and why it mattered

### 2.1 Measurement was systematically optimistic

Both outcome resolvers tested bid/ask-referenced levels against **mid** candles. A long enters at the ask and exits at the bid, so `bar.low <= stopLoss` under-detected stops and `bar.high >= takeProfit` over-detected targets. Both errors pointed the same way and scaled with spread — worst on XAUUSD.

Worked example from the test fixtures: a gold long, entry 3400, stop 3390, TP1 3412.5. Bar 1's low is 3390.05. Under the old rule that touched nothing and bar 2 reached the target: **+1.25R, logged as a win**. Under the bid-aware rule the effective bid low is 3389.95, below the stop: **−1R on bar 1**. A 2.25R swing on one trade, from one wrong comparison.

Fixed in `signal-scorer.ts` (`replaySignalPath`) and `real-backtest.ts` (`resolveSignalOutcome`), which are cross-checked against each other in tests so they cannot drift.

### 2.2 Execution policy now matches the account

`src/lib/costs.ts` holds the cost model. `breakevenLevel(entry)` returns `entry` unchanged and the comment explains why that is right — a long exits on the bid, so exiting flat means the *bid* must return to entry, and the resolvers' existing side-aware conversion lands exactly there.

**B-single** is the policy: a 0.01 lot cannot be halved, so TP1 does not close the trade. It arms a breakeven stop and the position runs to TP2.

| Status | Meaning | R |
| --- | --- | --- |
| `hit_tp2` | Reached TP2 | +2 |
| `hit_tp1` | **Breakeven exit after TP1 — a scratch, not a win** | 0 |
| `hit_sl` | Stopped before TP1 | −1 |

`hit_tp1` changed meaning without changing name (no enum migration was needed). Anything counting wins must exclude it from **both** tallies — `buildPerformanceReport`, the per-strategy table and `computeStrategyLearning` were all fixed, and five UI strings that printed "+1.25R" now read "BE after TP1".

The arming bar deliberately does **not** test its own new stop. Intrabar order is unknowable; assuming a same-candle round trip from TP1 back to breakeven is a pessimistic guess, not a measurement.

`policy: "all_out"` is retained on both resolvers so the change stays measurable.

### 2.3 MAE / MFE are recorded

Every resolved trade now carries maximum adverse and favourable excursion in R, plus `barsHeld`. These are not decoration — they are what will let stop and target multiples be fitted from data instead of the hardcoded 1.25R / 2R. `replay-analytics.ts` consumes them.

### 2.4 Four macro/news bugs

- **`eventWithinWindow` discarded the event date.** It matched on time-of-day with a ±480-minute window, which covers roughly two-thirds of the clock — `news_reactive` fired on essentially any calendar week. Timestamps are now computed once at parse time in `macro-data.server.ts` and the window is `(-30, +60]` minutes around the real release.
- **The macro nudge had the wrong sign.** Any high-impact event added +5 confluence unconditionally. Replaced by `macroConfluenceAdjustment()`: 0 at 60 minutes out, −4 at 30, −8 at release, −4 for 30 minutes after. No positive branch exists.
- **COT voted at full strength when stale.** Now decays on a 5-day half-life and abstains past 14 days.
- **Ties defaulted long.** `longs.length >= shorts.length` in both the engine and `mtf-engine.ts`. Direction is now decided by summed weighted strength with `DIRECTION_MARGIN = 0.58`; below that there is no directional edge and no signal.

### 2.5 Reasoning layers

| Module | What it does |
| --- | --- |
| `regime.ts` | ADX(14) Wilder, ATR percentile, Kaufman efficiency ratio → `strong_trend / weak_trend / range / expansion / contraction`. Per-category weights (0.65–1.25, never zero) so mean-reversion is damped in trends and favoured in ranges. |
| `location.ts` | Premium/discount within the dominant swing, adverse distance from EMA21, headroom to structure. A 0.6–1.25 multiplier on confluence and a `chasing` flag. **This is the direct fix for buying tops.** |
| `mode-arbiter.ts` | Decides scalp / intraday / wait / stand_down from regime + location + pending releases, and says why in a sentence. |
| `armed-setup.ts` | A setup that is forming but not triggered: five conditions, a trigger level, an invalidation level, an expiry. Replaces a bare "no setup". |
| `calibration.ts` | Isotonic (PAVA) reliability curve mapping confluence to observed TP2 rate. Refuses to report below 20 samples per bin. |
| `replay-analytics.ts` | Excursion distributions and level diagnostics over backtest trades. Descriptive, not an optimiser. |

Five new strategies fill the exhaustion gap the catalog had: `rsi_divergence`, `macd_divergence`, `climax_exhaustion`, `stop_run_reversal`, `failed_breakout`. All five draw on the chart — `chart-overlays.test.ts` has a guard test that fails if any strategy has neither geometry nor an explicit `NO_GEOMETRY` entry.

---

## 3. Escape hatches, and why they exist

Three optional parameters exist so a change can be **measured** rather than assumed. They follow the same pattern and all three are load-bearing for tests:

- `opts.halfSpread` on both resolvers — `0` reproduces the old mid-price behaviour.
- `opts.policy: "all_out"` on both resolvers — reproduces pre-B-single scoring.
- `regimeOverride: "none"` on `scanCandlesForSignal` — disables regime weighting entirely.

The last one was added after regime weighting silently destroyed test coverage: two tests that pinned the exact-tie and strength-beats-count properties stopped exercising those boundaries because the regime table nudged their fixtures off the edge. Tests stayed green; coverage was gone. If you add another global re-weighting layer, expect the same and check for it.

---

## 4. Blocked on data

`tools/fetch-history.mjs` pulls real Dukascopy bid/ask history. **It has not been run.** The sandbox has no egress to `datafeed.dukascopy.com`, so it must run on a normal machine:

```bash
bun add -d dukascopy-node
node tools/fetch-history.mjs --instrument xauusd --timeframe m1 --from 2016-08-01 --to 2026-08-01
node tools/fetch-history.mjs --instrument xauusd --timeframe tick --from 2024-08-01 --to 2026-08-01
```

Output lands in `data/history/` (gitignored — gold ticks run to gigabytes per year) with a coverage manifest. Resumable; interrupt freely.

Yahoo cannot substitute: H1 caps at one month of history, M1 at one day.

Four workstreams are built and waiting on it:

1. **Measured cost model** — replace the provisional flat spreads in `costs.ts` with per-hour-of-week statistics.
2. **W3.1 correlation clustering** — roughly eight of the 36 strategies are the same EMA read, and confluence currently counts them as independent. The cluster map should come from real vote-agreement across years. Expect confluence readings to drop into the 50s–60s; that is the fix working.
3. **W4 parameter calibration** — extract the hardcoded constants, fit per pair/timeframe/regime with purged walk-forward, permutation testing and a plateau check.
4. **W7 event reaction profiles** — release spread blowout, first-minute range, direction persistence, surprise-to-move mapping.

---

## 4a. The injectable clock, and what it does and does not fix

`evaluateStrategy` takes an optional `now`. `scanCandlesForSignal` and `evaluateTfDirection` derive it from the **last complete bar** rather than the wall clock, because the two macro-aware strategies (`news_reactive`, `ai_confluence`) judge "is a release imminent" and "how stale is this COT report" against a reference time, and in a replay that reference is the bar, not today.

**Scope, stated accurately:** this is currently a **latent** fix, not an active bug fix. `real-backtest.ts` passes no `macro` into `scanCandlesForSignal`, so both strategies abstain during a replay before any clock logic runs. Live, the last bar and the wall clock coincide closely enough not to matter.

It earns its place for two reasons: it makes the scan a pure function of its inputs (three tests assert this), and it is a **prerequisite for W7** — the moment event data is threaded into the backtest, wall-clock reads would have silently corrupted every replayed bar.

Related fixture trap, worth knowing before writing tests: candles are stamped in the past, so a wall-clock COT `reportDate` sits in the *future* relative to them and reads as a negative age. `cotDateForCandles()` derives it from the fixture's own last bar instead.

## 5. Known issues

- **One flaky test.** `verify.sh` reported 191/192 once; twelve subsequent runs across both environments were clean and it has not reproduced. 20 test sites depend on `Date.now()` or relative dates — most likely a boundary flake. Worth pinning clocks. A flaky suite in a trading engine erodes trust in every green run.
- **`scoreSignal` still uses mid.** It is the live-standing *display* approximation; `replaySignalPath` is authoritative and nothing feeding learning uses `scoreSignal`. It will read slightly optimistic on screen.
- **Historical rows were scored under the old policy.** Anything already resolved in the database used all-out semantics and pre-spread fills. Re-scoring is correct in principle and was left out of scope.
- **Armed setups are not persisted.** They are a live read recomputed each scan. Giving them a table or a `signals.status` value would imply a history they do not have — resist that when a UI wants to list "currently armed".

---

## 6. Lint

Files touched this session are clean apart from two pre-existing `react-hooks/exhaustive-deps` warnings in `chart.tsx` that the previous handoff already documented as intentional.

There is **pre-existing prettier debt in files nobody touched** — `integrations/supabase/types.ts` (generated), `market-data.server.ts`, and others. Left alone deliberately: blanket-reformatting files outside the work would bury the real diff. Run `npx prettier --write` on them separately if you want a clean `npm run lint`.
