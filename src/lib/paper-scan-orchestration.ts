// Strategy-accounting boundary for the auto-paper worker.
//
// One scan per newly completed timeframe, every enabled engine accounted as
// evaluated / abstained / incompatible / excluded / failed — an engine must
// never disappear silently from a scan report. The catalog is cross-checked
// against the engine registry first: drift refuses to produce canonical
// signals. Walk-forward trust weights are computed on the entry timeframe and
// shared with the higher-timeframe tide (the same convention the live scanner
// uses), and existing self-learning multipliers are NEVER applied to this
// canonical cohort — new learning stays shadow-only.

import {
  scanCandlesForSignal,
  getEngineStrategyCapability,
  type SignalEngineCandle,
  type SignalEngineQuote,
} from "./signal-engine.ts";
import { computeStrategyWeights } from "./strategy-weights.ts";
import { computeMtfAgreement, MTF_PLANS, type MtfAgreement } from "./mtf-engine.ts";
import { ALL_ENGINE_STRATEGY_IDS } from "./strategy-weights.ts";
import {
  toMidCandles,
  type NativeXauusdQuote,
  type PaperTimeframe,
  type TwoSidedCandle,
} from "./xauusd-market-data.ts";

const SCALP_TIMEFRAMES: PaperTimeframe[] = ["M1", "M5", "M15", "M30"];

/** Signal validity minutes per timeframe — the exact contract for expires_at. */
export const VALIDITY_MINUTES: Record<PaperTimeframe, number> = {
  M1: 10,
  M5: 15,
  M15: 30,
  M30: 60,
  H1: 90,
  H4: 240,
  D1: 1440,
};

/** Engines that need a canonical macro provider, which is not yet approved. */
const MACRO_DEPENDENT_STRATEGIES = new Set(["news_reactive", "ai_confluence"]);

export type StrategyAccounting = {
  evaluated: string[];
  abstained: string[];
  incompatible: string[];
  excluded: string[];
  failed: { strategyId: string; code: string }[];
};

export type PaperSignalCandidate = {
  mode: "intraday" | "scalper";
  timeframe: PaperTimeframe;
  candleClosedAt: string;
  direction: "long" | "short";
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  atr: number;
  confluence: number;
  contributingStrategies: string[];
  rationale: string;
  expiresAt: string;
  engineVersion: string;
  policyVersion: string;
  accounting: StrategyAccounting;
  mtf: MtfAgreement | null;
  snapshotRoles: { timeframe: PaperTimeframe; role: "entry" | "mtf_direction" }[];
};

export class PaperScanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PaperScanError";
    this.code = code;
  }
}

/**
 * Resolve the enabled paper strategy set. The DATABASE catalog must match the
 * engine registry exactly (any missing or unknown id is `strategy_catalog_drift`
 * and blocks canonical signals); with a matching catalog, registry order is
 * returned filtered only by explicit `enabled=false` settings. Activation
 * creates missing settings as enabled, so silence never means disabled.
 */
export function resolveEnabledPaperStrategies(
  catalogRows: { id: string }[],
  enabledRows: { strategyId: string; enabled: boolean }[],
): string[] {
  const catalogIds = catalogRows.map((row) => row.id).sort();
  const registryIds = [...ALL_ENGINE_STRATEGY_IDS].sort();
  if (JSON.stringify(catalogIds) !== JSON.stringify(registryIds)) {
    throw new Error("strategy_catalog_drift");
  }
  const explicitlyDisabled = new Set(
    enabledRows.filter((row) => row.enabled === false).map((row) => row.strategyId),
  );
  return ALL_ENGINE_STRATEGY_IDS.filter((id) => !explicitlyDisabled.has(id));
}

function toEngineQuote(quote: NativeXauusdQuote): SignalEngineQuote {
  return { bid: quote.bid, ask: quote.ask, mid: (quote.bid + quote.ask) / 2 };
}

function modeFor(timeframe: PaperTimeframe): "intraday" | "scalper" {
  return SCALP_TIMEFRAMES.includes(timeframe) ? "scalper" : "intraday";
}

function buildAccounting(input: {
  enabledStrategyIds: string[];
  timeframe: PaperTimeframe;
  voteIds: string[];
  scanThrew: boolean;
}): StrategyAccounting {
  const accounting: StrategyAccounting = {
    evaluated: [],
    abstained: [],
    incompatible: [],
    excluded: [],
    failed: [],
  };
  for (const strategyId of input.enabledStrategyIds) {
    const capability = getEngineStrategyCapability(strategyId);
    if (!capability.implemented || !capability.timeframes.includes(input.timeframe)) {
      accounting.incompatible.push(strategyId);
      continue;
    }
    if (MACRO_DEPENDENT_STRATEGIES.has(strategyId)) {
      accounting.failed.push({ strategyId, code: "macro_context_unavailable" });
      continue;
    }
    if (input.scanThrew) {
      accounting.failed.push({ strategyId, code: "insufficient_history" });
      continue;
    }
    if (input.voteIds.includes(strategyId)) {
      accounting.evaluated.push(strategyId);
    } else {
      accounting.abstained.push(strategyId);
    }
  }
  return accounting;
}

