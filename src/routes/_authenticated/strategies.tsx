import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getEngineStrategyCapability } from "@/lib/signal-engine";
import { MARKET_PAIRS, MARKET_TIMEFRAMES } from "@/lib/market-data.server";
import {
  getStrategyDetail,
  getStrategyLeague,
  type StrategyDetail,
  type StrategyLeague,
  type StrategyLeagueRow,
} from "@/lib/signals.functions";
import { getXauusdPaperStrategyHealth } from "@/lib/xauusd-paper.functions";
import { formatPhtTimestamp, utcIsoTitle } from "@/lib/pht-time";

type Strategy = {
  id: string;
  name: string;
  category: string;
  description: string;
  timeframes: string[];
};

export const Route = createFileRoute("/_authenticated/strategies")({
  head: () => ({
    meta: [
      { title: "Strategies — MDTAlphaFX" },
      { name: "description", content: "Enable, disable, and tune the 28 confluence strategies." },
      { property: "og:title", content: "Strategies — MDTAlphaFX" },
      {
        property: "og:description",
        content: "Enable, disable, and tune the 28 confluence strategies.",
      },
    ],
  }),
  component: Strategies,
});

// ---------------------------------------------------------------------------
// Effective-weight sparklines — one 60s point per league poll, up to 60 points
// (a full hour), persisted to localStorage so the series survives navigation.
// ---------------------------------------------------------------------------

const WEIGHT_HISTORY_KEY = "mdtalpha-league-weight-history";
type HistoryPoint = { t: number; eff: number };

let historyCache: Map<string, HistoryPoint[]> | null = null;

function getWeightHistory(): Map<string, HistoryPoint[]> {
  if (historyCache) return historyCache;
  let map = new Map<string, HistoryPoint[]>();
  try {
    const raw = localStorage.getItem(WEIGHT_HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        map = new Map(Object.entries(parsed as Record<string, HistoryPoint[]>));
      }
    }
  } catch {
    // storage unavailable — history just won't persist across reloads
  }
  historyCache = map;
  return map;
}

function persistWeightHistory() {
  if (!historyCache) return;
  try {
    localStorage.setItem(WEIGHT_HISTORY_KEY, JSON.stringify(Object.fromEntries(historyCache)));
  } catch {
    // ignore
  }
}

function recordWeight(key: string, eff: number) {
  const map = getWeightHistory();
  const series = map.get(key) ?? [];
  const last = series.at(-1);
  // Only record a new point when the value moved or the poll ticked over, so
  // a flat market doesn't produce 60 identical dots per minute.
  if (!last || Date.now() - last.t > 45_000 || Math.abs(last.eff - eff) > 1e-6) {
    series.push({ t: Date.now(), eff });
  }
  while (series.length > 60) series.shift();
  map.set(key, series);
  persistWeightHistory();
}

