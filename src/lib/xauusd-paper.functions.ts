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
import { fetchMarketCandles } from "./market-data.server.ts";
import { computeStrategyLearning } from "./signal-learning.ts";
import { computeStrategyWeights } from "./strategy-weights.ts";
import { evaluatePromotionGate, activeMultipliers, type PromotionLedgerRow } from "./strategy-promotion.ts";
import {
  mapPaperSignalDetail,
  mapPaperSignalListItem,
  mapPaperShadowLearningReport,
  canonicalOutcomes,
  summarizePaperPerformance,
  summarizePaperStrategyHealth,
  type PaperAccountRow,
  type PaperLearningOutcomeRow,
  type PaperPerformanceReport,
  type PaperShadowLearningReport,
  type PaperSignalDetail,
  type PaperSignalDetailRow,
  type PaperSignalJoinRow,
  type PaperSignalListItem,
  type PaperStrategyHealthReport,
  type PaperStrategyHealthRow,
} from "./xauusd-paper-view.ts";

export type { PaperAccountRow, PaperPerformanceReport, PaperShadowLearningReport, PaperSignalDetail, PaperSignalListItem, PaperStrategyHealthReport };

// market_snapshots has TWO relationships to signals (the FK via
// market_snapshot_id AND the many-to-many via signal_market_snapshots), so
// PostgREST refuses the bare embed with PGRST201. Pin the canonical FK embed
// so the list query resolves (the panel reads the signal's own snapshot).
const SIGNAL_VIEW_SELECT =
  "id, pair, direction, mode, timeframe, entry, stop_loss, take_profit_1, " +
  "take_profit_2, atr, confluence, contributing_strategies, rationale, created_at, archived_at, " +
  "engine_version, policy_version, execution_policy_version, generated_by, scan_fingerprint, " +
  "paper_trades(state, entry_price, entry_time, tp1_armed_at, exit_price, exit_time, result_r, " +
  "mae_r, mfe_r, bars_held, ambiguous_intrabar, expires_at), " +
  "market_snapshots!signals_market_snapshot_id_fkey(provider, instrument, provider_time), " +
  "scan_runs(engine_accounting)";

// Autopsy detail: the list view plus the trade's full event ledger. PostgREST
// nests the embed under the already-pinned paper_trades embed.
const SIGNAL_DETAIL_SELECT =
  SIGNAL_VIEW_SELECT +
  ", paper_trades.paper_trade_events(id, sequence_no, event_key, event_type, " +
  "provider_timestamp, worker_timestamp, before_state, after_state, evidence)";

const OUTCOME_SELECT =
  "id, pair, direction, mode, timeframe, confluence, contributing_strategies, " +
  "created_at, archived_at, execution_policy_version, generated_by, paper_trades(state)";

const ACCOUNT_SELECT =
  "id, direction, entry, stop_loss, created_at, " +
  "paper_trades(state, entry_price, exit_time, result_r)";

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

/**
 * Autopsy detail for one canonical signal: the list item plus the trade's
 * full event ledger. Scoped to the caller's own rows (RLS + explicit user
 * filter). Returns `{ detail: null }` for a foreign or missing signal rather
 * than leaking existence.
 */
export const getXauusdPaperSignalDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ signalId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase
      .from("signals")
      .select(SIGNAL_DETAIL_SELECT)
      .eq("id", data.signalId)
      .eq("user_id", userId)
      .eq("generated_by", "xauusd_paper_worker")
      .maybeSingle();
    if (error) {
      if (isMissingSchemaError(error)) throw new Error("migration_required");
      throw new Error(error.message);
    }
    if (!row) return { detail: null };
    return { detail: mapPaperSignalDetail(row as unknown as PaperSignalDetailRow) };
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

export const getXauusdPaperAccount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // No archive filter: realized P&L must include closed trades the archive
    // job has already soft-archived (30-day window). Returns lean rows only —
    // the client folds them into the account summary with its live mid.
    const { data, error } = await supabase
      .from("signals")
      .select(ACCOUNT_SELECT)
      .eq("user_id", userId)
      .eq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) {
      if (isMissingSchemaError(error)) throw new Error("migration_required");
      throw new Error(error.message);
    }
    return (data ?? []) as unknown as PaperAccountRow[];
  });

const STRATEGY_HEALTH_SELECT =
  "id, mode, timeframe, contributing_strategies, created_at, " +
  "paper_trades(state, result_r, mae_r, mfe_r, bars_held, ambiguous_intrabar, entry_time, exit_time)";

