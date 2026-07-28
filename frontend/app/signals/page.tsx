import type { Metadata } from "next";
import { signals } from "../data";
import {
  PageHeader,
  Panel,
  RegimeBadge,
  ScoreBar,
} from "../components/terminal-shell";

export const metadata: Metadata = {
  title: "Signal Center",
};

const validityCopy = {
  TAKEABLE: "Entry available",
  PENDING: "Waiting for trigger",
  CAUTION: "Reduced confidence",
  TOO_LATE: "Do not chase",
};

export default function SignalCenterPage() {
  return (
    <>
      <PageHeader
        eyebrow="Decision surface"
        title="Signal Center"
        description="Candidate lifecycle, order intent and chase validity shown together—before an operator decides."
        actions={
          <div className="segmented-control" aria-label="Signal view">
            <button className="active" type="button">Active</button>
            <button type="button">History</button>
          </div>
        }
      />

      <div className="signal-summary">
        <div><span className="status-dot positive" />1 takeable</div>
        <div><span className="status-dot accent" />1 pending</div>
        <div><span className="status-dot warning" />1 caution</div>
        <div><span className="status-dot negative" />1 too late</div>
      </div>

      <div className="signal-grid">
        {signals.map((signal) => (
          <Panel className={`signal-card signal-${signal.validity.toLowerCase()}`} key={signal.id}>
            <div className="signal-card-top">
              <div className="signal-symbol">
                <span className={`side-marker side-${signal.direction.toLowerCase()}`}>
                  {signal.direction === "BUY" ? "▲" : "▼"}
                </span>
                <div>
                  <h2>{signal.symbol}</h2>
                  <p>{signal.timeframe} · {signal.id}</p>
                </div>
              </div>
              <span className={`validity-badge validity-${signal.validity.toLowerCase()}`}>
                {signal.validity}
              </span>
            </div>

            <div className="signal-tags">
              <span className={`order-badge side-${signal.direction.toLowerCase()}`}>
                {signal.orderType}
              </span>
              <RegimeBadge regime={signal.regime} />
              <span className="lifecycle-badge">{signal.lifecycle}</span>
            </div>

            <ScoreBar value={signal.score} label="Composite" />

            <div className="signal-evidence">
              <div><span>Breadth</span><strong>{signal.breadth}</strong></div>
              <div><span>Quality</span><strong>{signal.quality}</strong></div>
              <div><span>R:R</span><strong>{signal.rr}</strong></div>
              <div><span>Expires</span><strong>{signal.expires}</strong></div>
            </div>

            <div className="levels-grid">
              <div className="entry-level">
                <span>Entry zone</span>
                <strong>{signal.entry}</strong>
              </div>
              <div className="stop-level">
                <span>Stop</span>
                <strong>{signal.stop}</strong>
              </div>
              <div className="target-level">
                <span>TP1</span>
                <strong>{signal.tp1}</strong>
              </div>
              <div className="target-level">
                <span>TP2</span>
                <strong>{signal.tp2}</strong>
              </div>
            </div>

            <div className="validity-explanation">
              <strong>{validityCopy[signal.validity]}</strong>
              <p>{signal.note}</p>
            </div>

            <div className="signal-actions">
              <button className="button button-secondary" type="button">Open chart</button>
              <button
                className="button button-primary"
                type="button"
                disabled
                title="Execution wiring is not connected"
              >
                Review intent
              </button>
            </div>
          </Panel>
        ))}
      </div>

      <div className="callout callout-warning">
        <strong>No signals on this screen are executable.</strong>
        <span>
          They are deterministic UI fixtures. Production signals require Stage 2
          modules, Stage 3 assembly, journal persistence, and execution authorization.
        </span>
      </div>
    </>
  );
}
