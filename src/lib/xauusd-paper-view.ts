// Canonical XAUUSD paper view model (Task 9).
//
// Pure mappers that turn canonical worker rows into the DTOs the UI consumes:
// full PHT timestamps, PAPER ONLY branding, the B-single trade state, provider
// provenance, and shadow-learning candidates derived through the existing
// deterministic learning math. No I/O, no auth — the authenticated functions
// in xauusd-paper.functions.ts query rows and hand them to these mappers.
//
// Invalid canonical rows throw PaperViewMappingError and are never shown as
// valid: a canonical row that lost its trade, its snapshot, or carries a
// non-finite price is forged or truncated and must fail closed.

import { formatPhtTimestamp, utcIsoTitle } from "./pht-time.ts";
import { computeStrategyLearning, type ResolvedSignalForLearning } from "./signal-learning.ts";
import { PAPER_LOT_SIZE, type PaperTradeState } from "./paper-trade-state.ts";
import { PAPER_TIMEFRAMES, type PaperTimeframe } from "./xauusd-market-data.ts";
import { computePaperPosition } from "./xauusd-paper-pnl.ts";

export class PaperViewMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperViewMappingError";
  }
}

/** Engine accounting stored on the completed scan run (jsonb). */
export type PaperEngineAccounting = {
  evaluated: string[];
  abstained: string[];
  incompatible: string[];
  excluded: string[];
  failed: { strategyId: string; code: string }[];
};

export const PAPER_ONLY_LABEL = "PAPER ONLY · 0.01 LOT · NO BROKER CONNECTION" as const;
export const PAPER_PROVIDER = "TV_OANDA_FEED" as const;
export const PAPER_INSTRUMENT = "XAU_USD" as const;

export type PaperTradeJoin =
  | {
      state: string;
      entry_price: number | string | null;
      entry_time?: string | null;
      tp1_armed_at?: string | null;
      exit_price: number | string | null;
      exit_time?: string | null;
      result_r: number | string | null;
    }
  | {
      state: string;
      entry_price: number | string | null;
      entry_time?: string | null;
      tp1_armed_at?: string | null;
      exit_price: number | string | null;
      exit_time?: string | null;
      result_r: number | string | null;
    }[]
  | null;

/** Raw row shape the authenticated functions produce for a canonical signal. */
export type PaperSignalJoinRow = {
  id: string;
  pair: string;
  direction: string;
  mode: string;
  timeframe: string;
  entry: number | string;
  stop_loss: number | string;
  take_profit_1: number | string;
  take_profit_2: number | string;
  atr: number | string;
  confluence: number | string;
  contributing_strategies: string[];
  rationale: string | null;
  created_at: string;
  archived_at: string | null;
  engine_version: string | null;
  policy_version: string | null;
  execution_policy_version: string | null;
  generated_by: string;
  scan_fingerprint: string | null;
  paper_trades?: PaperTradeJoin;
  market_snapshots?: {
    provider: string;
    instrument: string;
    provider_time: string | null;
  } | null;
  scan_runs?: { engine_accounting: unknown } | null;
};

export type PaperSignalListItem = {
  id: string;
  pair: "XAUUSD";
  direction: "long" | "short";
  mode: "intraday" | "scalper";
  timeframe: PaperTimeframe;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  atr: number;
  confluence: number;
  contributingStrategies: string[];
  rationale: string | null;
  lotSize: 0.01;
  paperOnly: true;
  paperLabel: typeof PAPER_ONLY_LABEL;
  timestampPht: string;
  timestampUtc: string;
  archived: boolean;
  trade: {
    state: PaperTradeState;
    entryPrice: number | null;
    entryTime: string | null;
    tp1ArmedAt: string | null;
    exitPrice: number | null;
    exitTime: string | null;
    resultR: number | null;
  };
  provider: {
    name: typeof PAPER_PROVIDER;
    instrument: typeof PAPER_INSTRUMENT;
    providerTime: string;
  };
  engine: { version: string; policyVersion: string; accounting: PaperEngineAccounting };
};

function toFinite(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new PaperViewMappingError(`non-finite ${field} on canonical row`);
  }
  return parsed;
}

function toNullableFinite(value: number | string | null | undefined, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new PaperViewMappingError(`non-finite ${field} on canonical row`);
  }
  return parsed;
}

type SingleTradeJoin = Exclude<PaperTradeJoin, null | object[]>;

function firstTrade(join: PaperTradeJoin | undefined): SingleTradeJoin | null {
  if (!join) return null;
  return Array.isArray(join) ? (join[0] ?? null) : join;
}

