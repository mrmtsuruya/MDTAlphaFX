## 1. PROJECT OVERVIEW & ARCHITECTURE
You are an expert full-stack quantitative engineer tasked with building a complete, production-grade desktop trading platform and automated execution system inspired by MDTAlpha_FX SuperChart.

The system connects MetaTrader 5 (MT5) with a local Python AI engine and a modern Windows desktop UI, providing real-time signal analysis, multi-timeframe evaluation, and automated trade execution without requiring a paid TradingView subscription.

┌────────────────────────────────────────────────────────────────────────┐│                        WINDOWS DESKTOP SYSTEM                          ││                                                                        ││ ┌───────────────────────────┐         ┌──────────────────────────────┐ ││ │  WINDOWS DESKTOP APP UI   │ <──────>│  PYTHON FASTAPI CORE ENGINE  │ ││ │ (React + LightweightChart)│ WebSockets│ 1. 28-Strategy Engine        │ ││ └─────────────▲─────────────┘         │ 2. MTF & Opportunity Radar   │ ││               │                       │ 3. LLM Rationale & Scoring   │ ││  Updates via  │ GitHub API            └──────────────┬───────────────┘ ││  GitHub       │ (No Website Required)                │ HTTP Polling    ││  Releases ────┘                                      │ / WebRequests   ││ ┌───────────────────────────┐                        │                 ││ │   METATRADER 5 TERMINAL   │ <──────────────────────┘                 ││ │ (MQL5 EA Bridge Attached) │ Executed Orders & Positions Sync        ││ └───────────────────────────┘                                          │└────────────────────────────────────────────────────────────────────────┘
---

## 2. MODULE 1: PYTHON QUANT ENGINE & LLM CORE (`/backend`)

### Technical Specifications
- **Data Source:** Native `MetaTrader5` Python API.
- **API Framework:** `FastAPI` with `uvicorn` server running on `http://127.0.0.1:8000`.
- **LLM Engine:** Support for local models (via Ollama API at `http://localhost:11434`) and Cloud APIs (OpenAI / Gemini).

### Strategy Matrix (28 Modular Engines)
Build a dynamic evaluator class `StrategyEngine` that processes candles across 28 customizable modules across 6 categories:
1. **Smart Money Concepts (SMC):** Bullish/Bearish FVG, Order Blocks, Liquidity Sweeps, BOS, CHoCH, Breaker Blocks, Liquidity Voids.
2. **Price Action & Structure:** Quasimodo (QM) Levels, Support/Resistance Flips, Supply/Demand Zones, Double Top/Bottom Exhaustion, Pinbars, Engulfing Clusters.
3. **Trend & Momentum:** Triple EMA Stack (20/50/200), Dynamic EMA Pullback, MACD Zero-Line Cross, RSI Divergence, ADX Acceleration, Supertrend Flips.
4. **Breakout Strategies:** Range Breakouts, Session Opens (London/NY), High Volatility Expansion.
5. **Reversal Strategies:** Mean Reversion, Bollinger Band Touches, VWAP Outer Deviation Touches.
6. **Pattern Engine:** Candlestick & Chart Patterns (Double Tops/Bottoms, Head & Shoulders, Flags, Triangles).

### Market Regime & Signal Engines

1. **Multi-Timeframe Smart Analyzer:**
   - Evaluates setups concurrently across `H4`, `H1`, `M15`, `M5`, and `M1`.
   - Generates status cards showing active vs awaiting validation states per timeframe.
   - Dedicated **Scalping Mode** optimized for low-latency M1/M5 signals.

2. **Opportunity Radar (Pending Orders Engine):**
   - Scans for pending order entries (`BUY_LIMIT`, `SELL_LIMIT`, `BUY_STOP`, `SELL_STOP`).
   - Includes real-time validity checks: Tags setups as `"Take Opportunity"` or `"Too Late - Do Not Chase"` if price has passed entry limits.

3. **Multi-Pair Strategy Scanner:**
   - Scans multiple configurable symbols (e.g., XAUUSD, EURUSD, GBPUSD, BTCUSD) simultaneously in background threads.

### FastAPI Endpoint Schema

#### `GET /api/chart-data?symbol=XAUUSD&timeframe=M15`
Returns candle arrays along with overlay coordinates (FVG boxes, OB zones, EMAs, BOS/CHoCH markers, and Pattern overlays).

