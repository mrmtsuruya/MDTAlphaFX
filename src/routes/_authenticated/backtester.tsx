import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import {
  runBacktestFn,
  optimizeStrategyFn,
  walkForwardScoreFn,
  runRealBacktestFn,
} from "@/lib/backtest.functions";
import { FlaskConical, Play, BarChart3, Wand2, Gauge, ShieldAlert, Radar } from "lucide-react";
import { toast } from "sonner";
import type { RealBacktestReport, SampleStats, SegmentReport } from "@/lib/real-backtest";

export const Route = createFileRoute("/_authenticated/backtester")({
  head: () => ({
    meta: [
      { title: "Backtester — MDTAlphaFX" },
      {
        name: "description",
        content: "MT5-style backtester with Monte Carlo and strategy optimization.",
      },
      { property: "og:title", content: "Backtester — MDTAlphaFX" },
      {
        property: "og:description",
        content: "MT5-style backtester with Monte Carlo and strategy optimization.",
      },
    ],
  }),
  component: Backtester,
});

const PAIRS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "USDCHF",
  "EURJPY",
  "GBPJPY",
  "XAUUSD",
  "BTCUSD",
  "ETHUSD",
];
const STRATS = [
  "ema_trend",
  "macd_hist",
  "rsi_meanrev",
  "bollinger_squeeze",
  "donchian_breakout",
  "supertrend",
  "ichimoku",
] as const;

// Walk-forward league can be scored per trader mode: the M5 run uses the
// scalper strategy set + scalper tuning, H1 uses the intraday set + tuning.
const LEAGUE_MODES = [
  { label: "SCALPER · M5", value: "M5" as const },
  { label: "INTRADAY · H1", value: "H1" as const },
];
const PERIODS: Record<string, number> = {
  "Last 30 days (H1)": 720,
  "Last 90 days (H1)": 2160,
  "Last 12 months (H1)": 6000,
  "Last 3 years (H1)": 18000,
};

// Real-data walk-forward backtest: timeframes the live scanner actually
// trades on. M1 is excluded here — Yahoo's 1-minute feed only covers a
// single trading day, never enough bars for a meaningful train/test split.
const REAL_TIMEFRAMES = ["M5", "M15", "M30", "H1", "H4", "D1"] as const;

