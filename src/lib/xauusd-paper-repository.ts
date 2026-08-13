// Service-role repository adapter for the XAUUSD auto-paper worker.
//
// All canonical WRITES go through the atomic SECURITY DEFINER RPCs in
// 20260811010200_xauusd_paper_worker_rpcs.sql. This adapter never issues a
// direct `.from("signals").insert/update/delete` or
// `.from("paper_trades").insert/update/delete` — that guarantee is what makes
// the worker's write path auditable and idempotent. Reads (profiles,
// settings, live trades) use the table API with the service-role client,
// which bypasses RLS by design.

import type { SupabaseClient } from "@supabase/supabase-js";
// Relative (not `@/`) so the same module also resolves inside the Deno Edge
// runtime where the Vite `@/` alias does not exist.
import type { Database, Json } from "../integrations/supabase/types";
import type { PaperTimeframe } from "./xauusd-market-data.ts";
import type { NativeXauusdQuote, TwoSidedCandle } from "./xauusd-market-data.ts";
import type { PaperTrade, PaperTradeState } from "./paper-trade-state.ts";
import {
  activeMultipliers,
  type ActiveMultiplier,
  type PromotionLedgerRow,
} from "./strategy-promotion.ts";

export type PaperProfile = {
  userId: string;
  enabled: true;
  activatedAt: string;
  symbol: "XAUUSD";
  lotSize: 0.01;
};

export type ScanClaim = {
  scanFingerprint: string;
  userId: string;
  timeframe: PaperTimeframe;
  candleClosedAt: string;
  scanMode: "intraday" | "scalper";
  engineVersion: string;
  policyVersion: string;
};

export type CommitPaperSignal = {
  scanRunId: string;
  userId: string;
  scanFingerprint: string;
  snapshots: {
    quote: NativeXauusdQuote;
    timeframe: PaperTimeframe;
    candleClosedAt: string;
    candles: TwoSidedCandle[];
    contentHash: string;
    qualityResult: Record<string, unknown>;
    role: "entry" | "mtf_direction";
  }[];
  signal: {
    mode: "intraday" | "scalper";
    timeframe: PaperTimeframe;
    direction: "long" | "short";
    entry: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    atr: number;
    confluence: number;
    contributingStrategies: string[];
    rationale: string;
    diagnostics: Record<string, unknown>;
    expiresAt: string;
    engineVersion: string;
    policyVersion: string;
    // Engine accounting stored on the completed scan run so the UI can show
    // exactly which strategies were evaluated / abstained / excluded / failed.
    accounting: {
      evaluated: string[];
      abstained: string[];
      incompatible: string[];
      excluded: string[];
      failed: { strategyId: string; code: string }[];
    };
  };
};

export type FailScan = {
  scanRunId: string;
  code: string;
  detail: string;
  engineAccounting?: Record<string, unknown>;
  status?: "failed" | "degraded";
};

export type PaperTransitionWrite = {
  tradeId: string;
  expectedState: PaperTradeState;
  expectedVersion: number;
  next: PaperTrade;
  event: {
    eventKey: string;
    type: string;
    providerTimestamp: string | null;
    evidence: Record<string, number | string | boolean | null>;
  };
};

export interface PaperWorkerRepository {
  recordWorkerHealth(input: {
    ok: boolean;
    code: string;
    checkedAt: string;
    providerTime: string | null;
    quoteAgeMs: number | null;
    spread: number | null;
  }): Promise<void>;
  listEnabledProfiles(): Promise<PaperProfile[]>;
  listEnabledStrategyIds(userId: string): Promise<string[]>;
  /**
   * Active promotion multipliers from the strategy_promotions ledger
   * (latest row per strategy+mode wins; a revert clears its approve).
   * Empty when nothing has been promoted.
   */
  listActiveMultipliers(userId: string): Promise<ActiveMultiplier[]>;
  claimScan(input: ScanClaim): Promise<{ scanRunId: string; claimed: boolean }>;
  commitSignal(input: CommitPaperSignal): Promise<{
    signalId: string;
    tradeId: string;
    created: boolean;
  }>;
  failScan(input: FailScan): Promise<void>;
  listLiveTrades(userId: string): Promise<PaperTrade[]>;
  applyTransition(input: PaperTransitionWrite): Promise<boolean>;
}

