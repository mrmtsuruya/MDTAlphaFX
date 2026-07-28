import type { Metadata } from "next";
import { ChartCanvas } from "../components/charts";
import { PageHeader, Panel } from "../components/terminal-shell";
import { syntheticMetrics } from "../data";

export const metadata: Metadata = {
  title: "Backtester",
};

const trades = [
  ["001", "XAUUSD", "M15", "BUY", "TARGET_FIRST", "+1.00 R", "SUB_BAR_WALK"],
  ["002", "XAUUSD", "M15", "SELL", "STOP_FIRST", "-1.00 R", "SUB_BAR_WALK"],
  ["003", "XAUUSD", "M15", "BUY", "TARGET_FIRST", "+0.78 R", "SUB_BAR_WALK"],
  ["004", "XAUUSD", "M15", "BUY", "TARGET_FIRST", "+1.00 R", "SUB_BAR_WALK"],
  ["005", "XAUUSD", "M15", "SELL", "STOP_FIRST", "-1.00 R", "SUB_BAR_WALK"],
  ["006", "XAUUSD", "M15", "BUY", "TARGET_FIRST", "+0.63 R", "SUB_BAR_WALK"],
];

export default function BacktesterPage() {
  return (
    <>
      <PageHeader
        eyebrow="Stage 0 evidence"
        title="Backtester"
        description="Deterministic replay controls and execution-quality diagnostics. The metrics below are the synthetic harness receipt—not strategy profitability."
        actions={<button className="button button-primary" disabled>Run replay</button>}
      />

      <div className="callout callout-info backtest-callout">
        <strong>Authoritative scope</strong>
        <span>
          109 synthetic bars · 34 trades resolved · 48 signals skipped while a
          position was open · recorded 2025 fixtures still lack M1.
        </span>
      </div>

      <Panel title="Replay configuration" subtitle="Controls remain disabled until API wiring" className="backtest-controls">
        <div className="control-grid">
          <label><span>Symbol</span><select disabled><option>XAUUSD</option></select></label>
          <label><span>Timeframe</span><select disabled><option>M15</option></select></label>
          <label><span>Dataset</span><select disabled><option>Stage 0 synthetic fixture</option></select></label>
          <label><span>Starting balance</span><input disabled value="$10,000" readOnly /></label>
          <label><span>Spread model</span><input disabled value="Approved config" readOnly /></label>
          <label><span>Intrabar policy</span><input disabled value="M1 → conservative fallback" readOnly /></label>
        </div>
      </Panel>

      <div className="metric-grid backtest-metrics">
        {syntheticMetrics.map((metric) => (
          <article className={`metric-card ${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>Stage 0 receipt</small>
          </article>
        ))}
      </div>

      <div className="backtest-chart-grid">
        <Panel title="Synthetic equity curve" subtitle="$10k reference · generated from the gate summary">
          <ChartCanvas kind="equity" className="compact-chart" />
        </Panel>
        <Panel title="Drawdown profile" subtitle="Peak-to-trough in R units">
          <ChartCanvas kind="drawdown" className="compact-chart" />
        </Panel>
        <Panel title="R-multiple distribution" subtitle="Illustrative shape · not row-level replay output">
          <ChartCanvas kind="distribution" className="compact-chart" />
        </Panel>
        <Panel title="Gate coverage" subtitle="Evidence readiness by dependency">
          <div className="coverage-bars">
            <div><span>Cost precondition</span><b><i style={{ width: "100%" }} />PASS</b></div>
            <div><span>Synthetic replay</span><b><i style={{ width: "100%" }} />PASS</b></div>
            <div><span>M1 intrabar ordering</span><b><i style={{ width: "100%" }} />PASS</b></div>
            <div className="warn"><span>Recorded broker fixtures</span><b><i style={{ width: "36%" }} />M1 MISSING</b></div>
          </div>
        </Panel>
      </div>

      <Panel title="Resolution sample" subtitle="Representative rows from the deterministic harness presentation">
        <div className="trade-table-scroll">
          <div className="trade-table" role="table" aria-label="Synthetic replay trade sample">
            <div className="trade-row trade-head" role="row">
              <span>ID</span><span>Symbol</span><span>TF</span><span>Side</span><span>Outcome</span><span>R</span><span>Resolution</span>
            </div>
            {trades.map((trade) => (
              <div className="trade-row" role="row" key={trade[0]}>
                {trade.map((cell, index) => (
                  <span className={index === 5 ? (cell.startsWith("+") ? "positive-text" : "negative-text") : ""} key={`${trade[0]}-${index}`}>
                    {cell}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </>
  );
}
