// Unattended XAUUSD auto-paper worker cycle.
//
// Runs once per minute from the cron-invoked Edge Function. The cycle is
// dependency-injected (provider + repository + clock) so it is fully
// testable without network or database. Every market-data failure fails
// closed: zero signals, zero fills, and a machine-readable health/scan
// record. Idempotency comes from the per-user/timeframe/candle/version
// fingerprint claim, and trade progression is a pure state-machine replay
// persisted with compare-and-swap writes.

import {
  validateQuote,
  validateCandles,
  validateSpreadForSignal,
  snapshotContentHash,
  PAPER_TIMEFRAMES,
  type NativeXauusdQuote,
  type PaperTimeframe,
  type TwoSidedCandle,
  type XauusdMarketDataProvider,
} from "./xauusd-market-data.ts";
import { advancePaperTrade, type PaperObservation, type PaperTrade } from "./paper-trade-state.ts";
import type { CommitPaperSignal, PaperWorkerRepository } from "./xauusd-paper-repository.ts";
import {
  PaperScanError,
  scanCompletedTimeframes,
  type PaperSignalCandidate,
} from "./paper-scan-orchestration.ts";
import { MTF_PLANS } from "./mtf-engine.ts";
import { OandaMarketDataError } from "./oanda-xauusd-provider.ts";

export type WorkerRunCounts = {
  profiles: number;
  scans: number;
  signals: number;
  transitions: number;
  failures: number;
};

const SCAN_CANDLE_COUNT = 400;
const ADVANCE_CANDLE_COUNT = 500;
const SCALP_TIMEFRAMES: PaperTimeframe[] = ["M1", "M5", "M15", "M30"];

function scanModeFor(timeframe: PaperTimeframe): "intraday" | "scalper" {
  return SCALP_TIMEFRAMES.includes(timeframe) ? "scalper" : "intraday";
}

function toSafeCode(error: unknown): string {
  if (error instanceof OandaMarketDataError) return error.code;
  if (error instanceof PaperScanError) return error.code;
  return "internal_error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fingerprint(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function toCommitInput(input: {
  userId: string;
  scanRunId: string;
  scanFingerprint: string;
  quote: NativeXauusdQuote;
  candleClosedAtByTf: Record<PaperTimeframe, string>;
  candlesByTf: Record<PaperTimeframe, TwoSidedCandle[]>;
  candidate: PaperSignalCandidate;
  engineVersion: string;
  policyVersion: string;
}): Promise<CommitPaperSignal> {
  const snapshots: CommitPaperSignal["snapshots"] = [];
  for (const role of input.candidate.snapshotRoles) {
    const candles = input.candlesByTf[role.timeframe];
    if (!candles || candles.length === 0) continue;
    const contentHash = await snapshotContentHash(input.quote, role.timeframe, candles);
    snapshots.push({
      quote: input.quote,
      timeframe: role.timeframe,
      candleClosedAt: input.candleClosedAtByTf[role.timeframe],
      candles,
      contentHash,
      qualityResult: {},
      role: role.role,
    });
  }
  return {
    scanRunId: input.scanRunId,
    userId: input.userId,
    scanFingerprint: input.scanFingerprint,
    snapshots,
    signal: {
      mode: input.candidate.mode,
      timeframe: input.candidate.timeframe,
      direction: input.candidate.direction,
      entry: input.candidate.entry,
      stopLoss: input.candidate.stopLoss,
      takeProfit1: input.candidate.takeProfit1,
      takeProfit2: input.candidate.takeProfit2,
      atr: input.candidate.atr,
      confluence: input.candidate.confluence,
      contributingStrategies: input.candidate.contributingStrategies,
      rationale: input.candidate.rationale,
      diagnostics: {},
      expiresAt: input.candidate.expiresAt,
      engineVersion: input.engineVersion,
      policyVersion: input.policyVersion,
    },
  };
}