function toPaperTrade(row: Database["public"]["Tables"]["paper_trades"]["Row"]): PaperTrade {
  return {
    id: row.id,
    signalId: row.signal_id,
    userId: row.user_id,
    symbol: "XAUUSD",
    lotSize: 0.01,
    executionPolicyVersion: row.execution_policy_version as "b_single_v1",
    instrumentSpecVersion: row.instrument_spec_version as "xauusd_0_01_lot_v1",
    direction: row.direction,
    timeframe: row.timeframe as PaperTimeframe,
    state: row.state,
    stateVersion: row.state_version,
    plannedEntry: Number(row.planned_entry),
    stopLoss: Number(row.stop_loss),
    takeProfit1: Number(row.take_profit_1),
    takeProfit2: Number(row.take_profit_2),
    expiresAt: row.expires_at,
    entryPrice: row.entry_price === null ? null : Number(row.entry_price),
    entryTime: row.entry_time,
    exitPrice: row.exit_price === null ? null : Number(row.exit_price),
    exitTime: row.exit_time,
    tp1ArmedAt: row.tp1_armed_at,
    lastObservedAt: row.last_observed_at,
    resultR: row.result_r === null ? null : Number(row.result_r),
    maeR: row.mae_r === null ? 0 : Number(row.mae_r),
    mfeR: row.mfe_r === null ? 0 : Number(row.mfe_r),
    barsHeld: row.bars_held,
    ambiguousIntrabar: row.ambiguous_intrabar,
    createdAt: row.created_at,
  };
}