/**
 * Per-strategy scorecard over the caller's canonical paper ledger: wins,
 * scratches (BE after TP1), losses, total R, win rate and expectancy per
 * contributing strategy, with the 20-resolved-trade sample floor flagged.
 * This is the forward-tested record the league's walk-forward view cannot
 * see (it excludes canonical rows) — the two are complementary.
 */
export const getXauusdPaperStrategyHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("signals")
      .select(STRATEGY_HEALTH_SELECT)
      .eq("user_id", userId)
      .eq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) {
      if (isMissingSchemaError(error)) throw new Error("migration_required");
      throw new Error(error.message);
    }
    return summarizePaperStrategyHealth((data ?? []) as unknown as PaperStrategyHealthRow[]);
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
    const report = mapPaperShadowLearningReport((data ?? []) as unknown as PaperLearningOutcomeRow[]);
    const { data: promoRows, error: promoError } = await supabase
      .from("strategy_promotions")
      .select("strategy_id, mode, action, multiplier, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
    if (promoError) {
      if (isMissingSchemaError(promoError)) throw new Error("migration_required");
      throw new Error(promoError.message);
    }
    return {
      ...report,
      promotions: activeMultipliers((promoRows ?? []) as unknown as PromotionLedgerRow[]),
    } satisfies PaperShadowLearningReport;
  });

const PromotionInput = z.object({
  strategyId: z.string().min(3).max(60),
  mode: z.enum(["intraday", "scalper"]),
  action: z.enum(["approve", "revert"]),
});

/**
 * Promote (or revert) a learning candidate multiplier onto the LIVE weights.
 * Approval re-derives the candidate from the canonical ledger exactly like
 * the shadow report, then enforces the gates server-side — minimum resolved
 * samples, boost/cool verdict, and walk-forward validation on live candles —
 * before writing the strategy_promotions ledger row the worker scans with.
 * A revert always succeeds (it only clears the active multiplier).
 */
export const promoteStrategyMultiplier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => PromotionInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rows, error } = await supabase
      .from("signals")
      .select(OUTCOME_SELECT)
      .eq("user_id", userId)
      .eq("generated_by", "xauusd_paper_worker")
      .eq("execution_policy_version", "b_single_v1")
      .eq("mode", data.mode)
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) {
      if (isMissingSchemaError(error)) throw new Error("migration_required");
      throw new Error(error.message);
    }
    const outcomes = canonicalOutcomes((rows ?? []) as unknown as PaperLearningOutcomeRow[]);
    const learned = computeStrategyLearning(outcomes, data.mode).get(data.strategyId) ?? null;

    if (data.action === "revert") {
      const { error: insertError } = await supabase.from("strategy_promotions").insert({
        user_id: userId,
        strategy_id: data.strategyId,
        mode: data.mode,
        action: "revert",
        multiplier: 1,
        resolved_samples: learned?.resolved ?? 0,
        wins: learned?.wins ?? 0,
        losses: learned?.losses ?? 0,
        total_r: learned?.totalR ?? 0,
        verdict: "n/a",
      });
      if (insertError) throw new Error(insertError.message);
      return { ok: true, action: "revert", strategyId: data.strategyId, mode: data.mode, multiplier: 1 };
    }

    // Approve: gates are recomputed here, not trusted from the client.
    const timeframe: "M15" | "H1" = data.mode === "scalper" ? "M15" : "H1";
    const marketCandles = await fetchMarketCandles("XAUUSD", timeframe, 220);
    const candles = marketCandles.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      complete: c.complete,
      volume: c.volume,
    }));
    const { weights, report } = computeStrategyWeights(candles, timeframe, data.mode);
    const walkWeight = weights[data.strategyId] ?? null;
    const walkEntry = report.entries.find((entry) => entry.strategyId === data.strategyId);
    const gate = evaluatePromotionGate({ learned, walkWeight });
    if (!gate.ok || gate.multiplier == null) {
      throw new Error(`promotion_gate: ${gate.reasons.join(" | ")}`);
    }
    if (!learned) throw new Error("promotion_gate: NO_LEARNING_RECORD");
    const { error: insertError } = await supabase.from("strategy_promotions").insert({
      user_id: userId,
      strategy_id: data.strategyId,
      mode: data.mode,
      action: "approve",
      multiplier: gate.multiplier,
      resolved_samples: learned.resolved,
      wins: learned.wins,
      losses: learned.losses,
      total_r: learned.totalR,
      verdict: learned.verdict,
      walk_weight: walkWeight ?? null,
      walk_accuracy: walkEntry?.accuracy ?? null,
    });
    if (insertError) throw new Error(insertError.message);
    return {
      ok: true,
      action: "approve",
      strategyId: data.strategyId,
      mode: data.mode,
      multiplier: gate.multiplier,
    };
  });