function isPaperTimeframe(value: string): value is PaperTimeframe {
  return (PAPER_TIMEFRAMES as readonly string[]).includes(value);
}

const EMPTY_ACCOUNTING: PaperEngineAccounting = {
  evaluated: [],
  abstained: [],
  incompatible: [],
  excluded: [],
  failed: [],
};

function parseAccounting(raw: unknown): PaperEngineAccounting {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_ACCOUNTING;
  const obj = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  const failed = Array.isArray(obj.failed)
    ? obj.failed
        .filter(
          (entry): entry is { strategyId: string; code: string } =>
            !!entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            typeof (entry as Record<string, unknown>).strategyId === "string" &&
            typeof (entry as Record<string, unknown>).code === "string",
        )
        .map((entry) => ({
          strategyId: entry.strategyId as string,
          code: entry.code as string,
        }))
    : [];
  return {
    evaluated: strings(obj.evaluated),
    abstained: strings(obj.abstained),
    incompatible: strings(obj.incompatible),
    excluded: strings(obj.excluded),
    failed,
  };
}

export function mapPaperSignalListItem(row: PaperSignalJoinRow): PaperSignalListItem {
  if (row.pair !== "XAUUSD") {
    throw new PaperViewMappingError(`non-XAUUSD canonical row ${row.id}`);
  }
  if (row.direction !== "long" && row.direction !== "short") {
    throw new PaperViewMappingError(`invalid direction on canonical row ${row.id}`);
  }
  if (row.mode !== "intraday" && row.mode !== "scalper") {
    throw new PaperViewMappingError(`invalid mode on canonical row ${row.id}`);
  }
  if (!isPaperTimeframe(row.timeframe)) {
    throw new PaperViewMappingError(`invalid timeframe on canonical row ${row.id}`);
  }
  if (row.generated_by !== "xauusd_paper_worker" || !row.scan_fingerprint) {
    throw new PaperViewMappingError(`non-canonical row ${row.id} cannot be mapped as paper`);
  }
  const trade = firstTrade(row.paper_trades);
  if (!trade) {
    throw new PaperViewMappingError(`canonical row ${row.id} has no paper trade`);
  }
  const snapshot = row.market_snapshots;
  if (!snapshot || !snapshot.provider_time) {
    throw new PaperViewMappingError(`canonical row ${row.id} has no provider snapshot`);
  }
  if (snapshot.provider !== PAPER_PROVIDER || snapshot.instrument !== PAPER_INSTRUMENT) {
    throw new PaperViewMappingError(`canonical row ${row.id} has mismatched provider identity`);
  }

  return {
    id: row.id,
    pair: "XAUUSD",
    direction: row.direction,
    mode: row.mode,
    timeframe: row.timeframe as PaperTimeframe,
    entry: toFinite(row.entry, "entry"),
    stopLoss: toFinite(row.stop_loss, "stop_loss"),
    takeProfit1: toFinite(row.take_profit_1, "take_profit_1"),
    takeProfit2: toFinite(row.take_profit_2, "take_profit_2"),
    atr: toFinite(row.atr, "atr"),
    confluence: toFinite(row.confluence, "confluence"),
    contributingStrategies: row.contributing_strategies,
    rationale: row.rationale ?? null,
    lotSize: PAPER_LOT_SIZE,
    paperOnly: true,
    paperLabel: PAPER_ONLY_LABEL,
    timestampPht: formatPhtTimestamp(row.created_at),
    timestampUtc: utcIsoTitle(row.created_at),
    archived: row.archived_at !== null,
    trade: {
      state: trade.state as PaperTradeState,
      entryPrice: toNullableFinite(trade.entry_price, "entry_price"),
      entryTime: "entry_time" in trade ? (trade.entry_time ?? null) : null,
      tp1ArmedAt: "tp1_armed_at" in trade ? (trade.tp1_armed_at ?? null) : null,
      exitPrice: toNullableFinite(trade.exit_price, "exit_price"),
      exitTime: "exit_time" in trade ? (trade.exit_time ?? null) : null,
      resultR: toNullableFinite(trade.result_r, "result_r"),
    },
    provider: {
      name: PAPER_PROVIDER,
      instrument: PAPER_INSTRUMENT,
      providerTime: snapshot.provider_time,
    },
    engine: {
      version: row.engine_version ?? "",
      policyVersion: row.policy_version ?? "",
      accounting: parseAccounting(row.scan_runs?.engine_accounting),
    },
  };
}

// ---------------------------------------------------------------------------
// Shadow learning + performance (canonical terminal outcomes only)
// ---------------------------------------------------------------------------