function Backtester() {
  const [pair, setPair] = useState("EURUSD");
  const [strategy, setStrategy] = useState<(typeof STRATS)[number]>("ema_trend");
  const [period, setPeriod] = useState("Last 90 days (H1)");
  const [sims, setSims] = useState(500);
  const [params, setParams] = useState<Record<string, number> | undefined>(undefined);
  const [leagueMode, setLeagueMode] = useState<(typeof LEAGUE_MODES)[number]["value"]>("H1");
  const [realTimeframe, setRealTimeframe] = useState<(typeof REAL_TIMEFRAMES)[number]>("H1");

  const runFn = useServerFn(runBacktestFn);
  const optFn = useServerFn(optimizeStrategyFn);
  const walkFn = useServerFn(walkForwardScoreFn);
  const realBacktestFn = useServerFn(runRealBacktestFn);

  const run = useMutation({
    mutationFn: () =>
      runFn({
        data: { pair, strategy, bars: PERIODS[period], params, monteCarloSims: sims, ruinR: 10 },
      }),
    onError: (e: Error) => toast.error(e.message),
  });
  const opt = useMutation({
    mutationFn: () => optFn({ data: { pair, strategy, bars: PERIODS[period] } }),
    onSuccess: (r) => toast.success(`Optimizer tested ${r.tested} configurations`),
    onError: (e: Error) => toast.error(e.message),
  });
  const walk = useMutation({
    mutationFn: (timeframe: "M5" | "H1") => walkFn({ data: { pair, timeframe } }),
    onError: (e: Error) => toast.error(e.message),
  });
  const realBacktest = useMutation({
    mutationFn: () => realBacktestFn({ data: { pair, timeframe: realTimeframe } }),
    onError: (e: Error) => toast.error(e.message),
  });

  const result = run.data;

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // BACKTEST_LAB
        </div>
        <h1 className="text-2xl font-bold text-white">Strategy Backtester</h1>
      </header>

      <section className="rounded-lg border border-neon-long/40 bg-neon-long/5 p-4 space-y-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-neon-long">
          <Radar className="size-3.5" />
          REAL_DATA_WALK_FORWARD — live feed, the actual 31-strategy scanner
        </div>
        <p className="text-[11px] text-muted-foreground">
          Runs <code className="text-white">scanCandlesForSignal</code> — the exact engine the live
          scanner uses — bar-by-bar over real candles for the selected pair. Reports in-sample and
          out-of-sample separately; every rate is shown with its trade count so a result on a
          handful of trades can never be mistaken for one on hundreds.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="PAIR">
            <select value={pair} onChange={(e) => setPair(e.target.value)} className={selectCls}>
              {PAIRS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="TIMEFRAME">
            <select
              value={realTimeframe}
              onChange={(e) => setRealTimeframe(e.target.value as (typeof REAL_TIMEFRAMES)[number])}
              className={selectCls}
            >
              {REAL_TIMEFRAMES.map((tf) => (
                <option key={tf}>{tf}</option>
              ))}
            </select>
          </Field>
          <button
            onClick={() => realBacktest.mutate()}
            disabled={realBacktest.isPending}
            className="inline-flex items-center justify-center gap-2 rounded-sm bg-neon-long px-3 py-2 font-mono text-xs font-bold text-cyber-bg hover:brightness-110 disabled:opacity-50"
          >
            <Radar className="size-3" />{" "}
            {realBacktest.isPending ? "SCANNING REAL CANDLES…" : "RUN_REAL_BACKTEST"}
          </button>
        </div>

        {realBacktest.data && <RealBacktestResults report={realBacktest.data} />}
      </section>

      <div className="flex items-center gap-2 rounded-sm border border-neon-warn/40 bg-neon-warn/10 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-neon-warn">
        <ShieldAlert className="size-3.5" />
        Everything below this line (optimizer, Monte Carlo, param sweeps) runs on a SEEDED SYNTHETIC
        RANDOM WALK, not real market data — a sandbox for tuning intuition, not evidence of an edge.
      </div>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <aside className="rounded-lg border border-cyber-border bg-cyber-surface p-4 space-y-3 h-fit">
          <Field label="PAIR">
            <select value={pair} onChange={(e) => setPair(e.target.value)} className={selectCls}>
              {PAIRS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="STRATEGY">
            <select
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value as typeof strategy);
                setParams(undefined);
              }}
              className={selectCls}
            >
              {STRATS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="PERIOD">
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className={selectCls}
            >
              {Object.keys(PERIODS).map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Field>
          <Field label="LEAGUE MODE">
            <div className="mt-1 grid grid-cols-2 gap-1 rounded-sm border border-cyber-border bg-cyber-bg p-0.5">
              {LEAGUE_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setLeagueMode(m.value)}
                  className={`rounded-sm px-2 py-1.5 font-mono text-[10px] transition ${
                    leagueMode === m.value
                      ? m.value === "M5"
                        ? "bg-neon-warn/15 text-neon-warn"
                        : "bg-neon-accent/15 text-neon-accent"
                      : "text-muted-foreground hover:text-white"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label={`MONTE CARLO SIMS — ${sims}`}>
            <input
              type="range"
              min={0}
              max={2000}
              step={100}
              value={sims}
              onChange={(e) => setSims(+e.target.value)}
              className="w-full accent-[--color-neon-accent]"
            />
          </Field>

          {params && (
            <div className="rounded-sm border border-neon-accent/40 bg-neon-accent/5 p-2 font-mono text-[10px] text-neon-accent">
              APPLIED_PARAMS:{" "}
              {Object.entries(params)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")}
              <button onClick={() => setParams(undefined)} className="ml-2 underline">
                reset
              </button>
            </div>
          )}

          <button
            onClick={() => run.mutate()}
            disabled={run.isPending}
            className="w-full inline-flex items-center justify-center gap-2 rounded-sm bg-neon-accent px-3 py-2 font-mono text-xs font-bold text-cyber-bg hover:brightness-110 disabled:opacity-50"
          >
            <Play className="size-3" /> {run.isPending ? "RUNNING…" : "RUN_BACKTEST"}
          </button>
          <button
            onClick={() => opt.mutate()}
            disabled={opt.isPending}
            className="w-full inline-flex items-center justify-center gap-2 rounded-sm border border-neon-warn/40 bg-neon-warn/10 px-3 py-2 font-mono text-xs text-neon-warn hover:bg-neon-warn/20 disabled:opacity-50"
          >
            <Wand2 className="size-3" /> {opt.isPending ? "OPTIMIZING…" : "OPTIMIZE_PARAMS"}
          </button>
          <button
            onClick={() => walk.mutate(leagueMode)}
            disabled={walk.isPending}
            className="w-full inline-flex items-center justify-center gap-2 rounded-sm border border-neon-long/40 bg-neon-long/10 px-3 py-2 font-mono text-xs text-neon-long hover:bg-neon-long/20 disabled:opacity-50"
          >
            <Gauge className="size-3" /> {walk.isPending ? "SCORING…" : "WALK_FORWARD_LEAGUE"}
          </button>
        </aside>

        <section className="space-y-4">
          {!result && (
            <div className="rounded-lg border border-cyber-border bg-cyber-surface p-6 text-center text-muted-foreground py-24">
              <FlaskConical className="size-8 mx-auto mb-3 text-neon-accent" />
              <p className="text-sm">Configure parameters and run a backtest.</p>
            </div>
          )}

          {result && (
            <>
              <div className="grid gap-3 grid-cols-2 md:grid-cols-4 font-mono">
                <Metric label="TRADES" value={result.stats.trades} />
                <Metric label="WIN RATE" value={`${result.stats.winRate}%`} tone="long" />
                <Metric label="PROFIT FACTOR" value={result.stats.profitFactor} tone="accent" />
                <Metric label="MAX DD (R)" value={result.stats.maxDrawdownPct} tone="short" />
                <Metric label="EXPECTANCY" value={`${result.stats.expectancyR}R`} tone="accent" />
                <Metric label="SHARPE" value={result.stats.sharpe} tone="accent" />
                <Metric
                  label="NET PIPS"
                  value={result.stats.netPips}
                  tone={result.stats.netPips >= 0 ? "long" : "short"}
                />
                <Metric label="LOSS STREAK" value={result.stats.longestLossStreak} tone="short" />
              </div>

              <Panel title="// EQUITY_CURVE (R multiples)">
                <Sparkline
                  data={result.equity}
                  color="var(--color-neon-accent, #00d1ff)"
                  height={160}
                />
              </Panel>

              {result.monteCarlo && (
                <Panel title={`// MONTE_CARLO — ${result.monteCarlo.sims} resamples`}>
                  <FanChart curves={result.monteCarlo.curves} />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 font-mono">
                    <Metric label="FINAL R p5" value={result.monteCarlo.finalR.p5} tone="short" />
                    <Metric
                      label="FINAL R median"
                      value={result.monteCarlo.finalR.p50}
                      tone="accent"
                    />
                    <Metric label="FINAL R p95" value={result.monteCarlo.finalR.p95} tone="long" />
                    <Metric
                      label="RISK OF RUIN"
                      value={`${result.monteCarlo.ruinProbability}%`}
                      tone="short"
                    />
                    <Metric label="MAX DD median" value={result.monteCarlo.maxDD.p50} />
                    <Metric label="MAX DD p95" value={result.monteCarlo.maxDD.p95} tone="short" />
                  </div>
                </Panel>
              )}

              <Panel title="// TRADE_LIST (last 200)">
                <div className="max-h-80 overflow-auto">
                  <table className="w-full font-mono text-[11px]">
                    <thead className="sticky top-0 bg-cyber-surface text-muted-foreground">
                      <tr className="text-left">
                        {["#", "DIR", "ENTRY", "SL", "TP", "EXIT", "PIPS", "R", "OUT"].map((h) => (
                          <th
                            key={h}
                            className="px-2 py-1.5 font-normal uppercase tracking-widest text-[10px]"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-cyber-border">
                      {result.trades.map((t) => (
                        <tr key={t.idx} className="hover:bg-cyber-surface-2">
                          <td className="px-2 py-1 text-muted-foreground">{t.idx}</td>
                          <td
                            className={`px-2 py-1 ${t.dir === "long" ? "text-neon-long" : "text-neon-short"}`}
                          >
                            {t.dir.toUpperCase()}
                          </td>
                          <td className="px-2 py-1 text-white">{t.entry}</td>
                          <td className="px-2 py-1 text-neon-short">{t.sl}</td>
                          <td className="px-2 py-1 text-neon-long">{t.tp}</td>
                          <td className="px-2 py-1 text-white">{t.exit}</td>
                          <td
                            className={`px-2 py-1 ${t.pips >= 0 ? "text-neon-long" : "text-neon-short"}`}
                          >
                            {t.pips}
                          </td>
                          <td
                            className={`px-2 py-1 ${t.r >= 0 ? "text-neon-long" : "text-neon-short"}`}
                          >
                            {t.r}
                          </td>
                          <td className="px-2 py-1 text-muted-foreground uppercase">{t.outcome}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          )}

          {walk.data && (
            <Panel
              title={`// WALK_FORWARD — ${walk.data.pair} ${walk.data.timeframe} — real feed, out-of-sample trust weights`}
            >
              <p className="mb-3 text-[11px] text-muted-foreground">
                Each strategy is replayed over the recent real candles; accuracy = how often its
                vote matched the next {walk.data.report.generatedFor.horizon}-bar move. Weights
                below 0.40 (red) are auto-excluded from live signals.
              </p>
              <div className="overflow-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead className="text-muted-foreground text-left">
                    <tr>
                      {["STRATEGY", "VOTES", "WINS", "ACCURACY", "WEIGHT", "VERDICT"].map((h) => (
                        <th
                          key={h}
                          className="px-2 py-1.5 font-normal uppercase tracking-widest text-[10px]"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cyber-border">
                    {walk.data.report.entries
                      .slice()
                      .sort((a, b) => b.weight - a.weight)
                      .map((entry) => (
                        <tr key={entry.strategyId} className="hover:bg-cyber-surface-2">
                          <td className="px-2 py-1 text-white">{entry.strategyId}</td>
                          <td className="px-2 py-1">{entry.votes}</td>
                          <td className="px-2 py-1">{entry.wins}</td>
                          <td
                            className={`px-2 py-1 ${
                              entry.accuracy >= 0.55
                                ? "text-neon-long"
                                : entry.accuracy >= 0.45
                                  ? "text-white"
                                  : "text-neon-short"
                            }`}
                          >
                            {(entry.accuracy * 100).toFixed(0)}%
                          </td>
                          <td className="px-2 py-1 text-neon-accent">{entry.weight.toFixed(2)}</td>
                          <td className="px-2 py-1">
                            {entry.downweighted ? (
                              <span className="text-neon-short">EXCLUDED</span>
                            ) : entry.weight >= 1 ? (
                              <span className="text-neon-long">BOOST</span>
                            ) : (
                              <span className="text-muted-foreground">active</span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {opt.data && (
            <Panel title={`// OPTIMIZER — ${opt.data.tested} configs tested`}>
              <div className="overflow-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead className="text-muted-foreground text-left">
                    <tr>
                      {["RANK", "PARAMS", "TRADES", "WIN%", "PF", "EXPECT.", "SCORE", ""].map(
                        (h) => (
                          <th
                            key={h}
                            className="px-2 py-1.5 font-normal uppercase tracking-widest text-[10px]"
                          >
                            {h}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-cyber-border">
                    {opt.data.top.map((r, i) => (
                      <tr key={i} className="hover:bg-cyber-surface-2">
                        <td className="px-2 py-1 text-neon-accent">#{i + 1}</td>
                        <td className="px-2 py-1 text-white">
                          {Object.entries(r.params)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(" ")}
                        </td>
                        <td className="px-2 py-1">{r.stats.trades}</td>
                        <td className="px-2 py-1 text-neon-long">{r.stats.winRate}%</td>
                        <td className="px-2 py-1">{r.stats.profitFactor}</td>
                        <td className="px-2 py-1">{r.stats.expectancyR}R</td>
                        <td className="px-2 py-1 text-neon-accent">{r.score}</td>
                        <td className="px-2 py-1">
                          <button
                            onClick={() => {
                              setParams(r.params);
                              toast.success("Params applied — run backtest to verify");
                            }}
                            className="rounded-sm border border-neon-accent/40 px-2 py-0.5 text-neon-accent hover:bg-neon-accent/10"
                          >
                            APPLY
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
        </section>
      </div>
    </div>
  );
}

const selectCls =
  "mt-1 w-full rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 text-sm text-white";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[10px] font-mono uppercase text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-cyber-border bg-cyber-surface">
      <div className="px-4 py-2.5 border-b border-cyber-border font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Sparkline({ data, color, height }: { data: number[]; color: string; height: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data),
    max = Math.max(...data);
  const span = max - min || 1;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * 100},${100 - ((v - min) / span) * 100}`)
    .join(" ");
  const zero = 100 - ((0 - min) / span) * 100;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} className="w-full">
      <line
        x1="0"
        x2="100"
        y1={zero}
        y2={zero}
        stroke="currentColor"
        className="text-muted-foreground"
        strokeWidth="0.3"
        strokeDasharray="2 2"
      />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="0.8"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function FanChart({ curves }: { curves: number[][] }) {
  if (!curves.length) return null;
  const all = curves.flat();
  const min = Math.min(...all),
    max = Math.max(...all);
  const span = max - min || 1;
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="w-full"
      style={{ height: 180 }}
    >
      {curves.map((c, i) => (
        <polyline
          key={i}
          points={c
            .map((v, j) => `${(j / (c.length - 1)) * 100},${100 - ((v - min) / span) * 100}`)
            .join(" ")}
          fill="none"
          stroke="var(--color-neon-accent, #00d1ff)"
          strokeOpacity={0.18}
          strokeWidth="0.6"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "long" | "short" | "accent";
}) {
  const c =
    tone === "long"
      ? "text-neon-long"
      : tone === "short"
        ? "text-neon-short"
        : tone === "accent"
          ? "text-neon-accent"
          : "text-white";
  return (
    <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold ${c}`}>{value}</div>
    </div>
  );
}

// Formats a rate that may be null (no resolved evidence) so a fabricated 0%
// is never shown where the honest answer is "no data yet".
function formatRate(value: number | null, suffix = "%") {
  return value === null ? "—" : `${value}${suffix}`;
}

function RealBacktestResults({ report }: { report: RealBacktestReport }) {
  if (!report.sufficientData) {
    return (
      <div className="rounded-sm border border-neon-warn/40 bg-neon-warn/10 p-3 font-mono text-[11px] text-neon-warn">
        {report.insufficiencyReason}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {report.notes.map((note, i) => (
        <div
          key={i}
          className="rounded-sm border border-neon-warn/40 bg-neon-warn/10 p-2 font-mono text-[10px] text-neon-warn"
        >
          {note}
        </div>
      ))}
      <div className="grid gap-3 md:grid-cols-2">
        {report.inSample && <SegmentCard title="IN-SAMPLE (earlier)" segment={report.inSample} />}
        {report.outOfSample && (
          <SegmentCard title="OUT-OF-SAMPLE (held out)" segment={report.outOfSample} />
        )}
      </div>
      <LevelDiagnostics analytics={report.analytics} />
      <p className="font-mono text-[10px] text-muted-foreground">
        {report.completeCandles} complete {report.timeframe} candles · split at bar{" "}
        {report.splitBarIndex} · entries fill at candle close (no historical spread) — see
        real-backtest.ts for full methodology.
      </p>
    </div>
  );
}

/**
 * What the run says about the engine's own stop and target placement.
 *
 * The excursion numbers were being recorded per trade and read by nobody. They
 * answer the two questions the hardcoded 1.25R / 2R levels have never been
 * asked, and they are the most directly actionable output of a backtest.
 */
function LevelDiagnostics({ analytics }: { analytics: RealBacktestReport["analytics"] }) {
  const { excursions, findings, calibration } = analytics;
  const usableBins = calibration.bins.filter((bin) => bin.sufficient);

  return (
    <div className="space-y-2 rounded-sm border border-cyber-border bg-cyber-bg p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        LEVEL DIAGNOSTICS
      </div>

      {findings.map((finding) => (
        <div
          key={finding.id}
          className={`rounded-sm border p-2 text-[11px] leading-snug ${
            finding.severity === "warn"
              ? "border-neon-warn/40 bg-neon-warn/5 text-neon-warn"
              : "border-cyber-border text-muted-foreground"
          }`}
        >
          {finding.message}
        </div>
      ))}

      {excursions.sufficient && (
        <div className="grid grid-cols-2 gap-2 font-mono text-[11px] md:grid-cols-4">
          <Stat label="LOSER MFE p50" value={fmtR(excursions.loserMfe.p50)} />
          <Stat label="LOSER MFE p90" value={fmtR(excursions.loserMfe.p90)} />
          <Stat label="WINNER MAE p50" value={fmtR(excursions.winnerMae.p50)} />
          <Stat label="WINNER MAE p90" value={fmtR(excursions.winnerMae.p90)} />
          <Stat
            label="LOSERS HIT 1R"
            value={
              excursions.losersReaching1R === null
                ? "—"
                : `${Math.round(excursions.losersReaching1R * 100)}%`
            }
          />
          <Stat label="MEDIAN BARS" value={fmtR(excursions.medianBarsHeld, "")} />
          <Stat
            label="WIN / SCRATCH / LOSS"
            value={`${excursions.winners}/${excursions.scratches}/${excursions.losers}`}
          />
          <Stat label="RESOLVED" value={`${excursions.trades}`} />
        </div>
      )}

      {/* The reliability curve, but only where a bucket earned the right to
          report one — a thin bin prints its sample count instead. */}
      <div className="space-y-0.5">
        <div className="font-mono text-[9px] uppercase text-muted-foreground">
          CONFLUENCE CALIBRATION
        </div>
        {calibration.bins.length === 0 ? (
          <div className="font-mono text-[10px] text-muted-foreground">
            No resolved trades to calibrate against yet.
          </div>
        ) : (
          calibration.bins.map((bin) => (
            <div
              key={bin.lower}
              className="flex items-center justify-between font-mono text-[10px]"
            >
              <span className="text-muted-foreground">
                {bin.lower}–{bin.upper}
              </span>
              {bin.sufficient ? (
                <span className="text-white">
                  {Math.round((bin.calibratedRate ?? 0) * 100)}% reached TP2
                  <span className="ml-1 opacity-60">
                    · {bin.avgR !== null && bin.avgR >= 0 ? "+" : ""}
                    {bin.avgR?.toFixed(2)}R · n={bin.resolved}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground opacity-70">
                  n={bin.resolved} — too thin to calibrate
                </span>
              )}
            </div>
          ))
        )}
        {usableBins.length >= 2 && (
          <div className="pt-0.5 font-mono text-[9px] text-muted-foreground">
            {(usableBins.at(-1)!.calibratedRate ?? 0) - (usableBins[0].calibratedRate ?? 0) >= 0.05
              ? "Confluence is discriminating between setups on this run."
              : "Flat across every bucket — confluence is NOT discriminating here."}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtR(value: number | null, suffix = "R") {
  return value === null ? "—" : `${value.toFixed(2)}${suffix}`;
}

function SegmentCard({ title, segment }: { title: string; segment: SegmentReport }) {
  const o = segment.overall;
  return (
    <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3 space-y-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
        <Stat label="TRADES" value={`${o.trades}`} />
        <Stat
          label="WIN RATE"
          value={`${formatRate(o.winRate)} (n=${o.wins + o.losses})`}
          tone={o.winRate == null ? undefined : o.winRate >= 50 ? "long" : "short"}
        />
        <Stat label="TOTAL R" value={`${o.totalR}R`} tone={o.totalR >= 0 ? "long" : "short"} />
        <Stat label="EXPECTANCY" value={o.expectancyR == null ? "—" : `${o.expectancyR}R`} />
        <Stat label="MAX DD" value={`${o.maxDrawdownR}R`} tone="short" />
        <Stat label="OPEN" value={`${o.open}`} />
      </div>
      {segment.byStrategy.length > 0 && (
        <div className="max-h-56 overflow-auto">
          <table className="w-full font-mono text-[10px]">
            <thead className="sticky top-0 bg-cyber-bg text-muted-foreground">
              <tr className="text-left">
                {["STRATEGY", "N", "WIN%", "TOTAL R", "MAX DD"].map((h) => (
                  <th key={h} className="px-1.5 py-1 font-normal uppercase tracking-widest">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-cyber-border">
              {segment.byStrategy.map((entry: SampleStats) => (
                <tr key={entry.label}>
                  <td className="px-1.5 py-1 text-white">{entry.label}</td>
                  <td className="px-1.5 py-1">{entry.trades}</td>
                  <td className="px-1.5 py-1">{formatRate(entry.winRate)}</td>
                  <td
                    className={`px-1.5 py-1 ${entry.totalR >= 0 ? "text-neon-long" : "text-neon-short"}`}
                  >
                    {entry.totalR}
                  </td>
                  <td className="px-1.5 py-1 text-neon-short">{entry.maxDrawdownR}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {segment.byStrategy.length === 0 && (
        <p className="font-mono text-[10px] text-muted-foreground">
          No signals fired in this segment.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "long" | "short" }) {
  const c =
    tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : "text-white";
  return (
    <div>
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className={c}>{value}</div>
    </div>
  );
}