export async function scanCompletedTimeframes(input: {
  quote: NativeXauusdQuote;
  candlesByTimeframe: Partial<Record<PaperTimeframe, TwoSidedCandle[]>>;
  newlyCompleted: PaperTimeframe[];
  enabledStrategyIds: string[];
  /**
   * Promoted trust multipliers for THIS timeframe's mode (from the
   * strategy_promotions ledger). Applied on top of the walk-forward weights,
   * clamped to the same 0.15..1.15 band the league uses. Absent = weights
   * exactly as computeStrategyWeights produced them.
   */
  multipliersByStrategy?: Record<string, number>;
  engineVersion: string;
  policyVersion: string;
}): Promise<PaperSignalCandidate[]> {
  const candidates: PaperSignalCandidate[] = [];

  for (const timeframe of input.newlyCompleted) {
    const twoSided = input.candlesByTimeframe[timeframe];
    if (!twoSided || twoSided.length === 0) continue;
    const midCandles = toMidCandles(twoSided);
    const mode = modeFor(timeframe);
    // Walk-forward trust weights computed on THIS timeframe and shared with
    // the MTF tide so both layers agree on which strategies are trusted.
    // Promoted multipliers (the approved learning loop) are applied on top,
    // clamped to the same band as the league's effectiveWeight; with no
    // promotions this is exactly the raw walk-forward weights.
    const weights = computeStrategyWeights(midCandles, timeframe, mode).weights;
    if (input.multipliersByStrategy) {
      for (const strategyId of Object.keys(weights)) {
        const multiplier = input.multipliersByStrategy[strategyId] ?? 1;
        if (multiplier === 1) continue;
        weights[strategyId] = Math.min(1.15, Math.max(0.15, weights[strategyId] * multiplier));
      }
    }
    const enabled = input.enabledStrategyIds.filter((id) => !MACRO_DEPENDENT_STRATEGIES.has(id));
    const candleClosedAt = twoSided.at(-1)!.time;
    const engineQuote = toEngineQuote(input.quote);

    let result: ReturnType<typeof scanCandlesForSignal>;
    try {
      result = scanCandlesForSignal({
        pair: "XAUUSD",
        mode,
        timeframe,
        quote: engineQuote,
        candles: midCandles,
        enabledStrategyIds: enabled,
        strategyWeights: weights,
      });
    } catch (error) {
      if (error instanceof Error && /at least 60 complete/i.test(error.message)) {
        // Not enough history to scan: account every compatible engine as
        // failed rather than letting them vanish from the report.
        const accounting = buildAccounting({
          enabledStrategyIds: input.enabledStrategyIds,
          timeframe,
          voteIds: [],
          scanThrew: true,
        });
        throw new PaperScanError(
          "insufficient_history",
          `timeframe ${timeframe} has too little history`,
        );
      }
      throw error;
    }

    const voteIds = result.diagnostics.votes.map((vote) => vote.strategyId);
    const accounting = buildAccounting({
      enabledStrategyIds: input.enabledStrategyIds,
      timeframe,
      voteIds,
      scanThrew: false,
    });

    if (!result.signal) continue;

    // MTF: when direction candles are present, an opposing confirmed tide
    // rejects the candidate outright; an aligning tide is stamped in. The
    // entry timeframe itself is excluded from its own direction set (M5 is
    // both a scalper entry and a scalper tide timeframe).
    const plan = MTF_PLANS[mode];
    const directionTfsWithCandles = plan.directionTfs.filter(
      (tf) => tf !== timeframe && (input.candlesByTimeframe[tf]?.length ?? 0) > 0,
    );
    const snapshotRoles: { timeframe: PaperTimeframe; role: "entry" | "mtf_direction" }[] = [
      { timeframe, role: "entry" },
      ...directionTfsWithCandles.map((tf) => ({
        timeframe: tf as PaperTimeframe,
        role: "mtf_direction" as const,
      })),
    ];
    let mtf: MtfAgreement | null = null;
    if (directionTfsWithCandles.length > 0) {
      const candlesByTf: Record<string, SignalEngineCandle[]> = {};
      for (const tf of directionTfsWithCandles) {
        candlesByTf[tf] = toMidCandles(input.candlesByTimeframe[tf]!);
      }
      mtf = computeMtfAgreement({
        pair: "XAUUSD",
        mode,
        plan,
        candlesByTf,
        enabledStrategyIds: enabled,
        strategyWeights: weights,
      });
      if (mtf.confirmed && mtf.confirmed !== result.signal.direction) {
        // Confirmed opposing tide: named rejection, no candidate.
        continue;
      }
    }

    candidates.push({
      mode,
      timeframe,
      candleClosedAt,
      direction: result.signal.direction,
      entry: result.signal.entry,
      stopLoss: result.signal.stopLoss,
      takeProfit1: result.signal.takeProfit1,
      takeProfit2: result.signal.takeProfit2,
      atr: result.signal.atr,
      confluence: result.signal.confluence,
      contributingStrategies: result.signal.contributingStrategies,
      rationale: result.signal.rationale,
      expiresAt: new Date(
        Date.parse(candleClosedAt) + VALIDITY_MINUTES[timeframe] * 60_000,
      ).toISOString(),
      engineVersion: input.engineVersion,
      policyVersion: input.policyVersion,
      accounting,
      mtf,
      snapshotRoles,
    });
  }

  return candidates;
}
