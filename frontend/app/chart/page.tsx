import type { Metadata } from "next";
import { PageHeader } from "../components/terminal-shell";
import { ChartWorkspace } from "./chart-workspace";

export const metadata: Metadata = {
  title: "Chart",
};

export default function ChartPage() {
  return (
    <>
      <PageHeader
        eyebrow="Price and evidence"
        title="Chart"
        description="A generated SIM fixture for reviewing chart layout, evidence layers and candidate levels before engine integration."
      />
      <ChartWorkspace />
    </>
  );
}
