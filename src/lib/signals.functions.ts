import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  fetchMarketCandles,
  fetchMarketQuotes,
  getMarketProviderStatus,
  MARKET_PAIRS,
  MARKET_TIMEFRAMES,
  type MarketQuote,
  type MarketTimeframe,
} from "@/lib/market-data.server";
import {
  DOWNWEIGHT_FLOOR,
  getEngineStrategyCapability,
  macroConfluenceAdjustment,
  pairCurrencies,
  scanCandlesForSignal,
  type SignalTimeframe,
} from "@/lib/signal-engine";
import { computeMtfAgreement, MTF_PLANS, type MtfAgreement } from "@/lib/mtf-engine";
import { buildArmedContext, type ArmedContext, type ArmedSetup } from "@/lib/armed-setup";
import { arbitrateMode, type ModeRead } from "@/lib/mode-arbiter";
import {
  ALL_ENGINE_STRATEGY_IDS,
  computeStrategyWeights,
  type StrategyWeightReport,
} from "@/lib/strategy-weights";
import { fetchMacroContext, type MacroContext } from "@/lib/macro-data.server";
import {
  buildCalibrationCurve,
  curveIsInformative,
  type ResolvedForCalibration,
} from "@/lib/calibration";
import { isResolvedStatus } from "@/lib/order-ticket";
import {
  buildPerformanceReport,
  followabilityForSignal,
  outcomeFromStatus,
  replaySignalPath,
  scoreSignal,
  type PerformanceReport,
  type SignalForScoring,
} from "@/lib/signal-scorer";
import {
  buildLearningReport,
  computeStrategyLearning,
  type LearningReport,
  type ResolvedSignalForLearning,
  type StrategyLearning,
} from "@/lib/signal-learning";
export type { PerformanceReport, LearningReport };

// Signals invalidated (expired / user-cancelled) within this window are still
// path-replayed so a signal that actually touched a target before expiring is
// resolved to hit_tp1/hit_tp2/hit_sl instead of being lost as a plain
// "invalidated". Older invalidated signals are left untouched.
const INVALIDATED_GRACE_MS = 15 * 60_000;

// Short-lived per-process cache for the per-pair candle fetches the 30s
// performance poll does, so a 14-pair universe doesn't burn ~14 bucket tokens
// on every poll (candles are immutable over a 45s window).
const candleCache = new Map<
  string,
  { fetchedAt: number; candles: Awaited<ReturnType<typeof fetchMarketCandles>> }
>();
const CANDLE_CACHE_TTL_MS = 45_000;

