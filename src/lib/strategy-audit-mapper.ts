// Pure mapper from a walk-forward report to strategy_audit_runs rows.
//
// Lives OUTSIDE the edge function so the mapping is unit-testable without a
// Deno runtime (the function file executes Deno.serve at import time). The
// edge function only fetches, maps, and upserts — this module owns the
// contract between the harness report shape and the DB row shape.

import type { RealBacktestReport } from "./real-backtest.ts";

export type AuditSegment = "in_sample" | "out_of_sample";

export type StrategyAuditRunRow = {
  run_id: string;
  user_id: string;
  pair: "XAUUSD";
  timeframe: string;
  strategy_id: string;
  segment: AuditSegment;
  resolved: number;
  wins: number;
  scratches: number;
  losses: number;
  open: number;
  win_rate: number | null;
  total_r: number;
  expectancy_r: number | null;
  window_start: string;
  window_end: string;
  notes: unknown[];
};

function windowEdge(
  trades: RealBacktestReport["trades"],
  pick: (a: string, b: string) => string,
): string {
  return trades.reduce((edge, trade) => (edge === "" ? trade.signalTime : pick(edge, trade.signalTime)), "");
}

/**
 * Build the upsert rows for one report run under the owner profile. The
 * report keys are `inSample`/`outOfSample` while the DB segment enum is
 * `in_sample`/`out_of_sample` — the mapping is the point of this module, and
 * the fixture test pins it so the edge function cannot silently write zero
 * rows again (the original bug).
 */
export function buildAuditRunRows(input: {
  report: RealBacktestReport;
  runId: string;
  userId: string;
}): StrategyAuditRunRow[] {
  const { report, runId, userId } = input;
  if (!report.inSample || !report.outOfSample) return [];

  const windowStart = windowEdge(report.trades, (a, b) => (a < b ? a : b));
  const windowEnd = windowEdge(report.trades, (a, b) => (a > b ? a : b));

  const rows: StrategyAuditRunRow[] = [];
  for (const segment of ["in_sample", "out_of_sample"] as const) {
    const segmentReport = segment === "in_sample" ? report.inSample : report.outOfSample;
    if (!segmentReport) continue;
    for (const stat of segmentReport.byStrategy) {
      rows.push({
        run_id: runId,
        user_id: userId,
        pair: "XAUUSD",
        timeframe: report.timeframe,
        strategy_id: stat.label,
        segment,
        resolved: stat.trades - stat.open,
        wins: stat.wins,
        scratches: stat.scratches,
        losses: stat.losses,
        open: stat.open,
        win_rate: stat.winRate ?? null,
        total_r: stat.totalR,
        expectancy_r: stat.expectancyR ?? null,
        window_start: windowStart || new Date(0).toISOString(),
        window_end: windowEnd || new Date().toISOString(),
        notes: report.notes,
      });
    }
  }
  return rows;
}
