import type { Metadata } from "next";
import { PageHeader, Panel } from "../components/terminal-shell";
import { StrategyCatalog } from "./strategy-catalog";

export const metadata: Metadata = {
  title: "Strategies",
};

export default function StrategiesPage() {
  return (
    <>
      <PageHeader
        eyebrow="Tier 2 module library"
        title="Strategies"
        description="The complete 28-module catalogue from the specification, shown honestly as interfaces awaiting Stage 2 implementation."
      />

      <div className="metric-grid strategy-metrics">
        <article className="metric-card"><span>Defined modules</span><strong>28</strong><small>Frozen §4 catalogue</small></article>
        <article className="metric-card"><span>Correlation clusters</span><strong>9</strong><small>A through H, split D</small></article>
        <article className="metric-card"><span>Implemented</span><strong>0</strong><small>Stage 2 not authorized</small></article>
        <article className="metric-card accent"><span>Production results</span><strong>0</strong><small>No synthetic detections counted</small></article>
      </div>

      <Panel
        title="Module catalogue"
        subtitle="Pure detectors · no I/O · no regime awareness"
        className="catalog-panel"
      >
        <StrategyCatalog />
      </Panel>
    </>
  );
}