export function createSupabasePaperRepository(
  client: SupabaseClient<Database>,
): PaperWorkerRepository {
  return {
    async recordWorkerHealth(input) {
      const { error } = await client.rpc("worker_record_xauusd_health", {
        p_ok: input.ok,
        p_code: input.code,
        p_checked_at: input.checkedAt,
        p_provider: "TV_OANDA_FEED",
        p_instrument: "XAU_USD",
        p_quote_provider_time: input.providerTime,
        p_quote_age_ms: input.quoteAgeMs,
        p_spread: input.spread,
        p_detail: {},
      });
      if (error) throw error;
    },

    async listEnabledProfiles() {
      const { data, error } = await client
        .from("paper_trading_profiles")
        .select("*")
        .eq("enabled", true);
      if (error) throw error;
      return (data ?? []).map((row) => ({
        userId: row.user_id,
        enabled: true as const,
        activatedAt: row.activated_at ?? new Date(0).toISOString(),
        symbol: "XAUUSD" as const,
        lotSize: 0.01 as const,
      }));
    },

    async listEnabledStrategyIds(userId) {
      const { data, error } = await client
        .from("strategy_settings")
        .select("strategy_id")
        .eq("user_id", userId)
        .eq("enabled", true);
      if (error) throw error;
      return (data ?? []).map((row) => row.strategy_id);
    },

    async listActiveMultipliers(userId) {
      const { data, error } = await client
        .from("strategy_promotions")
        .select("strategy_id, mode, action, multiplier, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return activeMultipliers((data ?? []) as unknown as PromotionLedgerRow[]);
    },

    async claimScan(input) {
      const { data, error } = await client.rpc("worker_claim_xauusd_scan", {
        p_user_id: input.userId,
        p_scan_fingerprint: input.scanFingerprint,
        p_symbol: "XAUUSD",
        p_timeframe: input.timeframe,
        p_candle_closed_at: input.candleClosedAt,
        p_scan_mode: input.scanMode,
        p_engine_version: input.engineVersion,
        p_policy_version: input.policyVersion,
        p_lease_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      if (error) throw error;
      const row = data?.[0];
      if (!row) throw new Error("claim returned no scan run");
      return { scanRunId: row.scan_run_id, claimed: row.claimed };
    },

    async commitSignal(input) {
      const snapshots = input.snapshots.map((s) => ({
        content_hash: s.contentHash,
        role: s.role,
        provider: s.quote.provider,
        instrument: s.quote.instrument,
        timeframe: s.timeframe,
        candle_closed_at: s.candleClosedAt,
        bid: s.quote.bid,
        ask: s.quote.ask,
        provider_time: s.quote.providerTime,
        received_at: s.quote.receivedAt,
        candles: s.candles,
        quality_result: s.qualityResult,
      }));
      const signal = {
        mode: input.signal.mode,
        timeframe: input.signal.timeframe,
        direction: input.signal.direction,
        entry: input.signal.entry,
        stop_loss: input.signal.stopLoss,
        take_profit_1: input.signal.takeProfit1,
        take_profit_2: input.signal.takeProfit2,
        atr: input.signal.atr,
        confluence: input.signal.confluence,
        contributing_strategies: input.signal.contributingStrategies,
        rationale: input.signal.rationale,
        diagnostics: input.signal.diagnostics,
        expires_at: input.signal.expiresAt,
      };
      const { data, error } = await client.rpc("worker_commit_xauusd_scan", {
        p_scan_run_id: input.scanRunId,
        p_user_id: input.userId,
        p_scan_fingerprint: input.scanFingerprint,
        // Diagnostics are engine-produced JSON; the Record<string, unknown>
        // input type is widened deliberately, so narrow it at the boundary.
        p_snapshots: snapshots as unknown as Json,
        p_signal: signal as unknown as Json,
        p_trade: { expires_at: input.signal.expiresAt } as unknown as Json,
        p_engine_version: input.signal.engineVersion,
        p_policy_version: input.signal.policyVersion,
        p_execution_policy_version: "b_single_v1",
        p_instrument_spec_version: "xauusd_0_01_lot_v1",
        p_quality_result: input.signal.diagnostics as unknown as Json,
        p_engine_accounting: input.signal.accounting as unknown as Json,
      });
      if (error) throw error;
      const row = data?.[0];
      if (!row) throw new Error("commit returned no signal");
      return {
        signalId: row.signal_id,
        tradeId: row.paper_trade_id,
        created: row.created,
      };
    },

    async failScan(input) {
      const { error } = await client.rpc("worker_fail_xauusd_scan", {
        p_scan_run_id: input.scanRunId,
        p_status: input.status ?? "failed",
        p_code: input.code,
        p_detail: input.detail,
        p_engine_accounting: (input.engineAccounting ?? {}) as unknown as Json,
      });
      if (error) throw error;
    },

    async listLiveTrades(userId) {
      const { data, error } = await client
        .from("paper_trades")
        .select("*")
        .eq("user_id", userId)
        .in("state", ["waiting_entry", "open", "tp1_protected"]);
      if (error) throw error;
      return (data ?? []).map(toPaperTrade);
    },

    async applyTransition(input) {
      const { data, error } = await client.rpc("worker_apply_paper_transition", {
        p_trade_id: input.tradeId,
        p_expected_state: input.expectedState,
        p_expected_version: input.expectedVersion,
        p_next_state: input.next.state,
        p_next_version: input.next.stateVersion,
        p_event_key: input.event.eventKey,
        p_event_type: input.event.type,
        p_provider_timestamp: input.event.providerTimestamp,
        p_before_state: input.expectedState,
        p_after_state: input.next.state,
        p_entry_price: input.next.entryPrice,
        p_entry_time: input.next.entryTime,
        p_exit_price: input.next.exitPrice,
        p_exit_time: input.next.exitTime,
        p_tp1_armed_at: input.next.tp1ArmedAt,
        p_last_observed_at: input.next.lastObservedAt,
        p_result_r: input.next.resultR,
        p_mae_r: input.next.maeR,
        p_mfe_r: input.next.mfeR,
        p_bars_held: input.next.barsHeld,
        p_ambiguous_intrabar: input.next.ambiguousIntrabar,
        p_evidence: input.event.evidence,
      });
      if (error) throw error;
      return data === true;
    },
  };
}
