# MDTAlphaFX — Build Plan

Given the scope, this is delivered in phases. Each phase is a working, publishable slice.

## Realistic scope (agreed)

- **System monitor tab**: mock UI now, real data later needs a local helper agent (Rust/Node) — out of scope for the web app.
- **MT5 automation**: web app exposes a signed webhook + signal API; you install a small MQL5 Expert Advisor on your MT5 desktop that polls it and places trades per your risk settings. EA code is a separate deliverable at the end.
- **Cloud AI models**: called via Lovable AI Gateway (Gemini/GPT/Claude when available) — not via CLI subscriptions. Usage/credit graphs show API token usage.
- **Forex data provider**: you'll pick one; I'll wire it. Suggested: **TwelveData** (has forex + WebSocket, free tier). Alternatives: Polygon, OANDA, FCS API.

## Phase 0 — Design + Foundation

1. Generate 3 cyberpunk design directions (dense HUD / neon-minimal / terminal-glitch) — pick one before Phase 1 UI work.
2. Enable Lovable Cloud (auth + DB).
3. Auth: email/password + Google, with `profiles` table + `user_roles` table (`admin`, `user`) for the SaaS subscription-key gating you mentioned.
4. `subscriptions` table: admin (you) issues subscription keys per email; users redeem to unlock features.
5. App shell: cyberpunk theme tokens in `src/styles.css`, Motion-based page/route transitions, sidebar nav.

## Phase 1 — Signals Core (the heart)

Routes: `/dashboard` (Market Overview), `/signals`, `/chart`, `/news`.

- **28 strategy engine**: each strategy = a pure TS module implementing `{ id, name, category, evaluate(candles, context) -> SignalCandidate | null }`. Categories: trend, momentum, mean-reversion, breakout, S/R, harmonic, order-flow proxies, session/killzone, etc. Individually toggleable per user (persisted).
- **Signal generation modes**:
  - On-demand per pair (all enabled strategies, MTF confluence H1/H4/D1 + trigger TF).
  - Market scanner across all 28 forex pairs.
  - Trader profile: **Intraday** vs **Scalper** (changes TF set, ATR multiplier, expiry).
- **Signal record**: entry, ATR-based SL, TP1, TP2, confluence score, contributing strategies, session, news/geopolitical annotations, `status`: `fresh` / `valid` / `late — do not chase` / `invalidated`, created_at, expiry.
- **Live chart**: TradingView Advanced Chart widget (free, no data cost) with our signal overlays. Real-time price ticker from chosen forex provider via WebSocket.
- **News/macro feed**: pull from a news API (e.g. Marketaux, ForexFactory calendar scrape, or NewsAPI); LLM tags each item's impacted pairs + severity; annotated onto signals.
- **Validity engine**: cron server route re-evaluates open signals every minute — updates status, marks "don't chase" once price moved > X × ATR from entry, marks invalidated on news impact or SL hit.

## Phase 2 — Backtester + Strategy Tester

Route: `/backtester`.

- Historical candle fetch (provider) + local cache in DB.
- Per-strategy or combined backtest across date range + pair + TF.
- MT5-style report: equity curve, drawdown, PF, Sharpe, win rate, expectancy, trade list.
- **Monte Carlo**: N resamples of trade sequence → CI on drawdown/return.
- **Optimizer**: grid/random search across strategy params → returns top N configs; prompts "Optimize with these params?" and persists per-user.
- Strategy Tester: replay bar-by-bar with strategy signals plotted.

## Phase 3 — AI Consult + AI News

Routes: `/consult`, `/ai-news`, `/usage`.

- **Per-signal consult panel**: click a signal → send full signal context + recent price + news to selected model (Gemini 3.6 Flash / Gemini 3.1 Pro / GPT-5.4). Returns take/skip verdict + reasoning. Streamed via `/api/chat` server route + AI SDK.
- **Usage tab**: log every AI Gateway call (model, tokens in/out, cost estimate) → chart per-model daily/weekly.
- **AI News tab**: aggregate from HN, arXiv, Papers-with-Code, LMSys/Chatbot Arena leaderboard scrape → top-10 model ranking table + curated vibe-coding ideas (LLM-summarized daily via cron).

## Phase 4 — Unified Vibe-Coding Builder

Route: `/builder`.

- Chat UI (AI Elements) where a non-technical user describes an app idea.
- Multi-model ensemble: parallel calls to 2–3 models, then a "judge" model synthesizes the best plan (screens, data model, features, tech choices).
- Output: structured PRD + starter file tree (downloadable). Not a code executor — it produces the spec you'd hand to Lovable/Bolt.

## Phase 5 — MT5 Automation Contract

Routes: `/api/public/mt5/signals` (GET, HMAC-signed), `/api/public/mt5/ack` (POST).

- User configures per-account risk: lot sizing mode (fixed/% equity/ATR-based), max concurrent trades, allowed pairs, allowed sessions.
- Web dashboard shows connected EA status, last poll time, executed trades log (ack'd back from EA).
- Deliverable: `MDTAlphaFX_EA.mq5` source — polls signals endpoint every N seconds, opens/manages trades, reports fills.

## Phase 6 — System Monitor (mock)

Route: `/system`. Cyberpunk HUD with gauges/graphs bound to mock data now; documented adapter interface so a future local agent can push real telemetry over WebSocket.

---

## Technical details

- **Stack**: TanStack Start (fixed) + Lovable Cloud (Supabase) + Tailwind v4 + shadcn + Motion for React + TradingView widget + AI SDK via Lovable AI Gateway.
- **Data**: Supabase tables — `profiles`, `user_roles`, `subscriptions`, `strategy_settings`, `signals`, `signal_events`, `backtests`, `backtest_trades`, `ai_usage`, `news_items`, `mt5_accounts`, `mt5_trades`. All with RLS scoped to `auth.uid()`; roles via `has_role()` security-definer function.
- **Server functions** (`src/lib/*.functions.ts`): generate signals, run scanner, run backtest, consult AI (streaming via `/api/chat`), rescore validity (cron), issue subscription key (admin).
- **Public routes** (`src/routes/api/public/*`): MT5 signal poll (HMAC), news webhook, cron triggers (signed with `CRON_SECRET`).
- **Secrets needed** (added later via secure form): forex data provider API key, news API key, MT5 webhook HMAC (auto-generated), `CRON_SECRET` (auto-generated). `LOVABLE_API_KEY` auto-provisioned.
- **Motion**: page transitions via Motion `AnimatePresence`, scanlines/glitch on route change, hover glow on interactive elements — kept restrained so trading data stays readable.

---

## What ships in this first build

To keep this manageable, the **first implementation turn** delivers:
- 3 design directions → your pick
- Phase 0 (auth, roles, subscription-key gating, cyberpunk shell)
- Phase 1 skeleton: routes, DB schema, 6 seed strategies (of 28), on-demand signal generation, TradingView chart, signals table, validity cron

Then we iterate: remaining 22 strategies, backtester, AI consult, news, builder, MT5 EA. Each of those is a follow-up turn.

Approve to start with the design directions.