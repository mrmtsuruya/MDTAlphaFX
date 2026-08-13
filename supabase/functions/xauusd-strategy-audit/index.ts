// Strategy audit Edge Function (Deno).
//
// Weekly walk-forward scorecard writer: runs the repo's real-data backtest
// harness on the live keyless feed (XAUUSD M15 + H1) and upserts every
// strategy's resolved/win/scratch/loss/R per segment into
// public.strategy_audit_runs under the owner profile. The strategies page's
// PAPER LEDGER HEALTH view reads those rows, so the trend cluster and the
// mean-reversion flip are watched in real time rather than via one-off
// script runs.
//
// Request boundary mirrors the paper worker: the pg_cron job POSTs an empty
// body with the x-worker-secret header. The secret is the SAME
// XAUUSD_WORKER_CRON_SECRET the worker holds — no new secret to manage.

import { createClient } from "@supabase/supabase-js";
import { runRealBacktestForPair } from "../../../src/lib/real-backtest.server.ts";
import { buildAuditRunRows } from "../../../src/lib/strategy-audit-mapper.ts";

const AUDIT_TIMEFRAMES = ["M15", "H1"] as const;

export function buildAuditHandler(opts: {
  expectedSecret: string;
  runAudit: () => Promise<{
    runId: string;
    timeframes: string[];
    rowsWritten: number;
    debug: unknown;
  }>;
}) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response("ok", { status: 200 });
    }
    if (req.method !== "POST") {
      return new Response("method_not_allowed", { status: 405 });
    }
    if (req.headers.get("x-worker-secret") !== opts.expectedSecret) {
      return new Response("unauthorized", { status: 401 });
    }
    try {
      const result = await opts.runAudit();
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, error: message }, { status: 500 });
    }
  };
}

function buildAuditRunner() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return async () => {
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("audit_unconfigured");
    }
    const client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // The audit runs on behalf of the enabled paper profile's owner — the
    // same account the auto-paper worker trades for.
    const { data: profile, error: profileError } = await client
      .from("paper_trading_profiles")
      .select("user_id")
      .eq("enabled", true)
      .limit(1)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) {
      return { runId: crypto.randomUUID(), timeframes: [], rowsWritten: 0 };
    }

    const runId = crypto.randomUUID();
    let rowsWritten = 0;
    const timeframes: string[] = [];
    const debug: unknown[] = [];

    for (const timeframe of AUDIT_TIMEFRAMES) {
      const report = await runRealBacktestForPair("XAUUSD", timeframe, 720);
      timeframes.push(timeframe);
      debug.push({
        timeframe,
        totalCandles: report.totalCandles,
        completeCandles: report.completeCandles,
        sufficientData: report.sufficientData,
        insufficiencyReason: report.insufficiencyReason,
        trades: report.trades.length,
        inSample: report.inSample ? report.inSample.byStrategy.length : null,
        outOfSample: report.outOfSample ? report.outOfSample.byStrategy.length : null,
      });
      if (!report.outOfSample || !report.inSample) continue;

      const rows = buildAuditRunRows({ report, runId, userId: profile.user_id });
      for (const row of rows) {
        const { error } = await client.from("strategy_audit_runs").upsert(row, {
          onConflict: "run_id,user_id,timeframe,strategy_id,segment",
        });
        if (error) throw error;
      }
      rowsWritten += rows.length;
    }

    return { runId, timeframes, rowsWritten, debug };
  };
}

const handler = buildAuditHandler({
  expectedSecret: Deno.env.get("XAUUSD_WORKER_CRON_SECRET") ?? "",
  runAudit: buildAuditRunner(),
});

Deno.serve((req) => handler(req));
