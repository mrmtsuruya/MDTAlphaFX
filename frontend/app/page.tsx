import type { Metadata } from "next";
import { instruments } from "./data";
import {
  PageHeader,
  Panel,
  RegimeBadge,
  ScoreBar,
} from "./components/terminal-shell";

export const metadata: Metadata = {
  title: "Market Overview",
};

const groups = ["Major pairs", "Crosses", "Metals", "Crypto", "Indices"] as const;

export default function MarketOverviewPage() {
  const bullish = instruments.filter((item) => item.direction === "BUY").length;
  const bearish = instruments.filter((item) => item.direction === "SELL").length;
  const averageScore = Math.round(
    instruments.reduce((sum, item) => sum + item.score, 0) / instruments.length,
  );
  const watchlist = [...instruments]
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  return (
    <>
      <PageHeader
        eyebrow="Tier 1 market state"
        title="Market Overview"
        description="A dense operator view of regime, direction and score readiness across the configured watchlist."
        actions={
          <button className="button button-primary" disabled title="Engine connection required">
            Analyze market
          </button>
        }
      />

      <div className="metric-grid overview-metrics">
        <article className="metric-card">
          <span>Instruments</span>
          <strong>{instruments.length}</strong>
          <small>Configured watchlist</small>
        </article>
        <article className="metric-card positive">
          <span>Bullish</span>
          <strong>{bullish}</strong>
          <small>Generated demo directions</small>
        </article>
        <article className="metric-card negative">
          <span>Bearish</span>
          <strong>{bearish}</strong>
          <small>Generated demo directions</small>
        </article>
        <article className="metric-card accent">
          <span>Average score</span>
          <strong>{averageScore}</strong>
          <small>Not a realised distribution</small>
        </article>
      </div>

      <div className="overview-layout">
        <div className="market-groups">
          {groups.map((group) => {
            const rows = instruments.filter((item) => item.group === group);
            return (
              <Panel
                key={group}
                title={group}
                subtitle={`${rows.length} configured instruments`}
                className="market-panel"
              >
                <div className="market-table" role="table" aria-label={group}>
                  <div className="market-row market-row-head" role="row">
                    <span>Instrument</span>
                    <span>Snapshot</span>
                    <span>Bias</span>
                    <span>Regime</span>
                    <span>Score</span>
                    <span>Evidence</span>
                  </div>
                  {rows.map((instrument) => (
                    <div className="market-row" role="row" key={instrument.symbol}>
                      <div className="instrument-cell">
                        <strong>{instrument.symbol}</strong>
                        <small>spread {instrument.spread}</small>
                      </div>
                      <div className="price-cell">
                        <strong>{instrument.price}</strong>
                        <small className={instrument.change >= 0 ? "up" : "down"}>
                          {instrument.change >= 0 ? "+" : ""}
                          {instrument.change.toFixed(2)}%
                        </small>
                      </div>
                      <span className={`direction direction-${instrument.direction.toLowerCase()}`}>
                        {instrument.direction}
                      </span>
                      <RegimeBadge regime={instrument.regime} />
                      <strong className={`score-number score-${instrument.score >= 80 ? "high" : instrument.score >= 70 ? "mid" : "low"}`}>
                        {instrument.score}
                      </strong>
                      <span className="evidence-pair">
                        <b>B:{instrument.breadth}</b>
                        <b>Q:{instrument.quality}</b>
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>
            );
          })}
        </div>

        <aside className="overview-rail">
          <Panel title="Highest demo scores" subtitle="UI fixture only">
            <div className="watchlist-stack">
              {watchlist.map((item) => (
                <article key={item.symbol} className="watchlist-card">
                  <div>
                    <strong>{item.symbol}</strong>
                    <RegimeBadge regime={item.regime} />
                  </div>
                  <ScoreBar value={item.score} />
                </article>
              ))}
            </div>
          </Panel>

          <Panel title="Engine readiness" subtitle="Current repository boundary">
            <ul className="readiness-list">
              <li className="ready"><span />Stage 0 harness</li>
              <li className="ready"><span />Stage 1 regime and scoring</li>
              <li className="pending"><span />Stage 2 strategy modules</li>
              <li className="pending"><span />Stage 3 pipeline assembly</li>
              <li className="blocked"><span />Execution and AUTO</li>
            </ul>
          </Panel>
        </aside>
      </div>
    </>
  );
}