#### `GET /api/analyze`
Executes strategy modules and returns complete signal analysis:
```json
{
  "symbol": "XAUUSD",
  "regime": "TRENDING_BULLISH",
  "score": 92,
  "signal": "BUY_LIMIT",
  "status": "AWAITING_DECISION",
  "opportunity_status": "TAKE_OPPORTUNITY",
  "entry_zone": {"min": 2382.50, "max": 2385.00},
  "stop_loss": 2374.00,
  "take_profit_1": 2407.00,
  "take_profit_2": 2429.00,
  "timeframe_breakdown": {
    "H4": {"signal": "BUY", "status": "CONFIRMED"},
    "H1": {"signal": "BUY", "status": "CONFIRMED"},
    "M15": {"signal": "BUY_LIMIT", "status": "PENDING_RETEST"}
  },
  "contributors": [
    {"name": "Liquidity Sweep", "score": 88},
    {"name": "H1 Bullish OB", "score": 94},
    {"name": "EMA 20/50 Trend", "score": 78}
  ],
  "llm_rationale": "Price swept sell-side liquidity below Asian range low ($2,387.00) into an unmitigated H1 Bullish OB. HTF alignment confirms high-probability long setup.",
  "patterns": [
    {"name": "Bull Flag", "state": "FORMING", "timeframe": "M15"},
    {"name": "Double Bottom", "state": "COMPLETED", "timeframe": "H1"}
  ]
}
POST /api/strategy-lab/configUpdates active/disabled strategy module states dynamically.POST /api/approve-tradeDispatches signal execution approval ("MANUAL" or "AUTO").GET /api/pending-signalPolled by MT5 EA to consume pending executed orders.3. MODULE 2: WINDOWS DESKTOP GUI APP (/frontend)UI Setup & Design SystemFramework: React + Vite + Tailwind CSS wrapped in Tauri or Electron.Chart Engine: lightweight-charts (TradingView open source) connected natively to local MT5 data.Theme: Modern Dark Quantitative UI (#090d16 background, slate panel borders, green/red accent glows).Key Application ViewsMarket Overview & Evidence Chart:Main interactive chart rendering wicks, order blocks, FVG zones, pattern overlays, and target levels.Single-click "Run Analyze Market" trigger button.Signal Execution Bar: Score gauge (0–100), "Take / Approve" or "Ignore / Reject" buttons, and threshold filters.Smart Analyzer Panel:Multi-timeframe status dashboard (H4, H1, M15, M5, M1).Scalping mode toggle for fast-paced short-term signals.Opportunity Radar View:Limit and stop order workspace.Real-time order age tags ("Take Opportunity" vs. "Too Late - Do Not Chase").Pattern Engine Workspace:Categorized card views showing "Forming Patterns" (active build-up) vs. "Completed Patterns" (triggered).Strategy Lab (Module Configuration):Toggle switches for all 28 individual strategy modules (SMC, Trend, Reversals, Patterns) allowing custom confluence combinations.Strategy Scanner Panel:Overview list across multiple pairs displaying live scores, signal types, and active market regimes.Signal Center & Journal:Historical log of all generated, taken, and ignored signals with performance outcome tracking.Built-in Utility Suite:Backtester: Historical test suite for Strategy Lab presets.Risk Calculator: Dynamic lot sizing tool based on percentage risk and stop-loss distance.Settings Hub: MT5 API connection parameters and all possible cloud model integrated like Anthropic/Claude, OpenAI/Codex, Kimi, Gemini, and Ollama LLM endpoint configs.Update Engine (Zero-Cost Setup)Native GitHub Releases polling via https://github.com/USERNAME/REPO/releases/latest/download/latest.json.Automatic update download and toast notification on launch.4. MODULE 3: MQL5 EXPERT ADVISOR BRIDGE (/mql5/MDTAlpha_FX_AI_Bridge.mq5)Write a production-grade MQL5 Expert Advisor to attach to the target MT5 chart.

Key EA RequirementsPolling Loop: Queries http://127.0.0.1:8000/api/pending-signal every 1–3 seconds using WebRequest().Order Handling: Supports Market (BUY/SELL) and Pending Orders (BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP).Dynamic Lot Calculator: Automatically calculates volume using account equity and stop loss distance:$$\text{Lot Size} = \frac{\text{Account Equity} \times \text{Risk \%}}{\text{SL Distance (Points)} \times \text{Tick Value}}$$Safety Guards: Enforces Max Open Orders, Slippage Limits, and Magic Number tracking (999888).Sync Feedback: Posts execution receipts back to http://127.0.0.1:8000/api/confirm-execution.


5. TASK & IMPLEMENTATION STEPS

Follow this build order:Phase 1 (Python Engine): MT5 API connector, 28-strategy evaluator, MTF analyzer, Opportunity Radar, and FastAPI endpoints.Phase 2 (MQL5 EA Bridge): Write MDTAlpha_FX_AI_Bridge.mq5 with JSON parsing, dynamic lot sizing, pending order placement, and polling logic.Phase 3 (Desktop UI): Build React dashboard featuring Lightweight-Charts, Multi-Timeframe cards, Opportunity Radar, Strategy Lab UI, and GitHub Releases auto-updater.Phase 4 (System Integration): Validate end-to-end flow: MT5 Data → Python Signal Core → LLM Rationale → UI Approval → MQL5 Order Execution.