function Sparkline({ series }: { series: HistoryPoint[] }) {
  const width = 44;
  const height = 14;
  if (series.length === 0) return <span className="text-muted-foreground">…</span>;
  const values = series.map((point) => point.eff);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const rising = values.at(-1)! >= values[0];
  const color = rising ? "text-neon-long" : "text-neon-short";
  // Single point: a dot — the line needs at least two polls to form.
  if (series.length === 1) {
    return (
      <svg
        width={width}
        height={height}
        className={color}
        aria-label="Effective weight over the last hour"
      >
        <circle cx={width / 2} cy={height / 2} r={2} fill="currentColor" />
      </svg>
    );
  }
  const points = series
    .map(
      (point, index) =>
        `${((index / (series.length - 1)) * width).toFixed(1)},${(
          height -
          ((point.eff - min) / range) * height
        ).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={color}
      aria-label="Effective weight over the last hour"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function StrategyLeague({
  pair,
  timeframe,
  onPair,
  onTimeframe,
  data,
  loading,
  names,
  selected,
  onSelect,
  auditMode,
  onAuditMode,
}: {
  pair: string;
  timeframe: (typeof MARKET_TIMEFRAMES)[number];
  onPair: (p: string) => void;
  onTimeframe: (tf: (typeof MARKET_TIMEFRAMES)[number]) => void;
  data: StrategyLeague | undefined;
  loading: boolean;
  names: Map<string, string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  auditMode: boolean;
  onAuditMode: (on: boolean) => void;
}) {
  // The 3 engine strategies not yet in the live catalog (until the strategy
  // migration runs) get readable display names.
  const ENGINE_ONLY_NAMES: Record<string, string> = {
    opening_range_breakout: "Opening Range Breakout",
    heiken_ashi_scalp: "Heiken Ashi Scalp",
    qullamaggie_breakout: "Qullamaggie Breakout",
  };
  const statusMeta: Record<StrategyLeagueRow["status"], { label: string; cls: string }> = {
    boost: { label: "BOOST", cls: "border-neon-long/40 bg-neon-long/10 text-neon-long" },
    cool: { label: "COOL", cls: "border-neon-short/40 bg-neon-short/10 text-neon-short" },
    excluded: { label: "EXCLUDED", cls: "border-neon-short/60 bg-neon-short/15 text-neon-short" },
    low: { label: "LOW_WEIGHT", cls: "border-neon-warn/40 bg-neon-warn/10 text-neon-warn" },
    insufficient: { label: "SAMPLE<3", cls: "border-cyber-border text-muted-foreground" },
    neutral: { label: "NEUTRAL", cls: "border-cyber-border text-muted-foreground" },
  };
  const mode =
    data?.mode ??
    (timeframe === "M1" || timeframe === "M5" || timeframe === "M15" || timeframe === "M30"
      ? "scalper"
      : "intraday");

  // Record each strategy's effective weight when a fresh league poll lands, so
  // the 1H sparklines show the learning loop shifting trust in real time. The
  // tick forces a re-render so the freshly recorded point is visible at once.
  const [, setHistoryTick] = useState(0);
  useEffect(() => {
    if (!data) return;
    for (const row of data.rows) {
      recordWeight(`${data.pair}|${data.timeframe}|${row.strategyId}`, row.effectiveWeight);
    }
    setHistoryTick((tick) => tick + 1);
  }, [data]);

  return (
    <section className="rounded-lg border border-cyber-border bg-cyber-surface">
      <div className="px-4 py-3 border-b border-cyber-border flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
            // STRATEGY_LEAGUE · LIVE WALK-FORWARD + SELF-LEARNING
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Every strategy scored on real {pair} candles with the learning multipliers applied —
            effective weight is exactly how loudly it votes on the next scan.
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={pair}
            onChange={(e) => onPair(e.target.value)}
            aria-label="League pair"
            className="rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1 text-[10px] font-mono text-white focus:border-neon-accent/50 focus:outline-none transition"
          >
            {MARKET_PAIRS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <div
            className="flex rounded-sm border border-cyber-border bg-cyber-bg p-0.5"
            role="radiogroup"
            aria-label="League timeframe"
          >
            {MARKET_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                role="radio"
                aria-checked={timeframe === tf}
                onClick={() => onTimeframe(tf)}
                className={`rounded-sm px-1.5 py-1 text-[9px] font-mono transition ${
                  timeframe === tf
                    ? "bg-neon-accent/10 text-neon-accent"
                    : "text-muted-foreground hover:text-white"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
          <span
            className={`rounded-sm border px-2 py-1 text-[9px] font-mono uppercase ${
              mode === "scalper"
                ? "border-neon-warn/40 text-neon-warn"
                : "border-neon-accent/40 text-neon-accent"
            }`}
          >
            {mode}
          </span>
          <button
            type="button"
            onClick={() => onAuditMode(!auditMode)}
            aria-pressed={auditMode}
            title="Pause the self-learning multipliers and compare pure walk-forward weights against the effective weights"
            className={`rounded-sm border px-2 py-1 text-[9px] font-mono uppercase transition ${
              auditMode
                ? "border-neon-warn/60 bg-neon-warn/15 text-neon-warn"
                : "border-cyber-border bg-cyber-bg text-muted-foreground hover:text-white"
            }`}
          >
            {auditMode ? "AUDIT_ON" : "SELF_TUNING_AUDIT"}
          </button>
          {!loading && data && (
            <span className="text-[9px] font-mono text-muted-foreground">
              {data.active}/{data.total} ACTIVE · {data.excluded} EXCLUDED
            </span>
          )}
        </div>
      </div>

      {auditMode && (
        <div className="border-b border-cyber-border bg-neon-warn/5 px-4 py-2 font-mono text-[9px] text-neon-warn">
          AUDIT_MODE · learning multipliers paused for inspection — WALK is the pure walk-forward
          weight, EFF is what the engine would use with self-learning, Δ is exactly how much the
          loop is changing each vote.
        </div>
      )}

      {loading && (
        <div className="p-4 text-sm text-muted-foreground">
          Scoring {pair} {timeframe}…
        </div>
      )}
      {!loading && !data && (
        <div className="p-4 text-sm text-muted-foreground">
          League unavailable — live feed or account error. Retrying in 60s.
        </div>
      )}
      {!loading && data && (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[10px]">
            <thead>
              <tr className="text-left text-[9px] uppercase tracking-widest text-muted-foreground border-b border-cyber-border">
                <th className="px-3 py-2">Strategy</th>
                <th className="px-2 py-2 text-right">Votes</th>
                <th className="px-2 py-2 text-right">Wins</th>
                <th className="px-2 py-2 text-right">Acc%</th>
                <th className="px-2 py-2 text-right">Walk</th>
                <th className="px-2 py-2 text-right">Learn</th>
                <th className="px-2 py-2 text-right">Eff</th>
                <th
                  className="px-2 py-2 text-center"
                  title="Effective weight over the last hour (60s polls)"
                >
                  1H
                </th>
                {auditMode && <th className="px-2 py-2 text-right">Δ</th>}
                <th className="px-3 py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cyber-border">
              {data.rows.map((row) => {
                const meta = statusMeta[row.status];
                const name =
                  names.get(row.strategyId) ?? ENGINE_ONLY_NAMES[row.strategyId] ?? row.strategyId;
                const historyKey = `${data.pair}|${data.timeframe}|${row.strategyId}`;
                const series = getWeightHistory().get(historyKey) ?? [];
                const delta = +(row.effectiveWeight - row.walkWeight).toFixed(2);
                return (
                  <tr
                    key={row.strategyId}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelect(selected === row.strategyId ? null : row.strategyId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(selected === row.strategyId ? null : row.strategyId);
                      }
                    }}
                    aria-expanded={selected === row.strategyId}
                    title="Click to drill into this strategy"
                    className={`cursor-pointer transition ${
                      selected === row.strategyId ? "bg-neon-accent/10" : "hover:bg-cyber-surface-2"
                    }`}
                  >
                    <td className="px-3 py-1.5">
                      <span className="text-white">{name}</span>
                      <span className="ml-1.5 text-[8px] text-muted-foreground">
                        {row.strategyId}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">{row.votes}</td>
                    <td className="px-2 py-1.5 text-right text-muted-foreground">{row.wins}</td>
                    <td
                      className={`px-2 py-1.5 text-right ${row.accuracy == null ? "text-muted-foreground" : row.accuracy >= 0.6 ? "text-neon-long" : row.accuracy <= 0.4 ? "text-neon-short" : "text-white"}`}
                    >
                      {row.accuracy == null ? "—" : Math.round(row.accuracy * 100)}
                    </td>
                    <td className="px-2 py-1.5 text-right text-white">
                      {row.walkWeight.toFixed(2)}
                    </td>
                    <td
                      className={`px-2 py-1.5 text-right ${auditMode ? "text-muted-foreground" : row.learnedMultiplier === 1 ? "text-muted-foreground" : row.learnedMultiplier > 1 ? "text-neon-long" : "text-neon-short"}`}
                    >
                      {auditMode
                        ? `×${row.learnedMultiplier.toFixed(2)} ⏸`
                        : row.learnedMultiplier === 1
                          ? "×1.00"
                          : `×${row.learnedMultiplier.toFixed(2)}`}
                      {row.learnedResolved > 0 && (
                        <span className="ml-1 text-[8px] text-muted-foreground">
                          ({row.learnedWins}/{row.learnedResolved})
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <span
                        className={`font-bold ${row.effectiveWeight >= 0.6 ? "text-neon-long" : row.effectiveWeight < 0.35 ? "text-neon-short" : "text-white"}`}
                      >
                        {row.effectiveWeight.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <Sparkline series={series} />
                    </td>
                    {auditMode && (
                      <td
                        className={`px-2 py-1.5 text-right font-mono ${
                          delta > 0.001
                            ? "text-neon-long"
                            : delta < -0.001
                              ? "text-neon-short"
                              : "text-muted-foreground"
                        }`}
                      >
                        {delta > 0 ? "+" : ""}
                        {delta.toFixed(2)}
                      </td>
                    )}
                    <td className="px-3 py-1.5 text-right">
                      <span
                        className={`inline-block rounded-sm border px-1.5 py-0.5 text-[8px] uppercase ${meta.cls}`}
                      >
                        {meta.label}
                        {row.status !== "neutral" &&
                        row.status !== "insufficient" &&
                        row.learnedMultiplier !== 1
                          ? ` ×${row.learnedMultiplier.toFixed(2)}`
                          : ""}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// StrategyDetailPanel — the drill-in card for a clicked league row: what the
// strategy is, its walk-forward verdict on the selected pair/TF, its learning
// record in BOTH modes, and the last 5 signals it contributed to.
// ---------------------------------------------------------------------------

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  boost: { label: "BOOST", cls: "border-neon-long/40 bg-neon-long/10 text-neon-long" },
  cool: { label: "COOL", cls: "border-neon-short/40 bg-neon-short/10 text-neon-short" },
  hold: { label: "HOLD", cls: "border-cyber-border text-muted-foreground" },
  insufficient: { label: "SAMPLE<3", cls: "border-cyber-border text-muted-foreground" },
  hit_tp2: { label: "TP2 +2.0R", cls: "border-neon-long/40 bg-neon-long/10 text-neon-long" },
  hit_tp1: {
    label: "BE after TP1",
    cls: "border-muted-foreground/30 bg-muted/20 text-muted-foreground",
  },
  hit_sl: { label: "SL −1.0R", cls: "border-neon-short/50 bg-neon-short/10 text-neon-short" },
  invalidated: { label: "STALE", cls: "border-cyber-border text-muted-foreground" },
  fresh: { label: "FRESH", cls: "border-neon-accent/40 text-neon-accent" },
  valid: { label: "VALID", cls: "border-neon-accent/30 text-neon-accent" },
  late: { label: "LATE", cls: "border-neon-warn/40 text-neon-warn" },
};

function StatusChip({ status }: { status: string }) {
  const meta = STATUS_CHIP[status] ?? {
    label: status.toUpperCase(),
    cls: "border-cyber-border text-muted-foreground",
  };
  return (
    <span
      className={`inline-block rounded-sm border px-1.5 py-0.5 text-[8px] font-mono uppercase ${meta.cls}`}
    >
      {meta.label}
    </span>
  );
}

function LearningBlock({
  title,
  entry,
}: {
  title: string;
  entry: StrategyDetail["learning"]["intraday"];
}) {
  if (!entry) {
    return (
      <div className="rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2">
        <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
          {title}
        </div>
        <div className="mt-1 text-[10px] font-mono text-muted-foreground">
          No resolved outcomes for this mode yet — trust is neutral ×1.00.
        </div>
      </div>
    );
  }
  const winRate = entry.resolved ? Math.round((entry.wins / entry.resolved) * 100) : 0;
  return (
    <div className="rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
          {title}
        </div>
        <StatusChip status={entry.verdict} />
      </div>
      <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-[10px]">
        <div>
          <div className="text-[8px] uppercase text-muted-foreground">RECORD</div>
          <div className="text-white">
            {entry.wins}W/{entry.losses}L
          </div>
        </div>
        <div>
          <div className="text-[8px] uppercase text-muted-foreground">WIN%</div>
          <div
            className={
              winRate >= 60 ? "text-neon-long" : winRate <= 40 ? "text-neon-short" : "text-white"
            }
          >
            {winRate}%
          </div>
        </div>
        <div>
          <div className="text-[8px] uppercase text-muted-foreground">TOTAL_R</div>
          <div className={entry.totalR >= 0 ? "text-neon-long" : "text-neon-short"}>
            {entry.totalR >= 0 ? "+" : ""}
            {entry.totalR.toFixed(1)}R
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="font-mono text-[10px] text-white">
          {entry.excluded ? "EXCLUDED ×0.30" : `multiplier ×${entry.multiplier.toFixed(2)}`}
        </span>
        {entry.excluded && <StatusChip status="excluded" />}
      </div>
    </div>
  );
}

function StrategyDetailPanel({
  detail,
  loading,
  error,
  pair,
  timeframe,
  onClose,
}: {
  detail: StrategyDetail | undefined;
  loading: boolean;
  error: boolean;
  pair: string;
  timeframe: string;
  onClose: () => void;
}) {
  return (
    <section className="rounded-lg border border-neon-accent/30 bg-cyber-surface animate-fade-up">
      <div className="px-4 py-3 border-b border-cyber-border flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
            // STRATEGY_DETAIL
          </div>
          <div className="mt-0.5 flex items-center gap-2 flex-wrap">
            <span className="text-base font-bold text-white">
              {detail ? (detail.name ?? "—") : "Loading…"}
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">{detail?.strategyId}</span>
            <span className="text-[10px] font-mono text-muted-foreground">
              {pair} · {timeframe}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm border border-cyber-border px-2 py-1 text-[10px] font-mono text-muted-foreground hover:text-white transition"
        >
          CLOSE ✕
        </button>
      </div>

      {loading && <div className="p-4 text-sm text-muted-foreground">Loading strategy detail…</div>}
      {!loading && error && (
        <div className="p-4 text-sm font-mono text-neon-warn">
          STRATEGY_DETAIL_UNAVAILABLE — feed or account error.
        </div>
      )}
      {!loading && !error && detail && (
        <div className="p-4 space-y-4">
          <div>
            <p className="text-xs text-muted-foreground">{detail.description}</p>
            <div className="mt-2 flex gap-1 flex-wrap">
              {detail.timeframes.map((tf) => (
                <span
                  key={tf}
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyber-border text-muted-foreground"
                >
                  {tf}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
                WALK-FORWARD · {pair} {timeframe}
              </div>
              {detail.walk ? (
                <div className="mt-1 grid grid-cols-2 gap-2 font-mono text-[10px]">
                  <div>
                    <div className="text-[8px] uppercase text-muted-foreground">VOTES</div>
                    <div className="text-white">{detail.walk.votes}</div>
                  </div>
                  <div>
                    <div className="text-[8px] uppercase text-muted-foreground">WINS</div>
                    <div className="text-white">{detail.walk.wins}</div>
                  </div>
                  <div>
                    <div className="text-[8px] uppercase text-muted-foreground">ACC%</div>
                    <div
                      className={
                        detail.walk.accuracy == null
                          ? "text-muted-foreground"
                          : detail.walk.accuracy >= 0.6
                            ? "text-neon-long"
                            : "text-neon-short"
                      }
                    >
                      {detail.walk.accuracy == null
                        ? "—"
                        : `${Math.round(detail.walk.accuracy * 100)}%`}
                    </div>
                  </div>
                  <div>
                    <div className="text-[8px] uppercase text-muted-foreground">WEIGHT</div>
                    <div className="text-white">
                      {detail.walk.weight.toFixed(2)}
                      {detail.walk.downweighted && (
                        <span className="ml-1 text-neon-short">DOWN</span>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mt-1 text-[10px] font-mono text-muted-foreground">—</div>
              )}
            </div>
            <LearningBlock title="SELF-LEARNING · INTRADAY" entry={detail.learning.intraday} />
            <LearningBlock title="SELF-LEARNING · SCALPER" entry={detail.learning.scalper} />
          </div>

          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent mb-1.5">
              LAST 5 SIGNALS IT CONTRIBUTED TO
            </div>
            {detail.recentSignals.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">
                This strategy has not contributed to a stored signal yet.
              </div>
            ) : (
              <div className="divide-y divide-cyber-border rounded-sm border border-cyber-border">
                {detail.recentSignals.map((signal) => (
                  <div
                    key={signal.id}
                    className="flex items-center gap-2 px-3 py-1.5 font-mono text-[10px] flex-wrap"
                  >
                    <span className="font-bold text-white">{signal.pair}</span>
                    <span
                      className={signal.direction === "long" ? "text-neon-long" : "text-neon-short"}
                    >
                      {signal.direction.toUpperCase()}
                    </span>
                    <span className="text-muted-foreground">
                      {signal.mode} · {signal.timeframe}
                    </span>
                    <span className="text-neon-accent">{signal.confluence}%</span>
                    <StatusChip status={signal.status} />
                    <span
                      className="ml-auto text-muted-foreground"
                      title={`UTC ${utcIsoTitle(signal.created_at)}`}
                    >
                      {formatPhtTimestamp(signal.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Strategies() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [leaguePair, setLeaguePair] = useState("XAUUSD");
  const [leagueTf, setLeagueTf] = useState<(typeof MARKET_TIMEFRAMES)[number]>("H1");
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [auditMode, setAuditMode] = useState(false);

  const leagueFn = useServerFn(getStrategyLeague);
  const league = useQuery({
    queryKey: ["strategy-league", leaguePair, leagueTf],
    queryFn: () => leagueFn({ data: { pair: leaguePair, timeframe: leagueTf } }),
    refetchInterval: 60_000,
    retry: false,
  });

  const detailFn = useServerFn(getStrategyDetail);
  const detail = useQuery({
    queryKey: ["strategy-detail", selectedStrategy, leaguePair, leagueTf],
    queryFn: () =>
      detailFn({ data: { strategyId: selectedStrategy!, pair: leaguePair, timeframe: leagueTf } }),
    enabled: selectedStrategy != null,
    retry: false,
  });

  useEffect(() => {
    (async () => {
      const { data: user } = await supabase.auth.getUser();
      const uid = user.user!.id;
      const [{ data: strats }, { data: sets }] = await Promise.all([
        supabase
          .from("strategies")
          .select("id,name,category,description,timeframes")
          .order("category"),
        supabase.from("strategy_settings").select("strategy_id, enabled").eq("user_id", uid),
      ]);
      setStrategies((strats ?? []) as Strategy[]);
      const map: Record<string, boolean> = {};
      (strats ?? []).forEach((s) => {
        map[s.id] = true;
      });
      (sets ?? []).forEach((s) => {
        map[s.strategy_id] = s.enabled;
      });
      setEnabled(map);
      setLoading(false);
    })();
  }, []);

  async function toggle(id: string) {
    if (!getEngineStrategyCapability(id).implemented) return;
    const next = !enabled[id];
    setEnabled((e) => ({ ...e, [id]: next }));
    const { data: user } = await supabase.auth.getUser();
    const uid = user.user!.id;
    const { error } = await supabase
      .from("strategy_settings")
      .upsert(
        { user_id: uid, strategy_id: id, enabled: next },
        { onConflict: "user_id,strategy_id" },
      );
    if (error) toast.error(error.message);
  }

  const grouped = strategies.reduce<Record<string, Strategy[]>>((a, s) => {
    (a[s.category] ??= []).push(s);
    return a;
  }, {});
  const engineReadyCount = strategies.filter(
    (strategy) => getEngineStrategyCapability(strategy.id).implemented,
  ).length;
  const enabledCount = strategies.filter(
    (strategy) => getEngineStrategyCapability(strategy.id).implemented && enabled[strategy.id],
  ).length;

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // STRATEGY_MATRIX
        </div>
        <h1 className="text-2xl font-bold text-white">
          Strategies <span className="text-neon-accent">{enabledCount}</span>
          <span className="text-muted-foreground">/{engineReadyCount} engine-ready</span>
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every strategy is evaluated (candles for most, the macro calendar/COT overlay for the news
          and AI-confluence entries). Trust weights — walk-forward accuracy plus the self-learning
          loop — decide how loudly each one votes on any given scan.
        </p>
      </header>

      <StrategyLeague
        pair={leaguePair}
        timeframe={leagueTf}
        onPair={setLeaguePair}
        onTimeframe={setLeagueTf}
        data={league.data}
        loading={league.isLoading}
        names={new Map(strategies.map((s) => [s.id, s.name]))}
        selected={selectedStrategy}
        onSelect={setSelectedStrategy}
        auditMode={auditMode}
        onAuditMode={setAuditMode}
      />

      <PaperLedgerHealth />

      {selectedStrategy && (
        <StrategyDetailPanel
          detail={detail.data}
          loading={detail.isLoading}
          error={detail.isError}
          pair={leaguePair}
          timeframe={leagueTf}
          onClose={() => setSelectedStrategy(null)}
        />
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {Object.entries(grouped).map(([cat, list]) => (
        <section key={cat}>
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-neon-accent mb-2">
            // {cat.replace("_", " ")}
          </h2>
          <div className="grid gap-2 md:grid-cols-2">
            {list.map((s) => {
              const capability = getEngineStrategyCapability(s.id);
              const active = capability.implemented && enabled[s.id];
              const timeframes = capability.implemented ? capability.timeframes : s.timeframes;
              return (
                <label
                  key={s.id}
                  className={`flex items-start gap-3 rounded-sm border p-3 transition ${
                    active
                      ? "cursor-pointer border-neon-accent/40 bg-neon-accent/5"
                      : capability.implemented
                        ? "cursor-pointer border-cyber-border bg-cyber-surface hover:border-cyber-border"
                        : "cursor-not-allowed border-cyber-border bg-cyber-bg opacity-60"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    disabled={!capability.implemented}
                    onChange={() => toggle(s.id)}
                    className="mt-0.5 accent-neon-accent"
                  />
                  <div className="flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-bold text-white">{s.name}</div>
                      <span
                        className={`rounded-sm border px-1.5 py-0.5 font-mono text-[8px] ${
                          capability.implemented
                            ? "border-neon-long/30 bg-neon-long/5 text-neon-long"
                            : "border-neon-warn/30 bg-neon-warn/5 text-neon-warn"
                        }`}
                      >
                        {capability.implemented ? "ENGINE_READY" : "CATALOG_ONLY"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {capability.description ?? s.description}
                    </div>
                    <div className="mt-1 flex gap-1 flex-wrap">
                      {timeframes.map((t) => (
                        <span
                          key={t}
                          className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyber-border text-muted-foreground"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PaperLedgerHealth — the forward-tested scorecard. The league's walk-forward
// view is candle-based and explicitly excludes canonical worker rows; this is
// the ledger's own answer: what the 0.01-lot paper account actually did with
// each contributing strategy, with the 20-resolved-trade sample floor shown.
// ---------------------------------------------------------------------------

function PaperLedgerHealth() {
  const healthFn = useServerFn(getXauusdPaperStrategyHealth);
  const health = useQuery({
    queryKey: ["paper-strategy-health"],
    queryFn: () => healthFn(),
    refetchInterval: 60_000,
    retry: false,
  });
  const report = health.data;

  return (
    <section className="rounded-lg border border-cyber-border bg-cyber-surface">
      <div className="px-4 py-3 border-b border-cyber-border flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
            // PAPER_LEDGER_HEALTH
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            The 0.01-lot paper account's resolved record per contributing strategy — wins, BE
            scratches, losses, R. A rate below{" "}
            <span className="text-white">20 resolved trades</span> is noise, not a verdict.
          </div>
        </div>
        {report && (
          <span className="rounded-sm border border-cyber-border px-2 py-1 font-mono text-[9px] text-muted-foreground">
            {report.resolvedTotal} RESOLVED TRADES
          </span>
        )}
      </div>

      {health.isLoading && !report && (
        <div className="p-4 font-mono text-[10px] text-muted-foreground">LOADING LEDGER…</div>
      )}
      {health.isError && (
        <div className="p-4 font-mono text-[10px] text-neon-warn">
          LEDGER_UNAVAILABLE — {health.error instanceof Error ? health.error.message : "error"}
        </div>
      )}
      {report && report.strategies.length === 0 && (
        <div className="p-4 font-mono text-[10px] text-muted-foreground">
          No resolved paper trades yet. The Auto-Paper worker generates XAUUSD signals unattended —
          enable it from the Dashboard, then this table fills with what the engine actually did.
        </div>
      )}
      {report && report.strategies.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[10px]">
            <thead>
              <tr className="text-left text-[9px] uppercase tracking-widest text-muted-foreground border-b border-cyber-border">
                <th className="px-3 py-2">Strategy</th>
                <th className="px-2 py-2 text-right">Sig</th>
                <th className="px-2 py-2 text-right">Res</th>
                <th className="px-2 py-2 text-right">W</th>
                <th className="px-2 py-2 text-right">BE</th>
                <th className="px-2 py-2 text-right">L</th>
                <th className="px-2 py-2 text-right">Win%</th>
                <th className="px-2 py-2 text-right">TotalR</th>
                <th className="px-2 py-2 text-right">ExpR</th>
                <th className="px-3 py-2 text-right">Floor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cyber-border">
              {report.strategies.map((row) => (
                <tr key={row.strategyId} className="hover:bg-cyber-surface-2">
                  <td className="px-3 py-1.5">
                    <span className="text-white">{row.strategyId}</span>
                    {row.byMode.scalper != null && row.byMode.scalper.resolved > 0 && (
                      <span className="ml-1.5 text-[8px] text-muted-foreground">
                        {row.byMode.scalper.signals} scalper
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground">{row.signals}</td>
                  <td className="px-2 py-1.5 text-right text-white">{row.resolved}</td>
                  <td className="px-2 py-1.5 text-right text-neon-long">{row.wins}</td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground">{row.scratches}</td>
                  <td className="px-2 py-1.5 text-right text-neon-short">{row.losses}</td>
                  <td
                    className={`px-2 py-1.5 text-right ${
                      row.winRate == null
                        ? "text-muted-foreground"
                        : row.winRate >= 50
                          ? "text-neon-long"
                          : "text-neon-warn"
                    }`}
                  >
                    {row.winRate == null ? "—" : `${Math.round(row.winRate)}%`}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right font-bold ${
                      row.totalR > 0 ? "text-neon-long" : row.totalR < 0 ? "text-neon-short" : "text-white"
                    }`}
                  >
                    {row.totalR > 0 ? "+" : ""}
                    {row.totalR.toFixed(1)}
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted-foreground">
                    {row.expectancyR == null ? "—" : `${row.expectancyR > 0 ? "+" : ""}${row.expectancyR.toFixed(2)}R`}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {row.sampleOk ? (
                      <span className="rounded-sm border border-neon-long/30 bg-neon-long/5 px-1.5 py-0.5 text-[8px] text-neon-long">
                        ≥20 ✓
                      </span>
                    ) : (
                      <span className="rounded-sm border border-neon-warn/30 bg-neon-warn/5 px-1.5 py-0.5 text-[8px] text-neon-warn">
                        SAMPLE&lt;20
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <WalkForwardAuditRuns />
    </section>
  );
}

/** Latest weekly walk-forward audit runs (from the scheduled edge function).
 *  Gracefully reports when the audit job is not deployed yet. */
function WalkForwardAuditRuns() {
  const [runs, setRuns] = useState<WalkForwardAuditRun[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      const { data, error } = await supabase
        .from("strategy_audit_runs")
        .select("run_id, timeframe, segment, strategy_id, resolved, win_rate, total_r, generated_at")
        .eq("user_id", user.user.id)
        .order("generated_at", { ascending: false })
        .limit(60);
      if (cancelled) return;
      if (error) {
        const code = (error as { code?: string }).code ?? "";
        setState(/PGRST2|42P01/.test(code) ? "missing" : "error");
        return;
      }
      setRuns((data ?? []) as WalkForwardAuditRun[]);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "missing") {
    return (
      <div className="border-t border-cyber-border px-4 py-3 font-mono text-[9px] text-muted-foreground">
        // WALK_FORWARD_AUDIT — the weekly job is not deployed yet. Run{" "}
        <span className="text-neon-accent">tools/deploy-strategy-audit.sh --go</span> and the
        weekly scorecards land here.
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="border-t border-cyber-border px-4 py-3 font-mono text-[9px] text-neon-warn">
        // WALK_FORWARD_AUDIT — unavailable
      </div>
    );
  }
  if (state !== "ready" || !runs || runs.length === 0) return null;

  const latestRunAt = new Date(runs[0].generated_at).toISOString();
  const latestByTf = new Map<string, WalkForwardAuditRun[]>();
  for (const run of runs) {
    if (!latestByTf.has(run.timeframe)) latestByTf.set(run.timeframe, []);
    latestByTf.get(run.timeframe)!.push(run);
  }
  return (
    <div className="border-t border-cyber-border px-4 py-3 space-y-2">
      <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        // WALK_FORWARD_AUDIT · {formatPhtTimestamp(latestRunAt)}
      </div>
      {[...latestByTf.entries()].map(([tf, tfRuns]) => {
        const oos = tfRuns
          .filter((r) => r.segment === "out_of_sample")
          .sort((a, b) => b.total_r - a.total_r)
          .slice(0, 5);
        if (oos.length === 0) return null;
        return (
          <div key={tf} className="font-mono text-[9px]">
            <span className="text-neon-accent">{tf} OOS</span>
            <span className="ml-2 text-muted-foreground">
              {oos
                .map(
                  (r) =>
                    `${r.strategy_id} ${r.total_r > 0 ? "+" : ""}${r.total_r.toFixed(1)}R`,
                )
                .join(" · ")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type WalkForwardAuditRun = {
  run_id: string;
  timeframe: string;
  segment: string;
  strategy_id: string;
  resolved: number;
  win_rate: number | null;
  total_r: number;
  generated_at: string;
};
