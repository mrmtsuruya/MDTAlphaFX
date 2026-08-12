// Authenticated read + profile APIs for the XAUUSD auto-paper slice (Task 9).
//
// These are the ONLY browser-facing entry points for the canonical paper
// ledger. Every function requires the user's bearer token, reads only the
// caller's own rows (RLS), and never calls the market-data provider — the
// worker owns provider access. Profiles change through the single
// set_xauusd_paper_enabled RPC; signals/trades are worker-owned and appear
// here as immutable read-only DTOs.
//
// When the schema is missing (42P01 / PGRST205 / PGRST200 / PGRST204 /
// PGRST202 — see xauusd-paper-schema-detection.ts) the functions return a
// `migration_required` health state and a disabled profile instead of
// crashing the authenticated UI.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { formatPhtTimestamp, utcIsoTitle } from "./pht-time.ts";
import { isMissingSchemaError } from "./xauusd-paper-schema-detection.ts";
import {
  mapPaperSignalListItem,
  mapPaperShadowLearningReport,
  summarizePaperPerformance,
  type PaperLearningOutcomeRow,
  type PaperPerformanceReport,
  type PaperShadowLearningReport,
  type PaperSignalJoinRow,
  type PaperSignalListItem,
} from "./xauusd-paper-view.ts";

export type { PaperPerformanceReport, PaperShadowLearningReport, PaperSignalListItem };

const SIGNAL_VIEW_SELECT =
  "id, pair, direction, mode, timeframe, entry, stop_loss, take_profit_1, " +
  "take_profit_2, atr, confluence, contributing_strategies, rationale, created_at, archived_at, " +
  "engine_version, policy_version, execution_policy_version, generated_by, scan_fingerprint, " +
  "paper_trades(state, entry_price, entry_time, tp1_armed_at, exit_price, exit_time, result_r), " +
  "market_snapshots(provider, instrument, provider_time), " +
  "scan_runs(engine_accounting)";

const OUTCOME_SELECT =
  "id, pair, direction, mode, timeframe, confluence, contributing_strategies, " +
  "created_at, archived_at, execution_policy_version, generated_by, paper_trades(state)";

const DISABLED_PROFILE = {
  enabled: false,
  symbol: "XAUUSD" as const,
  lotSize: 0.01 as const,
  timezone: "Asia/Manila" as const,
  activatedAt: null,
};

export type XauusdPaperProfile = {
  enabled: boolean;
  symbol: "XAUUSD";
  lotSize: 0.01;
  timezone: "Asia/Manila";
  activatedAt: string | null;
};

export const getXauusdPaperProfile = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("paper_trading_profiles")
      .select("enabled, activated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      if (isMissingSchemaError(error)) return DISABLED_PROFILE;
      throw new Error(error.message);
    }
    return {
      enabled: data?.enabled ?? false,
      symbol: "XAUUSD" as const,
      lotSize: 0.01 as const,
      timezone: "Asia/Manila" as const,
      activatedAt: data?.activated_at ?? null,
    } satisfies XauusdPaperProfile;
  });

export const setXauusdPaperEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ enabled: z.boolean() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("set_xauusd_paper_enabled", {
      p_enabled: data.enabled,
    });
    if (error) {
      // The RPC is a migration artifact: pre-deploy it is PGRST202 (function
      // missing from the schema cache). Route it like every other schema-missing
      // error instead of leaking raw PostgREST text to the client.
      if (isMissingSchemaError(error)) throw new Error("migration_required");
      throw new Error(error.message);
    }
    return { ok: true };
  });

export type XauusdPaperHealth = {
  status: "healthy" | "degraded" | "disabled" | "migration_required";
  provider: string;
  instrument: string;
  ok: boolean;
  code: string;
  checkedAtPht: string | null;
  checkedAtUtc: string | null;
  quoteAgeMs: number | null;
  spread: number | null;
  lastAttemptPht: string | null;
  lastSuccessPht: string | null;
  recentScans: {
    id: string;
    timeframe: string;
    status: string;
    startedAtPht: string | null;
    finishedAtPht: string | null;
    errorCode: string | null;
  }[];
};