export async function runXauusdPaperCycle(deps: {
  now: () => Date;
  provider: XauusdMarketDataProvider;
  repository: PaperWorkerRepository;
  engineVersion: string;
  policyVersion: string;
}): Promise<WorkerRunCounts> {
  const { now, provider, repository, engineVersion, policyVersion } = deps;
  const counts: WorkerRunCounts = {
    profiles: 0,
    scans: 0,
    signals: 0,
    transitions: 0,
    failures: 0,
  };

  // Provider health BEFORE any profile work, so an initial activation always
  // sees a fresh health row even while every profile is disabled.
  try {
    const health = await provider.health();
    await repository.recordWorkerHealth({
      ok: health.ok,
      code: health.code,
      checkedAt: health.checkedAt,
      providerTime: null,
      quoteAgeMs: null,
      spread: null,
    });
  } catch (error) {
    await recordDegradedHealth(repository, "provider_unavailable", now);
    counts.failures += 1;
    return counts;
  }

  let profiles;
  try {
    profiles = await repository.listEnabledProfiles();
  } catch {
    counts.failures += 1;
    return counts;
  }
  counts.profiles = profiles.length;

  for (const profile of profiles) {
    let enabledStrategyIds: string[];
    try {
      enabledStrategyIds = await repository.listEnabledStrategyIds(profile.userId);
    } catch {
      counts.failures += 1;
      continue;
    }

    // One quote + latest-completed map for the whole profile pass.
    let quote: NativeXauusdQuote;
    let latest: Record<PaperTimeframe, string | null>;
    try {
      quote = await provider.quote();
      latest = await provider.latestCompleted([...PAPER_TIMEFRAMES]);
    } catch (error) {
      await recordDegradedHealth(repository, toSafeCode(error), now);
      counts.failures += 1;
      continue;
    }
    const quoteValidation = validateQuote(quote, now().getTime());

    // Direction-timeframe candles are fetched lazily and shared across every
    // entry scan in this pass.
    const directionCandles = new Map<PaperTimeframe, TwoSidedCandle[]>();

    for (const timeframe of PAPER_TIMEFRAMES) {
      const candleClosedAt = latest[timeframe];
      if (!candleClosedAt) continue;
      const scanFingerprint = await fingerprint([
        profile.userId,
        timeframe,
        candleClosedAt,
        engineVersion,
        policyVersion,
      ]);

      let claim;
      try {
        claim = await repository.claimScan({
          scanFingerprint,
          userId: profile.userId,
          timeframe,
          candleClosedAt,
          scanMode: scanModeFor(timeframe),
          engineVersion,
          policyVersion,
        });
      } catch {
        counts.failures += 1;
        continue;
      }
      if (!claim.claimed) continue; // already scanned on a previous cycle
      counts.scans += 1;

      if (!quoteValidation.ok) {
        await repository.failScan({
          scanRunId: claim.scanRunId,
          code: quoteValidation.code,
          detail: quoteValidation.detail,
        });
        counts.failures += 1;
        continue;
      }

      try {
        const entryCandles = await provider.completedCandles(timeframe, SCAN_CANDLE_COUNT);
        const entryValidation = validateCandles(entryCandles, timeframe);
        if (!entryValidation.ok) {
          await repository.failScan({
            scanRunId: claim.scanRunId,
            code: entryValidation.code,
            detail: entryValidation.detail,
          });
          counts.failures += 1;
          continue;
        }

        // MTF direction candles, only when present.
        const candlesByTimeframe: Partial<Record<PaperTimeframe, TwoSidedCandle[]>> = {
          [timeframe]: entryCandles,
        };
        const mode = scanModeFor(timeframe);
        for (const directionTf of MTF_PLANS[mode].directionTfs) {
          if (directionCandles.has(directionTf)) {
            candlesByTimeframe[directionTf] = directionCandles.get(directionTf);
            continue;
          }
          try {
            const direction = await provider.completedCandles(directionTf, SCAN_CANDLE_COUNT);
            if (direction.length === 0) continue;
            const validation = validateCandles(direction, directionTf);
            if (!validation.ok) continue;
            directionCandles.set(directionTf, direction);
            candlesByTimeframe[directionTf] = direction;
          } catch {
            // Direction data is best-effort; the entry scan proceeds without it.
          }
        }

        const candidates = await scanCompletedTimeframes({
          quote,
          candlesByTimeframe,
          newlyCompleted: [timeframe],
          enabledStrategyIds,
          engineVersion,
          policyVersion,
        });

        const candleClosedAtByTf: Record<PaperTimeframe, string> = {
          M1: "",
          M5: "",
          M15: "",
          M30: "",
          H1: "",
          H4: "",
          D1: "",
        };
        const candlesByTf: Record<PaperTimeframe, TwoSidedCandle[]> = {
          M1: [],
          M5: [],
          M15: [],
          M30: [],
          H1: [],
          H4: [],
          D1: [],
        };
        candleClosedAtByTf[timeframe] = entryCandles.at(-1)!.time;
        candlesByTf[timeframe] = entryCandles;
        for (const [tf, candles] of directionCandles) {
          candleClosedAtByTf[tf] = candles.at(-1)!.time;
          candlesByTf[tf] = candles;
        }

        for (const candidate of candidates) {
          // Spread eligibility is a post-engine gate: a candidate whose
          // observed spread exceeds 10% of its stop distance is ineligible.
          const spreadValidation = validateSpreadForSignal(
            quote,
            candidate.entry,
            candidate.stopLoss,
          );
          if (!spreadValidation.ok) continue;
          const committed = await repository.commitSignal(
            await toCommitInput({
              userId: profile.userId,
              scanRunId: claim.scanRunId,
              scanFingerprint,
              quote,
              candleClosedAtByTf,
              candlesByTf,
              candidate,
              engineVersion,
              policyVersion,
            }),
          );
          if (committed.created) counts.signals += 1;
        }
      } catch (error) {
        await repository.failScan({
          scanRunId: claim.scanRunId,
          code: toSafeCode(error),
          detail: errorMessage(error),
        });
        counts.failures += 1;
      }
    }

    // Advance live trades: replay every completed candle strictly after the
    // saved timestamp, then the current quote as the newest observation.
    let liveTrades: PaperTrade[];
    try {
      liveTrades = await repository.listLiveTrades(profile.userId);
    } catch {
      counts.failures += 1;
      continue;
    }
    const tradesByTimeframe = new Map<PaperTimeframe, PaperTrade[]>();
    for (const trade of liveTrades) {
      const list = tradesByTimeframe.get(trade.timeframe) ?? [];
      list.push(trade);
      tradesByTimeframe.set(trade.timeframe, list);
    }

    for (const [timeframe, trades] of tradesByTimeframe) {
      let history: TwoSidedCandle[];
      try {
        history = await provider.completedCandles(timeframe, ADVANCE_CANDLE_COUNT);
        const validation = validateCandles(history, timeframe);
        if (!validation.ok) {
          counts.failures += 1;
          continue;
        }
      } catch {
        counts.failures += 1;
        continue;
      }
      for (const trade of trades) {
        try {
          const lastObserved = trade.lastObservedAt ?? trade.createdAt;
          const lastObservedMs = Date.parse(lastObserved);
          // If the earliest fetched candle is already AFTER the saved
          // timestamp, unseen prices exist; leave the trade unchanged and
          // record a gap rather than skipping them.
          if (history.length > 0 && Date.parse(history[0].time) > lastObservedMs) {
            counts.failures += 1; // trade_observation_gap
            continue;
          }
          const replay = history.filter((c) => Date.parse(c.time) > lastObservedMs);
          const observations: PaperObservation[] = [
            ...replay.map((c) => ({ kind: "candle" as const, value: c })),
            { kind: "quote" as const, value: quote },
          ];
          for (const observation of observations) {
            const transition = advancePaperTrade(trade, observation, now().getTime());
            if (!transition) continue;
            const applied = await repository.applyTransition({
              tradeId: trade.id,
              expectedState: trade.state,
              expectedVersion: transition.expectedVersion,
              next: transition.next,
              event: transition.event,
            });
            if (applied) {
              counts.transitions += 1;
              Object.assign(trade, transition.next);
            }
          }
        } catch {
          counts.failures += 1;
        }
      }
    }
  }

  return counts;
}

async function recordDegradedHealth(
  repository: PaperWorkerRepository,
  code: string,
  now: () => Date,
): Promise<void> {
  try {
    await repository.recordWorkerHealth({
      ok: false,
      code,
      checkedAt: now().toISOString(),
      providerTime: null,
      quoteAgeMs: null,
      spread: null,
    });
  } catch {
    // Health recording must never crash the cycle.
  }
}