/** Canonical signal joined with its paper trade — terminal states drive learning. */
export type PaperLearningOutcomeRow = {
  id: string;
  pair: string;
  direction: string;
  mode: string;
  timeframe: string;
  confluence: number | string;
  contributing_strategies: string[];
  created_at: string;
  archived_at: string | null;
  execution_policy_version: string | null;
  generated_by: string;
  paper_trades?: { state: string } | { state: string }[] | null;
};

/** Terminal paper-trade states map onto the learning statuses of the resolved record. */
const TERMINAL_STATE_TO_STATUS: Record<string, string> = {
  closed_tp2: "hit_tp2", // +2R win
  closed_breakeven: "hit_tp1", // 0R scratch (B-single breakeven)
  closed_stop: "hit_sl", // -1R loss
  expired: "invalidated", // stale, never touched a level
};

export type PaperShadowLearningCandidate = {
  strategyId: string;
  mode: "intraday" | "scalper";
  resolved: number;
  wins: number;
  scratches: number;
  losses: number;
  totalR: number;
  candidateMultiplier: number;
  verdict: "boost" | "cool" | "hold" | "insufficient";
};

export type PaperShadowLearningReport = {
  executionPolicyVersion: "b_single_v1";
  applied: false;
  sampleSize: number;
  candidates: PaperShadowLearningCandidate[];
};

function canonicalOutcomes(rows: PaperLearningOutcomeRow[]): ResolvedSignalForLearning[] {
  const outcomes: ResolvedSignalForLearning[] = [];
  for (const row of rows) {
    // Only canonical rows under the CURRENT execution policy enter learning.
    if (row.generated_by !== "xauusd_paper_worker") continue;
    if (row.execution_policy_version !== "b_single_v1") continue;
    const trade = Array.isArray(row.paper_trades) ? row.paper_trades[0] : row.paper_trades;
    if (!trade) continue;
    const status = TERMINAL_STATE_TO_STATUS[trade.state];
    if (!status) continue; // not terminal (waiting_entry / open / tp1_protected)
    outcomes.push({
      id: row.id,
      pair: row.pair,
      direction: row.direction === "short" ? "short" : "long",
      mode: row.mode,
      timeframe: row.timeframe,
      confluence: toFinite(row.confluence, "confluence"),
      contributing_strategies: row.contributing_strategies,
      status,
      created_at: row.created_at,
    });
  }
  return outcomes;
}

export function mapPaperShadowLearningReport(
  rows: PaperLearningOutcomeRow[],
): PaperShadowLearningReport {
  const outcomes = canonicalOutcomes(rows);
  const candidates: PaperShadowLearningCandidate[] = [];
  for (const mode of ["intraday", "scalper"] as const) {
    for (const learned of computeStrategyLearning(outcomes, mode).values()) {
      candidates.push({
        strategyId: learned.strategyId,
        mode,
        resolved: learned.resolved,
        wins: learned.wins,
        // B-single scratch: resolved denominator, neither win nor loss.
        scratches: learned.resolved - learned.wins - learned.losses,
        losses: learned.losses,
        totalR: learned.totalR,
        candidateMultiplier: learned.multiplier,
        verdict: learned.verdict,
      });
    }
  }
  candidates.sort((a, b) =>
    a.mode === b.mode ? b.totalR - a.totalR : a.mode.localeCompare(b.mode),
  );
  return {
    executionPolicyVersion: "b_single_v1",
    applied: false,
    sampleSize: outcomes.length,
    candidates,
  };
}

export type PaperPerformanceReport = {
  resolved: number; // wins + scratches + losses
  wins: number;
  scratches: number;
  losses: number;
  stale: number; // expired without touching a level
  totalR: number;
  winRate: number; // wins / resolved, 0..1
};

export function summarizePaperPerformance(rows: PaperLearningOutcomeRow[]): PaperPerformanceReport {
  const report: PaperPerformanceReport = {
    resolved: 0,
    wins: 0,
    scratches: 0,
    losses: 0,
    stale: 0,
    totalR: 0,
    winRate: 0,
  };
  for (const outcome of canonicalOutcomes(rows)) {
    if (outcome.status === "hit_tp2") {
      report.resolved += 1;
      report.wins += 1;
      report.totalR += 2;
    } else if (outcome.status === "hit_tp1") {
      report.resolved += 1;
      report.scratches += 1;
    } else if (outcome.status === "hit_sl") {
      report.resolved += 1;
      report.losses += 1;
      report.totalR -= 1;
    } else {
      report.stale += 1;
    }
  }
  report.winRate = report.resolved > 0 ? report.wins / report.resolved : 0;
  return report;
}