async function fetchCandlesCached(pair: string, timeframe: MarketTimeframe, count: number) {
  const key = `${pair}:${timeframe}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CANDLE_CACHE_TTL_MS) return hit.candles;
  const candles = await fetchMarketCandles(pair, timeframe, count);
  candleCache.set(key, { fetchedAt: Date.now(), candles });
  if (candleCache.size > 64) candleCache.delete(candleCache.keys().next().value as string);
  return candles;
}

const GenerateInput = z.object({
  // "auto" resolves the risk profile from the timeframe being scanned, so a
  // sweep evaluates M1 with scalper tuning and D1 with intraday tuning in the
  // same pass instead of forcing one profile across every timeframe.
  mode: z.enum(["intraday", "scalper", "auto"]).default("intraday"),
  timeframe: z.enum(MARKET_TIMEFRAMES).optional(),
  pairs: z.array(z.enum(MARKET_PAIRS)).optional(),
  // Multi-timeframe scanning: confirm the direction on the higher timeframes
  // and generate the entry on the mode's lower timeframe. Off by default so
  // the dashboard/signal-center bulk scans keep their classic single-TF path.
  mtf: z.boolean().optional().default(false),
  // Sweep scanning: run the engine on EVERY requested timeframe and keep the
  // strongest setup per pair. Supersedes `mtf` when both are set.
  sweep: z.boolean().optional().default(false),
  // Explicit sweep list; defaults to every timeframe at least one enabled
  // strategy actually supports.
  sweepTimeframes: z.array(z.enum(MARKET_TIMEFRAMES)).optional(),
});

/** Timeframes the engine treats as scalps; everything above is intraday. */
const SCALP_TIMEFRAMES: MarketTimeframe[] = ["M1", "M5", "M15", "M30"];

function modeForTimeframe(timeframe: MarketTimeframe): "intraday" | "scalper" {
  return SCALP_TIMEFRAMES.includes(timeframe) ? "scalper" : "intraday";
}

/**
 * Every timeframe covered by at least one enabled, implemented strategy — the
 * honest answer to "all possible timeframes from all the strategies". A
 * timeframe no enabled strategy can vote on is dropped so the sweep doesn't
 * burn a feed request on a guaranteed no-op.
 */
function timeframesCoveredByStrategies(enabledStrategyIds: string[]): MarketTimeframe[] {
  const covered = new Set<string>();
  for (const strategyId of enabledStrategyIds) {
    const capability = getEngineStrategyCapability(strategyId);
    if (!capability.implemented) continue;
    for (const tf of capability.timeframes) covered.add(tf);
  }
  return MARKET_TIMEFRAMES.filter((tf) => covered.has(tf));
}

/**
 * Ranking key for sweep candidates: confluence first, then how many
 * independent strategies actually voted for it. A 70% setup carried by six
 * strategies beats a 70% setup carried by two.
 */
function sweepScore(signal: { confluence: number; contributing_strategies: string[] }) {
  return signal.confluence * 1_000 + signal.contributing_strategies.length;
}

/**
 * Carries the regime/votes/near-miss read buildArmedContext already computed
 * instead of collapsing it to a bare reason string. Constructed once, in
 * buildLiveSignal's null-signal branch, and read back wherever a caller
 * catches it (the sweep loop, the classic path) rather than recomputed —
 * `armed`/`mode` are already settled by the time this is thrown.
 */
export class NoSetupError extends Error {
  readonly armed: ArmedSetup | null;
  readonly mode: ModeRead;
  readonly direction: "long" | "short" | null;
  constructor(reason: string, context: ArmedContext) {
    super(reason);
    this.name = "NoSetupError";
    this.armed = context.armed;
    this.mode = context.mode;
    this.direction = context.direction;
  }
}

export type SweepAttempt = {
  timeframe: MarketTimeframe;
  mode: "intraday" | "scalper";
  direction: "long" | "short" | null;
  confluence: number;
  strategies: number;
  reason?: string;
  // Diagnostic snapshots only, same as `reason` above — an armed setup is a
  // live read of the current tape, recomputed every scan, never a row of
  // its own and never a signals.status value. Whatever history it has ends
  // with whichever signal row's sweep breadcrumb happens to carry it; it is
  // not a thing to give a table or a status of its own, tempting as that
  // will look once a UI wants to list "setups currently armed".
  /** Only set when the attempt failed with a NoSetupError — no such read
   *  exists for a fetch failure or any other error. */
  armed?: ArmedSetup | null;
  modeVerdict?: string;
};

function hasVerifiedMarketData(context: unknown) {
  if (!context || Array.isArray(context) || typeof context !== "object") return false;
  const marketData = (context as Record<string, unknown>).market_data;
  if (!marketData || Array.isArray(marketData) || typeof marketData !== "object") return false;
  const provider = (marketData as Record<string, unknown>).provider;
  return provider === "OANDA" || provider === "COINBASE";
}

const VALIDITY_MINUTES: Record<MarketTimeframe, number> = {
  M1: 10,
  M5: 15,
  M15: 30,
  M30: 60,
  H1: 90,
  H4: 240,
  D1: 1_440,
};

/**
 * Minutes to the nearest High-impact release relevant to `pair`'s two
 * currencies — arbitrateMode's stand-down window needs the raw minutes, not
 * the confluence discount macroConfluenceAdjustment derives from the same
 * read, so this reapplies pairCurrencies' own relevance filter directly
 * rather than repurposing that function's differently-shaped return.
 */
function minutesToNearestHighImpact(
  events: MacroContext["events"],
  pair: string,
  now: number,
): number | null {
  const currencies = pairCurrencies(pair);
  const candidates = events.filter(
    (event) => event.impact === "High" && currencies.includes(event.currency),
  );
  if (candidates.length === 0) return null;
  // Nearest by absolute distance — same tie-break macroConfluenceAdjustment
  // uses, since a release that just printed is exactly as disruptive right
  // now as one about to print.
  const nearest = candidates.reduce((closest, event) =>
    Math.abs(event.timestamp - now) < Math.abs(closest.timestamp - now) ? event : closest,
  );
  return (nearest.timestamp - now) / 60_000;
}

async function buildLiveSignal(
  pair: string,
  mode: "intraday" | "scalper",
  timeframe: MarketTimeframe,
  enabled: string[],
  quote: MarketQuote,
  candles: Awaited<ReturnType<typeof fetchMarketCandles>>,
  macro: MacroContext,
  learning: Map<string, StrategyLearning>,
  mtfAgreement?: MtfAgreement,
  effectiveWeights?: {
    weights: Record<string, number>;
    report: StrategyWeightReport;
    learningApplied: { strategyId: string; multiplier: number; verdict: string }[];
  },
) {
  if (!quote.tradeable)
    throw new Error("Live feed reports this instrument as non-tradeable (no real-time tick data).");

  // Walk-forward trust weights computed from the same candles the scan uses —
  // strategies that fail on recent out-of-sample data are auto-downweighted.
  // The mode is threaded through so a strategy's accuracy is measured exactly
  // as it will run in production (scalper tuning vs intraday tuning). The
  // caller (MTF scans) can pass the FINAL effective weights (walk-forward x
  // self-learning) so the higher-timeframe tide and the entry scan agree on
  // exactly which strategies are trusted; otherwise they're derived here.
  const {
    weights,
    report: weightReport,
    learningApplied,
  } = effectiveWeights ??
  (() => {
    const computed = computeStrategyWeights(candles, timeframe, mode);
    const applied: { strategyId: string; multiplier: number; verdict: string }[] = [];
    for (const [strategyId, learned] of learning) {
      if (learned.multiplier === 1) continue;
      const current = computed.weights[strategyId] ?? 1;
      computed.weights[strategyId] = Math.min(1.15, Math.max(0.15, current * learned.multiplier));
      applied.push({ strategyId, multiplier: learned.multiplier, verdict: learned.verdict });
    }
    return { weights: computed.weights, report: computed.report, learningApplied: applied };
  })();
  const result = scanCandlesForSignal({
    pair,
    mode,
    timeframe,
    quote,
    candles,
    enabledStrategyIds: enabled,
    strategyWeights: weights,
    // Macro overlay powers the news_reactive / ai_confluence strategies.
    macro,
  });
  if (!result.signal) {
    // The scan already computed the regime, the votes, and the near-miss
    // reason — buildArmedContext restates all of it as the exact watch-list
    // state a trader would describe out loud, instead of it being discarded
    // as a bare string the instant this throws.
    const armedContext = buildArmedContext({
      candles,
      votes: result.diagnostics.votes,
      mtf: mtfAgreement ?? null,
      minutesToHighImpact: minutesToNearestHighImpact(macro.events, pair, Date.now()),
    });
    throw new NoSetupError(result.diagnostics.reason, armedContext);
  }
  const signal = result.signal;
  const validityMinutes = VALIDITY_MINUTES[timeframe];
  // MTF tide (if requested): the direction the higher timeframes collectively
  // confirmed for this pair right now, stamped onto the stored signal.
  const mtfTide = mtfAgreement?.confirmed
    ? `${mtfAgreement.confirmed.toUpperCase()} tide confirmed on ${mtfAgreement.biases.filter((bias) => bias.direction === mtfAgreement.confirmed).length}/${mtfAgreement.biases.filter((bias) => bias.direction !== "neutral").length} directional higher timeframes (${mtfAgreement.alignment * 100}% alignment).`
    : null;

  // A pending high-impact release makes a technical setup LESS reliable, not
  // more — the nudge here only ever subtracts, scaled by how close the tape
  // is to the print (see macroConfluenceAdjustment for the exact bands).
  const now = Date.now();
  const {
    adjustment: macroNudge,
    risk: newsRisk,
    event: newsEvent,
  } = macroConfluenceAdjustment(macro.events, pair, now);
  const newsSentence = newsEvent
    ? (() => {
        const minutesUntil = Math.round((newsEvent.timestamp - now) / 60_000);
        const countdown =
          minutesUntil >= 0 ? `in ${minutesUntil}m` : `${Math.abs(minutesUntil)}m ago`;
        return ` High-impact ${newsEvent.currency} event (${newsEvent.title}) ${countdown} — news risk ${newsRisk}, confluence adjusted ${macroNudge}.`;
      })()
    : "";

  return {
    pair,
    direction: signal.direction,
    mode,
    timeframe: signal.timeframe,
    entry: signal.entry,
    stop_loss: signal.stopLoss,
    take_profit_1: signal.takeProfit1,
    take_profit_2: signal.takeProfit2,
    atr: signal.atr,
    confluence: Math.max(0, Math.min(95, signal.confluence + macroNudge)),
    contributing_strategies: signal.contributingStrategies,
    rationale: `${signal.rationale}${mtfTide ? ` ${mtfTide}` : ""}${newsSentence}`,
    news_context: {
      // news_context is the jsonb catch-all for anything without its own
      // column (same reason the sweep block's `mtf` key lives here) — the
      // signals table has no news_risk column, so it cannot be a top-level
      // field the way confluence/rationale are.
      news_risk: newsRisk,
      market_data: {
        provider: quote.source,
        price_type: signal.direction === "long" ? "executable_ask" : "executable_bid",
        timestamp: quote.timestamp,
        environment: getMarketProviderStatus().environment,
        ...(quote.instrument ? { instrument: quote.instrument } : {}),
        ...(quote.source_note ? { source_note: quote.source_note } : {}),
      },
      strategy_engine: {
        version: 3,
        evaluated: result.diagnostics.evaluatedStrategyIds,
        downweighted: result.diagnostics.downweightedStrategyIds,
        incompatible: result.diagnostics.incompatibleStrategyIds,
        catalog_only: result.diagnostics.catalogOnlyStrategyIds,
        votes: result.diagnostics.votes,
        weights: weightReport,
        risk: signal.risk,
        learning: {
          applied_at: new Date().toISOString(),
          multipliers: learningApplied,
        },
        // Same verdict buildArmedContext would have produced had this scan
        // declined instead — regime/location are already settled on
        // `signal`, so this is a restatement for the signal that DID fire,
        // answering "why a scalp and not a swing" for the UI.
        mode: arbitrateMode({
          regime: signal.regime,
          location: signal.location,
          direction: signal.direction,
          minutesToHighImpact: minutesToNearestHighImpact(macro.events, pair, now),
        }),
        // The evidence BEHIND that verdict, not just the verdict. A user who
        // only sees "wait" learns to obey the app; one who sees "ADX 31,
        // efficiency 0.62, price at 0.84 of the swing range" eventually stops
        // needing it. That is the point of the whole overlay layer.
        regime: signal.regime,
        location: signal.location,
        ...(mtfAgreement ? { mtf: mtfAgreement } : {}),
      },
      macro,
    },
    expires_at: new Date(Date.now() + validityMinutes * 60_000).toISOString(),
    status: "fresh" as const,
  };
}

export const generateSignals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown): z.infer<typeof GenerateInput> => {
    // Browser signal generation is retired: canonical XAUUSD paper signals
    // are worker-owned and the unattended auto-paper worker replaces this
    // path. Throwing here fails the request BEFORE any provider work can run
    // (the handler below can never execute).
    void GenerateInput.parse(input);
    throw new Error("Browser signal generation retired; enable XAUUSD Auto-Paper.");
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: settings } = await supabase
      .from("strategy_settings")
      .select("strategy_id, enabled")
      .eq("user_id", userId);

    let enabled = (settings ?? []).filter((s) => s.enabled).map((s) => s.strategy_id);
    if (enabled.length === 0) {
      // No settings row yet -> assume all strategies enabled by default.
      const { data: allStrategies } = await supabase.from("strategies").select("id");
      enabled = (allStrategies ?? []).map((s) => s.id);
    }
    // Runtime fallback: engine strategies not present in the DB catalog (e.g.
    // freshly implemented evaluators before the strategy-seed migration runs)
    // are auto-enabled so they contribute immediately. The catalog-only ids in
    // the DB stay exactly as the user configured them.
    if (enabled.length > 0) {
      const dbIds = new Set((settings ?? []).map((s) => s.strategy_id));
      for (const engineId of ALL_ENGINE_STRATEGY_IDS) {
        if (!dbIds.has(engineId) && !enabled.includes(engineId)) enabled.push(engineId);
      }
    }

    const pairs = data.pairs && data.pairs.length > 0 ? data.pairs : [...MARKET_PAIRS];

    // AUTONOMOUS SELF-LEARNING: load a mode's resolved paper-trading record and
    // derive per-strategy trust multipliers. Applied to the walk-forward
    // weights so every scan is reweighted by what the book has actually
    // learned. The mode filter lives in SQL so a flood of one mode's signals
    // can never starve the other mode's samples. Memoised per request because a
    // sweep in "auto" needs BOTH modes' records.
    const learningByMode = new Map<"intraday" | "scalper", Map<string, StrategyLearning>>();
    const loadLearning = async (mode: "intraday" | "scalper") => {
      const cached = learningByMode.get(mode);
      if (cached) return cached;
      const { data: resolvedRows } = await supabase
        .from("signals")
        .select(
          "id, pair, direction, mode, timeframe, confluence, contributing_strategies, status, created_at",
        )
        .eq("user_id", userId)
        .eq("mode", mode)
        .in("status", ["hit_tp1", "hit_tp2", "hit_sl", "invalidated"])
        .order("created_at", { ascending: false })
        .limit(300);
      const computed = computeStrategyLearning(
        (resolvedRows ?? []) as ResolvedSignalForLearning[],
        mode,
      );
      learningByMode.set(mode, computed);
      return computed;
    };

    // Walk-forward trust x self-learning, computed once per pair+timeframe so
    // the tide layer and the entry scan agree on which strategies are trusted.
    const effectiveWeightsFor = (
      candles: Awaited<ReturnType<typeof fetchMarketCandles>>,
      timeframe: MarketTimeframe,
      mode: "intraday" | "scalper",
      learning: Map<string, StrategyLearning>,
    ) => {
      const { weights, report } = computeStrategyWeights(candles, timeframe, mode);
      const learningApplied: { strategyId: string; multiplier: number; verdict: string }[] = [];
      for (const [strategyId, learned] of learning) {
        if (learned.multiplier === 1) continue;
        weights[strategyId] = Math.min(
          1.15,
          Math.max(0.15, (weights[strategyId] ?? 1) * learned.multiplier),
        );
        learningApplied.push({
          strategyId,
          multiplier: learned.multiplier,
          verdict: learned.verdict,
        });
      }
      return { weights, report, learningApplied };
    };

    // -----------------------------------------------------------------------
    // SWEEP: scan every requested timeframe and keep the strongest setup per
    // pair. Timeframes are walked sequentially and share the 45s candle cache,
    // so a sweep stays inside the feed's token bucket.
    // -----------------------------------------------------------------------
    if (data.sweep) {
      if (pairs.length > 3) {
        throw new Error(
          "Sweep mode scans up to 3 pairs at a time. Select a pair on the chart and rerun, or turn sweep off for a bulk scan.",
        );
      }
      const covered = timeframesCoveredByStrategies(enabled);
      const requested = data.sweepTimeframes?.length ? data.sweepTimeframes : covered;
      const timeframes = MARKET_TIMEFRAMES.filter(
        (tf) => requested.includes(tf) && covered.includes(tf),
      );
      if (timeframes.length === 0) {
        throw new Error("No enabled strategy supports any of the requested timeframes.");
      }

      const macroByPair = await fetchMacroContext(pairs);
      const quotes = await fetchMarketQuotes(pairs);
      const quotesByPair = new Map(quotes.map((quote) => [quote.pair, quote]));

      const sweptRows: (Awaited<ReturnType<typeof buildLiveSignal>> & { user_id: string })[] = [];
      const sweepWarnings: string[] = [];

      for (const pair of pairs) {
        const quote = quotesByPair.get(pair);
        if (!quote) {
          sweepWarnings.push(`${pair}: live feed returned no current quote.`);
          continue;
        }
        const macro = macroByPair[pair] ?? { events: [], cot: null };
        const attempts: SweepAttempt[] = [];
        let best: Awaited<ReturnType<typeof buildLiveSignal>> | null = null;

        for (const tf of timeframes) {
          const tfMode = data.mode === "auto" ? modeForTimeframe(tf) : data.mode;
          try {
            const candles = await fetchCandlesCached(pair, tf, 220);
            const learning = await loadLearning(tfMode);
            const { weights, report, learningApplied } = effectiveWeightsFor(
              candles,
              tf,
              tfMode,
              learning,
            );
            const signal = await buildLiveSignal(
              pair,
              tfMode,
              tf,
              enabled,
              quote,
              candles,
              macro,
              learning,
              undefined,
              { weights, report, learningApplied },
            );
            attempts.push({
              timeframe: tf,
              mode: tfMode,
              direction: signal.direction,
              confluence: signal.confluence,
              strategies: signal.contributing_strategies.length,
            });
            if (!best || sweepScore(signal) > sweepScore(best)) best = signal;
          } catch (error) {
            const attempt: SweepAttempt = {
              timeframe: tf,
              mode: tfMode,
              direction: null,
              confluence: 0,
              strategies: 0,
              reason: error instanceof Error ? error.message : "no setup",
            };
            // A fetch failure or any other error has no armed-setup read to
            // attach — only a NoSetupError carries one, so armed/modeVerdict
            // stay undefined for everything else.
            if (error instanceof NoSetupError) {
              attempt.armed = error.armed;
              attempt.modeVerdict = error.mode.verdict;
            }
            attempts.push(attempt);
          }
        }

        if (!best) {
          sweepWarnings.push(
            `${pair}: no confluence setup on any of ${timeframes.join("/")} — ${attempts
              .map((a) => `${a.timeframe} ${a.reason ?? "no setup"}`)
              .join("; ")}`,
          );
          continue;
        }

        const winner = best;
        const engine = winner.news_context.strategy_engine;
        sweptRows.push({
          ...winner,
          news_context: {
            ...winner.news_context,
            // news_context is a jsonb column read back as `unknown` on the
            // client (same as the existing `mtf` block), so the extra sweep
            // key is asserted rather than widening buildLiveSignal's return.
            strategy_engine: {
              ...engine,
              sweep: {
                requested: timeframes,
                evaluated: attempts,
                winner: winner.timeframe,
                mode_resolution: data.mode === "auto" ? "per_timeframe" : "forced",
              },
            } as typeof engine,
          },
          user_id: userId,
        });
      }

      if (sweptRows.length === 0) {
        throw new Error(sweepWarnings[0] ?? "Live feed returned no usable market data.");
      }
      const { data: sweptInserted, error: sweepError } = await supabase
        .from("signals")
        .insert(sweptRows)
        .select();
      if (sweepError) throw new Error(sweepError.message);
      return { signals: sweptInserted ?? [], warnings: sweepWarnings };
    }

    // -----------------------------------------------------------------------
    // Classic path: one timeframe, optionally gated by the MTF tide.
    // -----------------------------------------------------------------------
    const classicTimeframe: MarketTimeframe =
      data.timeframe ?? (data.mode === "scalper" ? "M5" : "H1");
    const mode: "intraday" | "scalper" =
      data.mode === "auto" ? modeForTimeframe(classicTimeframe) : data.mode;
    // MTF scans always enter on the mode's plan entry timeframe (5M intraday /
    // 1M scalper); the classic path keeps the caller's explicit timeframe.
    const mtfPlan = MTF_PLANS[mode];
    const timeframe: MarketTimeframe = data.mtf ? mtfPlan.entryTf : classicTimeframe;
    const learning = await loadLearning(mode);
    // One keyless macro fetch (calendar + COT) for the whole scan, not one per pair.
    const macroByPair = await fetchMacroContext(pairs);
    const quotes = await fetchMarketQuotes(pairs);
    const quotesByPair = new Map(quotes.map((quote) => [quote.pair, quote]));
    const candidates = await Promise.allSettled(
      pairs.map(async (pair) => {
        const quote = quotesByPair.get(pair);
        if (!quote) throw new Error(`${pair}: live feed returned no current quote.`);
        const macro = macroByPair[pair] ?? { events: [], cot: null };
        const candles = await fetchMarketCandles(pair, timeframe, 220);
        // Effective trust weights (walk-forward x self-learning), computed ONCE
        // and shared by BOTH the higher-timeframe tide and the entry scan so
        // the two layers agree on exactly which strategies are trusted.
        const {
          weights: effectiveWeights,
          report: weightReport,
          learningApplied,
        } = effectiveWeightsFor(candles, timeframe, mode, learning);
        // MTF: fetch the higher-timeframe series (cached, so the 60s polls
        // don't burn extra bucket tokens) and compute the tide BEFORE the
        // entry scan, so a confirmed opposing tide blocks the entry outright.
        let mtfAgreement: MtfAgreement | undefined;
        if (data.mtf) {
          const candlesByTf: Record<string, Awaited<ReturnType<typeof fetchMarketCandles>>> = {};
          for (const tf of mtfPlan.directionTfs) {
            candlesByTf[tf] = await fetchCandlesCached(pair, tf, 220);
          }
          mtfAgreement = computeMtfAgreement({
            pair,
            mode,
            plan: mtfPlan,
            candlesByTf,
            enabledStrategyIds: enabled,
            strategyWeights: effectiveWeights,
            macro,
          });
        }
        let signal;
        try {
          signal = await buildLiveSignal(
            pair,
            mode,
            timeframe,
            enabled,
            quote,
            candles,
            macro,
            learning,
            mtfAgreement,
            { weights: effectiveWeights, report: weightReport, learningApplied },
          );
        } catch (error) {
          // When the entry scan declines, still surface the higher-timeframe
          // tide so the user knows which way the market is tilted right now.
          if (mtfAgreement?.confirmed) {
            const directionalCount = mtfAgreement.biases.filter(
              (bias) => bias.direction !== "neutral",
            ).length;
            const agreeingCount = mtfAgreement.biases.filter(
              (bias) => bias.direction === mtfAgreement.confirmed,
            ).length;
            const reason = error instanceof Error ? error.message : "no setup";
            throw new Error(
              `${pair}: entry declined (${reason}) — MTF tide ${mtfAgreement.confirmed.toUpperCase()} ${mtfAgreement.agreementScore}% on ${agreeingCount}/${directionalCount} directional higher TFs.`,
            );
          }
          throw error;
        }
        // The higher-timeframe tide is confirmed and points the other way — no
        // entry against the tide (the whole point of the MTF filter).
        if (mtfAgreement?.confirmed && mtfAgreement.confirmed !== signal.direction) {
          const directionalCount = mtfAgreement.biases.filter(
            (bias) => bias.direction !== "neutral",
          ).length;
          const agreeingCount = mtfAgreement.biases.filter(
            (bias) => bias.direction === mtfAgreement.confirmed,
          ).length;
          throw new Error(
            `${pair}: MTF tide opposes — ${mtfAgreement.confirmed.toUpperCase()} confirmed on ${agreeingCount}/${directionalCount} directional higher timeframes. No ${signal.direction.toUpperCase()} entry against the tide.`,
          );
        }
        return { ...signal, user_id: userId };
      }),
    );
    const rows = candidates.flatMap((candidate) =>
      candidate.status === "fulfilled" ? [candidate.value] : [],
    );
    const warnings = candidates.flatMap((candidate, index) =>
      candidate.status === "rejected"
        ? [
            `${pairs[index]}: ${candidate.reason instanceof Error ? candidate.reason.message : "scan failed"}`,
          ]
        : [],
    );

    if (rows.length === 0) {
      throw new Error(warnings[0] ?? "Live feed returned no usable market data.");
    }

    const { data: inserted, error } = await supabase.from("signals").insert(rows).select();
    if (error) throw new Error(error.message);
    return { signals: inserted ?? [], warnings };
  });

export type StrategyLeagueRow = {
  strategyId: string;
  votes: number;
  wins: number;
  accuracy: number | null;
  walkWeight: number;
  learnedMultiplier: number;
  effectiveWeight: number;
  status: "boost" | "cool" | "excluded" | "low" | "neutral" | "insufficient";
  learnedWins: number;
  learnedResolved: number;
};

export type StrategyLeague = {
  pair: string;
  timeframe: MarketTimeframe;
  mode: "intraday" | "scalper";
  generatedAt: string;
  total: number;
  active: number;
  excluded: number;
  rows: StrategyLeagueRow[];
};

const LeagueInput = z.object({
  pair: z.string().min(3).max(10).default("XAUUSD"),
  timeframe: z.enum(MARKET_TIMEFRAMES).default("H1"),
});

// Strategy league: scores EVERY engine strategy live — walk-forward trust
// (weight, accuracy, votes) on real candles from the live feed, merged with
// the self-learning multipliers from the resolved paper-trading record. The
// effective weight is what the next scan actually applies, so the table shows
// exactly how loudly each of the 31 strategies will vote right now.
export const getStrategyLeague = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => LeagueInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const mode: "intraday" | "scalper" = modeForTimeframe(data.timeframe);

    // Same candles a live scan would use for this pair + timeframe.
    const candles = await fetchMarketCandles(data.pair, data.timeframe, 220);
    const { weights, report } = computeStrategyWeights(candles, data.timeframe, mode);
    const reportById = new Map(report.entries.map((entry) => [entry.strategyId, entry]));

    // The mode-scoped learning multipliers (same query the scanner uses).
    const { data: resolvedRows } = await supabase
      .from("signals")
      .select(
        "id, pair, direction, mode, timeframe, confluence, contributing_strategies, status, created_at",
      )
      .eq("user_id", userId)
      .eq("mode", mode)
      .in("status", ["hit_tp1", "hit_tp2", "hit_sl", "invalidated"])
      // Canonical rows are excluded — they are resolved only by the worker RPC path.
      .neq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(300);
    const learning = computeStrategyLearning(
      (resolvedRows ?? []) as ResolvedSignalForLearning[],
      mode,
    );

    const rows = ALL_ENGINE_STRATEGY_IDS.map((strategyId) => {
      const entry = reportById.get(strategyId);
      const learned = learning.get(strategyId);
      const walkWeight = weights[strategyId] ?? 1;
      const learnedMultiplier = learned?.multiplier ?? 1;
      const effectiveWeight = Math.min(1.15, Math.max(0.15, walkWeight * learnedMultiplier));
      let status: "boost" | "cool" | "excluded" | "low" | "neutral" | "insufficient";
      if (learned?.verdict === "boost") status = "boost";
      else if (learned?.excluded) status = "excluded";
      else if (learned?.verdict === "cool") status = "cool";
      else if (entry?.downweighted || effectiveWeight < DOWNWEIGHT_FLOOR) status = "low";
      else status = learned?.verdict === "insufficient" ? "insufficient" : "neutral";
      return {
        strategyId,
        votes: entry?.votes ?? 0,
        wins: entry?.wins ?? 0,
        accuracy: entry?.accuracy ?? null,
        walkWeight: +walkWeight.toFixed(2),
        learnedMultiplier,
        effectiveWeight: +effectiveWeight.toFixed(2),
        status,
        // Aggregate stats for the learning rows (panel shows wins/resolved).
        learnedWins: learned?.wins ?? 0,
        learnedResolved: learned?.resolved ?? 0,
      };
    });

    rows.sort((a, b) => {
      // Vote-earning strategies first (they have live evidence), then by
      // effective weight so the top of the table is what the engine leans on.
      const aVotes = a.votes > 0 ? 1 : 0;
      const bVotes = b.votes > 0 ? 1 : 0;
      if (aVotes !== bVotes) return bVotes - aVotes;
      return b.effectiveWeight - a.effectiveWeight;
    });

    return {
      pair: data.pair,
      timeframe: data.timeframe,
      mode,
      generatedAt: new Date().toISOString(),
      total: rows.length,
      active: rows.filter((row) => row.effectiveWeight >= DOWNWEIGHT_FLOOR).length,
      excluded: rows.filter((row) => row.status === "excluded").length,
      rows,
    };
  });

const StrategyDetailInput = z.object({
  strategyId: z.string().min(3).max(60),
  pair: z.string().min(3).max(10).default("XAUUSD"),
  timeframe: z.enum(MARKET_TIMEFRAMES).default("H1"),
});

export type StrategyDetail = {
  strategyId: string;
  name: string | null;
  description: string | null;
  timeframes: SignalTimeframe[];
  walk: {
    votes: number;
    wins: number;
    accuracy: number | null;
    weight: number;
    downweighted: boolean;
  } | null;
  learning: {
    intraday: {
      wins: number;
      resolved: number;
      losses: number;
      winRate: number;
      totalR: number;
      multiplier: number;
      verdict: string;
      excluded: boolean;
    } | null;
    scalper: {
      wins: number;
      resolved: number;
      losses: number;
      winRate: number;
      totalR: number;
      multiplier: number;
      verdict: string;
      excluded: boolean;
    } | null;
  };
  recentSignals: {
    id: string;
    pair: string;
    direction: string;
    mode: string;
    timeframe: string;
    status: string;
    confluence: number;
    created_at: string;
    entry: number;
    stop_loss: number;
    take_profit_1: number;
    take_profit_2: number;
  }[];
};

// Drill-in card data for one strategy: the walk-forward verdict on the
// selected pair/timeframe, BOTH modes' learning record (so you see scalper vs
// intraday trust), and the last 5 signals it contributed to.
export const getStrategyDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => StrategyDetailInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const mode: "intraday" | "scalper" = modeForTimeframe(data.timeframe);

    const [{ data: catalog }, candles] = await Promise.all([
      supabase
        .from("strategies")
        .select("name, description")
        .eq("id", data.strategyId)
        .maybeSingle(),
      fetchMarketCandles(data.pair, data.timeframe, 220),
    ]);
    const capability = getEngineStrategyCapability(data.strategyId);
    const { weights, report } = computeStrategyWeights(candles, data.timeframe, mode);
    const walkEntry = report.entries.find((entry) => entry.strategyId === data.strategyId);
    const walk = walkEntry
      ? {
          votes: walkEntry.votes,
          wins: walkEntry.wins,
          accuracy: walkEntry.accuracy,
          weight: walkEntry.weight,
          downweighted: walkEntry.downweighted,
        }
      : null;

    const SELECT_LEARNING =
      "id, pair, direction, mode, timeframe, confluence, contributing_strategies, status, created_at";
    const [{ data: intradayRows }, { data: scalperRows }] = await Promise.all([
      supabase
        .from("signals")
        .select(SELECT_LEARNING)
        .eq("user_id", userId)
        .eq("mode", "intraday")
        .in("status", ["hit_tp1", "hit_tp2", "hit_sl", "invalidated"])
        .neq("generated_by", "xauusd_paper_worker")
        .order("created_at", { ascending: false })
        .limit(300),
      supabase
        .from("signals")
        .select(SELECT_LEARNING)
        .eq("user_id", userId)
        .eq("mode", "scalper")
        .in("status", ["hit_tp1", "hit_tp2", "hit_sl", "invalidated"])
        .neq("generated_by", "xauusd_paper_worker")
        .order("created_at", { ascending: false })
        .limit(300),
    ]);
    const learningIntraday = computeStrategyLearning(
      (intradayRows ?? []) as ResolvedSignalForLearning[],
      "intraday",
    ).get(data.strategyId);
    const learningScalper = computeStrategyLearning(
      (scalperRows ?? []) as ResolvedSignalForLearning[],
      "scalper",
    ).get(data.strategyId);
    const toLearning = (entry?: StrategyLearning) =>
      entry
        ? {
            wins: entry.wins,
            resolved: entry.resolved,
            losses: entry.losses,
            winRate: entry.winRate,
            totalR: entry.totalR,
            multiplier: entry.multiplier,
            verdict: entry.verdict,
            excluded: entry.excluded,
          }
        : null;

    const { data: recentSignals } = await supabase
      .from("signals")
      .select(
        "id, pair, direction, mode, timeframe, status, confluence, created_at, entry, stop_loss, take_profit_1, take_profit_2",
      )
      .eq("user_id", userId)
      .contains("contributing_strategies", [data.strategyId])
      .neq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(5);

    return {
      strategyId: data.strategyId,
      name: catalog?.name ?? null,
      description: capability.implemented ? capability.description : (catalog?.description ?? null),
      timeframes: capability.implemented ? capability.timeframes : [],
      walk,
      learning: {
        intraday: toLearning(learningIntraday),
        scalper: toLearning(learningScalper),
      },
      recentSignals: (recentSignals ?? []) as StrategyDetail["recentSignals"],
    };
  });

export const getLearningReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // One mode-scoped query each so a mode that generates more signals can
    // never crowd the other mode's outcomes out of the 300-row window.
    const { data: intradayRows, error: intradayError } = await supabase
      .from("signals")
      .select(
        "id, pair, direction, mode, timeframe, confluence, contributing_strategies, status, created_at",
      )
      .eq("user_id", userId)
      .eq("mode", "intraday")
      .in("status", ["hit_tp1", "hit_tp2", "hit_sl", "invalidated"])
      .neq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(300);
    const { data: scalperRows, error: scalperError } = await supabase
      .from("signals")
      .select(
        "id, pair, direction, mode, timeframe, confluence, contributing_strategies, status, created_at",
      )
      .eq("user_id", userId)
      .eq("mode", "scalper")
      .in("status", ["hit_tp1", "hit_tp2", "hit_sl", "invalidated"])
      .neq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(300);
    if (intradayError) throw new Error(intradayError.message);
    if (scalperError) throw new Error(scalperError.message);
    return buildLearningReport([
      ...((intradayRows ?? []) as ResolvedSignalForLearning[]),
      ...((scalperRows ?? []) as ResolvedSignalForLearning[]),
    ]);
  });

/**
 * Reliability curve for the confluence score.
 *
 * Nothing has ever checked whether confluence means anything — whether a 78
 * really resolves better than a 62. This answers that from the resolved record
 * and reports "not enough data" wherever it cannot, rather than dressing a thin
 * sample up as a percentage. It gates nothing; it only makes the number
 * interpretable.
 *
 * Deliberately not mode-scoped, unlike getLearningReport: a calibration curve
 * needs every resolved outcome it can get, and splitting a already-thin record
 * in two would leave both halves under the reporting threshold for longer.
 */
export const getCalibrationCurve = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("signals")
      .select("confluence, status")
      .eq("user_id", userId)
      .in("status", ["hit_tp1", "hit_tp2", "hit_sl"])
      .neq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) throw new Error(error.message);
    const curve = buildCalibrationCurve((data ?? []) as ResolvedForCalibration[]);
    return { curve, informative: curveIsInformative(curve) };
  });

export const listSignals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("signals")
      .select("*")
      // Canonical worker rows are shown through listXauusdPaperSignals only;
      // the legacy feed never mixes them in.
      .neq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    // Compute validity in real-time
    const now = Date.now();
    // Live quotes for the followability check (is it already too late to take
    // this signal?): one batched fetch for every pair that has unresolved,
    // verified signals.
    const liveStatuses = (data ?? []).map((s) => {
      const marketDataVerified = hasVerifiedMarketData(s.news_context);
      const expires = new Date(s.expires_at as string).getTime();
      const created = new Date(s.created_at as string).getTime();
      const age = now - created;
      const lateThreshold = (expires - created) * 0.6;
      let liveStatus = s.status as string;
      if (!marketDataVerified) {
        liveStatus = "invalidated";
      } else if (liveStatus === "fresh" || liveStatus === "valid") {
        if (now > expires) liveStatus = "invalidated";
        else if (age > lateThreshold) liveStatus = "late";
        else liveStatus = "valid";
      }
      return { marketDataVerified, liveStatus, pair: s.pair as string };
    });
    const unresolvedPairs = [
      ...new Set(
        liveStatuses
          .filter((entry) => entry.marketDataVerified && !isResolvedStatus(entry.liveStatus))
          .map((entry) => entry.pair),
      ),
    ];
    let midByPair = new Map<string, number>();
    if (unresolvedPairs.length > 0) {
      try {
        const quotes = await fetchMarketQuotes(unresolvedPairs);
        midByPair = new Map(quotes.map((quote) => [quote.pair, quote.mid]));
      } catch {
        // Feed hiccup — leave followability unset rather than failing the list.
      }
    }

    const signals = (data ?? []).map((s, index) => {
      const { marketDataVerified, liveStatus } = liveStatuses[index];
      const mid = midByPair.get(s.pair as string);
      const resolved = isResolvedStatus(liveStatus);
      const followability =
        marketDataVerified && !resolved && mid != null
          ? followabilityForSignal(
              {
                direction: s.direction as "long" | "short",
                entry: Number(s.entry),
                stop_loss: Number(s.stop_loss),
              },
              mid,
            )
          : null;
      return {
        ...s,
        live_status: liveStatus,
        market_data_verified: marketDataVerified,
        followable: followability?.followable ?? true,
        follow_distance_pct: followability?.distancePct ?? null,
        // Live mid so the client can render the placeable order (BUY STOP /
        // SELL LIMIT / TOO LATE / INVALIDATED) instead of a bare direction.
        live_mid: mid ?? null,
      };
    });
    return { signals };
  });

export const scoreSignalPerformance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data, error } = await supabase
      .from("signals")
      .select(
        "id, pair, direction, timeframe, entry, stop_loss, take_profit_1, take_profit_2, contributing_strategies, status, created_at, expires_at",
      )
      .eq("user_id", userId)
      // Canonical rows are never scored or mutated here — the worker RPC path
      // is the only resolver for them.
      .neq("generated_by", "xauusd_paper_worker")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    const signals = (data ?? []) as unknown as SignalForScoring[];
    const pairs = [...new Set(signals.map((signal) => signal.pair))];
    if (pairs.length === 0) {
      return buildPerformanceReport([]);
    }

    // Score open signals against the live mid; fold previously resolved ones
    // (hit_tp1/hit_tp2/hit_sl) back in with their fixed R so the report is a
    // cumulative paper-trading record, not just this poll's batch. Recently
    // invalidated signals (grace window) are also replayed so a target touched
    // just before expiry is still recorded as a win instead of a plain
    // "invalidated".
    const liveSignals = signals.filter((signal) => {
      if (["fresh", "valid", "late"].includes(signal.status)) return true;
      // A signal that expired only recently may have touched a target inside
      // its validity window — replay it so the outcome isn't lost as a plain
      // "invalidated". Older invalidated signals are left untouched.
      if (signal.status === "invalidated") {
        const expiredAt = Date.parse(
          (signal as unknown as { expires_at?: string }).expires_at ?? signal.created_at,
        );
        return Number.isFinite(expiredAt) && Date.now() - expiredAt < INVALIDATED_GRACE_MS;
      }
      return false;
    });
    const quotes = liveSignals.length > 0 ? await fetchMarketQuotes(pairs) : [];
    const midByPair = new Map(quotes.map((quote) => [quote.pair, quote.mid]));

    // True path resolution: replay the real candles per pair (one cached fetch
    // per pair) and resolve by FIRST TOUCH of TP2/TP1/SL. This catches signals
    // that hit a target and then retraced — the live-mid scorer alone would
    // mislabel those as still open or stopped out.
    const pathByPair = new Map<string, Awaited<ReturnType<typeof fetchMarketCandles>>>();
    for (const signal of liveSignals) {
      if (pathByPair.has(signal.pair)) continue;
      const timeframe = (signal as unknown as { timeframe?: string }).timeframe as
        | MarketTimeframe
        | undefined;
      try {
        pathByPair.set(signal.pair, await fetchCandlesCached(signal.pair, timeframe ?? "H1", 200));
      } catch {
        pathByPair.set(signal.pair, []);
      }
    }

    const scored = signals.flatMap((signal) => {
      const resolved = outcomeFromStatus(signal.status);
      if (resolved) return [{ signal, outcome: resolved }];
      const mid = midByPair.get(signal.pair);
      // Prefer the candle path; fall back to the live mid only when no bars
      // are available for the signal's window.
      const pathOutcome = replaySignalPath(signal, pathByPair.get(signal.pair) ?? []);
      if (pathOutcome.status !== "open") return [{ signal, outcome: pathOutcome }];
      // Still unresolved: an expired signal is invalidated, an open one is
      // scored against the live mid.
      if (signal.status === "invalidated") {
        return [{ signal, outcome: { status: "open" as const, r: 0 } }];
      }
      if (mid == null) return [];
      return [{ signal, outcome: scoreSignal(signal, mid) }];
    });
    const report = buildPerformanceReport(scored);

    // Persist newly resolved outcomes so the status chips survive page reloads.
    for (const { signal, outcome } of scored) {
      if (outcome.status === "open" || outcomeFromStatus(signal.status)) continue;
      const resolved = outcome.status;
      await supabase.from("signals").update({ status: resolved }).eq("id", signal.id);
      await supabase.from("signal_events").insert({
        signal_id: signal.id,
        user_id: userId,
        event: `paper_${resolved}`,
        detail: { r: outcome.r, mode: "path_replay" },
      });
    }
    return report;
  });

export const invalidateSignal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Canonical worker signals cannot be invalidated from the browser — they
    // are resolved only through the worker's RPC path.
    const { data: existing, error: fetchError } = await supabase
      .from("signals")
      .select("generated_by")
      .eq("id", data.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);
    if (existing?.generated_by === "xauusd_paper_worker") {
      throw new Error("Canonical paper signals are worker-managed and cannot be invalidated.");
    }
    const { error } = await supabase
      .from("signals")
      .update({ status: "invalidated" })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    await supabase.from("signal_events").insert({
      signal_id: data.id,
      user_id: userId,
      event: "invalidated_by_user",
    });
    return { ok: true };
  });