export const getXauusdPaperHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [profileResult, healthResult, scansResult] = await Promise.all([
      supabase.from("paper_trading_profiles").select("enabled").eq("user_id", userId).maybeSingle(),
      supabase.from("paper_worker_health").select("*").eq("id", "xauusd").maybeSingle(),
      supabase
        .from("scan_runs")
        .select("id, timeframe, status, started_at, finished_at, error_code")
        .eq("user_id", userId)
        .order("started_at", { ascending: false })
        .limit(5),
    ]);
    for (const result of [profileResult.error, healthResult.error, scansResult.error]) {
      if (result) {
        if (isMissingSchemaError(result)) {
          return {
            status: "migration_required" as const,
            provider: "",
            instrument: "",
            ok: false,
            code: "migration_required",
            checkedAtPht: null,
            checkedAtUtc: null,
            quoteAgeMs: null,
            spread: null,
            lastAttemptPht: null,
            lastSuccessPht: null,
            recentScans: [],
          } satisfies XauusdPaperHealth;
        }
        throw new Error(result.message);
      }
    }

    const profile = profileResult.data;
    const health = healthResult.data;
    const scans = scansResult.data ?? [];
    const lastAttempt = scans.find((scan) => scan.started_at);
    const lastSuccess = scans.find((scan) => scan.status === "completed" && scan.finished_at);

    const status: XauusdPaperHealth["status"] = !profile?.enabled
      ? "disabled"
      : health?.ok
        ? "healthy"
        : "degraded";

    return {
      status,
      provider: health?.provider ?? "",
      instrument: health?.instrument ?? "",
      ok: health?.ok ?? false,
      // No singleton health row = the worker has never reported (not deployed,
      // or the minute cron never fired). "unknown" would make the panel read
      // like a live provider failure; this code keeps WORKER_STANDBY honest.
      code: health?.code ?? "no_health_reported",
      checkedAtPht: health?.checked_at ? formatPhtTimestamp(health.checked_at) : null,
      checkedAtUtc: health?.checked_at ? utcIsoTitle(health.checked_at) : null,
      quoteAgeMs: health?.quote_age_ms ?? null,
      spread: health && health.spread !== null ? Number(health.spread) : null,
      lastAttemptPht: lastAttempt?.started_at ? formatPhtTimestamp(lastAttempt.started_at) : null,
      lastSuccessPht: lastSuccess?.finished_at ? formatPhtTimestamp(lastSuccess.finished_at) : null,
      recentScans: scans.map((scan) => ({
        id: scan.id,
        timeframe: scan.timeframe,
        status: scan.status,
        startedAtPht: scan.started_at ? formatPhtTimestamp(scan.started_at) : null,
        finishedAtPht: scan.finished_at ? formatPhtTimestamp(scan.finished_at) : null,
        errorCode: scan.error_code,
      })),
    } satisfies XauusdPaperHealth;
  });

export const listXauusdPaperSignals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ archived: z.boolean().default(false) }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // The archive filter is a SERVER input — the client never filters a capped
    // active list; it asks for a separate server query per tab.
    const query = supabase
      .from("signals")
      .select(SIGNAL_VIEW_SELECT)
      .eq("user_id", userId)
      .eq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(200);
    if (data.archived) {
      query.not("archived_at", "is", null);
    } else {
      query.is("archived_at", null);
    }
    const { data: rows, error } = await query;
    if (error) {
      if (isMissingSchemaError(error)) throw new Error("migration_required");
      throw new Error(error.message);
    }
    return (rows ?? []).map((row) => mapPaperSignalListItem(row as unknown as PaperSignalJoinRow));
  });

export const getXauusdPaperPerformance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("signals")
      .select(OUTCOME_SELECT)
      .eq("user_id", userId)
      .eq("generated_by", "xauusd_paper_worker")
      .eq("execution_policy_version", "b_single_v1")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) {
      if (isMissingSchemaError(error)) throw new Error("migration_required");
      throw new Error(error.message);
    }
    return summarizePaperPerformance((data ?? []) as unknown as PaperLearningOutcomeRow[]);
  });

export const getXauusdShadowLearning = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("signals")
      .select(OUTCOME_SELECT)
      .eq("user_id", userId)
      .eq("generated_by", "xauusd_paper_worker")
      .eq("execution_policy_version", "b_single_v1")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) {
      if (isMissingSchemaError(error)) throw new Error("migration_required");
      throw new Error(error.message);
    }
    return mapPaperShadowLearningReport((data ?? []) as unknown as PaperLearningOutcomeRow[]);
  });
