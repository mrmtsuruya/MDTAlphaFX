"use client";

import { useState } from "react";
import { ChartCanvas } from "../components/charts";
import { Panel, RegimeBadge, ScoreBar } from "../components/terminal-shell";

const timeframes = ["1M", "5M", "15M", "30M", "1H", "4H", "1D", "1W"];
const overlays = ["EMA 20", "EMA 50", "S/R levels", "Volume"];

type ChartProfile = {
  seed: number;
  regime: string;
  score: number;
  bias: string;
  regimeAge: string;
  confidence: string;
  atr: string;
  entry: string;
  target: string;
  stop: string;
  target2: string;
  rr: string;
};

const chartProfiles: Record<string, ChartProfile> = {
  "XAU/USD": {
    seed: 4044, regime: "RANGING", score: 82, bias: "H4 bullish",
    regimeAge: "14 bars", confidence: "0.84", atr: "54th",
    entry: "4,037.20", target: "4,049.80", stop: "4,029.10",
    target2: "4,061.50", rr: "1 : 2.7",
  },
  "EUR/USD": {
    seed: 1137, regime: "TRENDING", score: 74, bias: "H4 bullish",
    regimeAge: "22 bars", confidence: "0.76", atr: "43rd",
    entry: "1.13620", target: "1.14180", stop: "1.13290",
    target2: "1.14520", rr: "1 : 2.1",
  },
  "GBP/USD": {
    seed: 1329, regime: "TRANSITIONAL", score: 68, bias: "H4 neutral",
    regimeAge: "6 bars", confidence: "0.69", atr: "61st",
    entry: "1.32780", target: "1.33410", stop: "1.32390",
    target2: "1.33860", rr: "1 : 1.9",
  },
  "BTC/USD": {
    seed: 63341, regime: "VOLATILE_NEWS", score: 57, bias: "H4 bearish",
    regimeAge: "4 bars", confidence: "0.58", atr: "88th",
    entry: "63,120", target: "64,480", stop: "62,340",
    target2: "65,220", rr: "1 : 1.7",
  },
};

export function ChartWorkspace() {
  const [timeframe, setTimeframe] = useState("1H");
  const [symbol, setSymbol] = useState("XAU/USD");
  const [enabled, setEnabled] = useState(new Set(overlays));
  const profile = chartProfiles[symbol];
  const seed = profile.seed + timeframes.indexOf(timeframe) * 37;

  const toggleOverlay = (overlay: string) => {
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(overlay)) next.delete(overlay);
      else next.add(overlay);
      return next;
    });
  };

  return (
    <div className="chart-layout">
      <Panel className="chart-panel">
        <div className="chart-toolbar">
          <select
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            aria-label="Chart symbol"
          >
            {Object.keys(chartProfiles).map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <div className="timeframe-tabs" aria-label="Chart timeframe">
            {timeframes.map((item) => (
              <button
                type="button"
                className={item === timeframe ? "active" : ""}
                onClick={() => setTimeframe(item)}
                key={item}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="chart-mode-label">
            <span className="status-dot warning" /> generated candles
          </div>
        </div>

        <div className="overlay-toolbar">
          {overlays.map((overlay) => (
            <button
              type="button"
              className={enabled.has(overlay) ? "active" : ""}
              aria-pressed={enabled.has(overlay)}
              onClick={() => toggleOverlay(overlay)}
              key={overlay}
            >
              <span />{overlay}
            </button>
          ))}
        </div>

        <div className="chart-stage">
          <ChartCanvas
            seed={seed}
            showEma20={enabled.has("EMA 20")}
            showEma50={enabled.has("EMA 50")}
            showVolume={enabled.has("Volume")}
          />
          <div className="chart-watermark">
            <strong>{symbol}</strong>
            <span>{timeframe} · SIMULATION</span>
          </div>
          {enabled.has("S/R levels") ? (
            <>
              <div className="chart-level level-entry"><span>Entry {profile.entry}</span></div>
              <div className="chart-level level-target"><span>TP1 {profile.target}</span></div>
              <div className="chart-level level-stop"><span>Stop {profile.stop}</span></div>
            </>
          ) : null}
        </div>
      </Panel>

      <aside className="chart-rail">
        <Panel title="Current context" subtitle="Generated SIM context fixture">
          <div className="context-heading">
            <div>
              <strong>{symbol}</strong>
              <span>{timeframe} analysis</span>
            </div>
            <RegimeBadge regime={profile.regime} />
          </div>
          <ScoreBar value={profile.score} />
          <dl className="context-list">
            <div><dt>Bias timeframe</dt><dd>{profile.bias}</dd></div>
            <div><dt>Regime age</dt><dd>{profile.regimeAge}</dd></div>
            <div><dt>Confidence</dt><dd>{profile.confidence}</dd></div>
            <div><dt>ATR percentile</dt><dd>{profile.atr}</dd></div>
          </dl>
        </Panel>

        <Panel title="Candidate levels" subtitle="Generated fixture · not LOCKED">
          <div className="compact-levels">
            <div><span>Order intent</span><strong className="positive-text">BUY LIMIT</strong></div>
            <div><span>Entry reference</span><strong>{profile.entry}</strong></div>
            <div><span>Stop</span><strong className="negative-text">{profile.stop}</strong></div>
            <div><span>TP1 / TP2</span><strong className="positive-text">{profile.target} / {profile.target2}</strong></div>
            <div><span>Illustrative R:R</span><strong>{profile.rr}</strong></div>
          </div>
        </Panel>

        <Panel title="Evidence layers" subtitle="Generated chart annotations">
          <ul className="evidence-list">
            <li><span className="legend-dot cyan" />EMA 20 pullback</li>
            <li><span className="legend-dot amber" />H1 demand zone</li>
            <li><span className="legend-dot green" />Liquidity sweep low</li>
            <li><span className="legend-dot purple" />H4 bias alignment</li>
          </ul>
        </Panel>
      </aside>
    </div>
  );
}