// ---------------------------------------------------------------------------
// Account summary (canonical paper ledger, $ denominated)
// ---------------------------------------------------------------------------

/** Starting balance of the imaginary paper account. Fixed, not inferred — the
 *  owner runs a ~$200 balance at a fixed 0.01 lot (see HANDOFF §1). */
export const PAPER_STARTING_BALANCE_USD = 200 as const;

/** Lean row shape the account query produces — only what a $ ledger needs. */
export type PaperAccountRow = {
  id: string;
  direction: string;
  entry: number | string;
  stop_loss: number | string;
  created_at: string;
  paper_trades?: PaperTradeJoin;
};

export type PaperAccountSummary = {
  startingBalanceUsd: number;
  /** Balance = starting + realized. Changes only when a trade closes. */
  balanceUsd: number;
  /** Sum of open-trade floating P&L at the given mid (0 while the feed is down). */
  floatingUsd: number;
  /** Equity = balance + floating. */
  equityUsd: number;
  /** Cumulative $ booked by terminal trades (TP2 +2R, SL −1R, BE 0R). */
  realizedUsd: number;
  /** Live positions: waiting_entry + open + tp1_protected. */
  openCount: number;
  /** Terminal closed trades (TP2/SL/BE). Expired trades never entered. */
  resolvedCount: number;
  /** Peak-to-trough drawdown of the realized-equity curve. A lower bound —
   *  open-trade floating history is not stored, so true drawdown is ≥ this. */
  maxDrawdownUsd: number;
};

const ACCOUNT_POSITION_STATES: Record<string, true> = { open: true, tp1_protected: true };
const ACCOUNT_LIVE_STATES: Record<string, true> = {
  waiting_entry: true,
  open: true,
  tp1_protected: true,
};
const ACCOUNT_TERMINAL_STATES: Record<string, true> = {
  closed_tp2: true,
  closed_breakeven: true,
  closed_stop: true,
};

export function summarizePaperAccount(
  rows: PaperAccountRow[],
  mid: number | null,
): PaperAccountSummary {
  let realizedUsd = 0;
  let floatingUsd = 0;
  let openCount = 0;
  let resolvedCount = 0;
  // Realized $ per trade = result_r × risk$, where risk$ = |entry − stop| ×
  // lot × 100. XAUUSD 0.01 lot = 1 oz, so the ×100 collapses to $1/point and
  // risk$ is just the entry→stop distance in dollars.
  const closed: { at: number; realizedUsd: number }[] = [];

  for (const row of rows) {
    const direction = row.direction === "short" ? "short" : "long";
    const entry = toFinite(row.entry, "entry");
    const stopLoss = toFinite(row.stop_loss, "stop_loss");
    const trade = firstTrade(row.paper_trades);
    if (!trade) continue;

    if (ACCOUNT_LIVE_STATES[trade.state]) {
      openCount += 1;
      if (ACCOUNT_POSITION_STATES[trade.state]) {
        const actualEntry = toNullableFinite(trade.entry_price, "entry_price") ?? entry;
        if (mid != null && Number.isFinite(mid)) {
          floatingUsd +=
            computePaperPosition({
              direction,
              entry: actualEntry,
              stopLoss,
              lotSize: PAPER_LOT_SIZE,
              current: mid,
            })?.usd ?? 0;
        }
      }
    } else if (ACCOUNT_TERMINAL_STATES[trade.state]) {
      resolvedCount += 1;
      const resultR = toNullableFinite(trade.result_r, "result_r") ?? 0;
      const riskUsd = Math.abs(entry - stopLoss) * PAPER_LOT_SIZE * 100;
      const realized = resultR * riskUsd;
      realizedUsd += realized;
      const at = trade.exit_time ? Date.parse(trade.exit_time) : Date.parse(row.created_at);
      if (Number.isFinite(at)) closed.push({ at, realizedUsd: realized });
    }
    // expired: never entered, contributes nothing to the ledger.
  }

  closed.sort((a, b) => a.at - b.at);
  let equity: number = PAPER_STARTING_BALANCE_USD;
  let peak: number = equity;
  let maxDrawdownUsd = 0;
  for (const c of closed) {
    equity += c.realizedUsd;
    if (equity > peak) peak = equity;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  }

  const balanceUsd = PAPER_STARTING_BALANCE_USD + realizedUsd;
  return {
    startingBalanceUsd: PAPER_STARTING_BALANCE_USD,
    balanceUsd,
    floatingUsd,
    equityUsd: balanceUsd + floatingUsd,
    realizedUsd,
    openCount,
    resolvedCount,
    maxDrawdownUsd,
  };
}
