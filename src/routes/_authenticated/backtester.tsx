import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { runBacktestFn, optimizeStrategyFn } from "@/lib/backtest.functions";
import { FlaskConical, Play, BarChart3, Wand2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/backtester")({
  head: () => ({
    meta: [
      { title: "Backtester — MDTAlphaFX" },
      { name: "description", content: "MT5-style backtester with Monte Carlo and strategy optimization." },
      { property: "og:title", content: "Backtester — MDTAlphaFX" },
      { property: "og:description", content: "MT5-style backtester with Monte Carlo and strategy optimization." },
    ],
  }),
  component: Backtester,
});

const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "NZDUSD", "USDCHF", "EURJPY", "GBPJPY", "XAUUSD"];
const STRATS = ["ema_trend", "macd_hist", "rsi_meanrev", "bollinger_squeeze", "donchian_breakout", "supertrend", "ichimoku"] as const;
const PERIODS: Record<string, number> = { "Last 30 days (H1)": 720, "Last 90 days (H1)": 2160, "Last 12 months (H1)": 6000, "Last 3 years (H1)": 18000 };

function Backtester() {
  const [pair, setPair] = useState("EURUSD");
  const [strategy, setStrategy] = useState<(typeof STRATS)[number]>("ema_trend");
  const [period, setPeriod] = useState("Last 90 days (H1)");
  const [sims, setSims] = useState(500);
  const [params, setParams] = useState<Record<string, number> | undefined>(undefined);

  const runFn = useServerFn(runBacktestFn);
  const optFn = useServerFn(optimizeStrategyFn);

  const run = useMutation({
    mutationFn: () => runFn({ data: { pair, strategy, bars: PERIODS[period], params, monteCarloSims: sims, ruinR: 10 } }),
    onError: (e: Error) => toast.error(e.message),
  });
  const opt = useMutation({
    mutationFn: () => optFn({ data: { pair, strategy, bars: PERIODS[period] } }),
    onSuccess: (r) => toast.success(`Optimizer tested ${r.tested} configurations`),
    onError: (e: Error) => toast.error(e.message),
  });

  const result = run.data;

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// BACKTEST_LAB</div>
        <h1 className="text-2xl font-bold text-white">Strategy Backtester</h1>
      </header>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <aside className="rounded-lg border border-cyber-border bg-cyber-surface p-4 space-y-3 h-fit">
          <Field label="PAIR">
            <select value={pair} onChange={(e) => setPair(e.target.value)} className={selectCls}>
              {PAIRS.map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label="STRATEGY">
            <select value={strategy} onChange={(e) => { setStrategy(e.target.value as typeof strategy); setParams(undefined); }} className={selectCls}>
              {STRATS.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="PERIOD">
            <select value={period} onChange={(e) => setPeriod(e.target.value)} className={selectCls}>
              {Object.keys(PERIODS).map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
          <Field label={`MONTE CARLO SIMS — ${sims}`}>
            <input type="range" min={0} max={2000} step={100} value={sims} onChange={(e) => setSims(+e.target.value)} className="w-full accent-[--color-neon-accent]" />
          </Field>

          {params && (
            <div className="rounded-sm border border-neon-accent/40 bg-neon-accent/5 p-2 font-mono text-[10px] text-neon-accent">
              APPLIED_PARAMS: {Object.entries(params).map(([k, v]) => `${k}=${v}`).join(" ")}
              <button onClick={() => setParams(undefined)} className="ml-2 underline">reset</button>
            </div>
          )}

          <button onClick={() => run.mutate()} disabled={run.isPending} className="w-full inline-flex items-center justify-center gap-2 rounded-sm bg-neon-accent px-3 py-2 font-mono text-xs font-bold text-cyber-bg hover:brightness-110 disabled:opacity-50">
            <Play className="size-3" /> {run.isPending ? "RUNNING…" : "RUN_BACKTEST"}
          </button>
          <button onClick={() => opt.mutate()} disabled={opt.isPending} className="w-full inline-flex items-center justify-center gap-2 rounded-sm border border-neon-warn/40 bg-neon-warn/10 px-3 py-2 font-mono text-xs text-neon-warn hover:bg-neon-warn/20 disabled:opacity-50">
            <Wand2 className="size-3" /> {opt.isPending ? "OPTIMIZING…" : "OPTIMIZE_PARAMS"}
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
                <Metric label="NET PIPS" value={result.stats.netPips} tone={result.stats.netPips >= 0 ? "long" : "short"} />
                <Metric label="LOSS STREAK" value={result.stats.longestLossStreak} tone="short" />
              </div>

              <Panel title="// EQUITY_CURVE (R multiples)">
                <Sparkline data={result.equity} color="var(--color-neon-accent, #00d1ff)" height={160} />
              </Panel>

              {result.monteCarlo && (
                <Panel title={`// MONTE_CARLO — ${result.monteCarlo.sims} resamples`}>
                  <FanChart curves={result.monteCarlo.curves} />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 font-mono">
                    <Metric label="FINAL R p5" value={result.monteCarlo.finalR.p5} tone="short" />
                    <Metric label="FINAL R median" value={result.monteCarlo.finalR.p50} tone="accent" />
                    <Metric label="FINAL R p95" value={result.monteCarlo.finalR.p95} tone="long" />
                    <Metric label="RISK OF RUIN" value={`${result.monteCarlo.ruinProbability}%`} tone="short" />
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
                          <th key={h} className="px-2 py-1.5 font-normal uppercase tracking-widest text-[10px]">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-cyber-border">
                      {result.trades.map((t) => (
                        <tr key={t.idx} className="hover:bg-cyber-surface-2">
                          <td className="px-2 py-1 text-muted-foreground">{t.idx}</td>
                          <td className={`px-2 py-1 ${t.dir === "long" ? "text-neon-long" : "text-neon-short"}`}>{t.dir.toUpperCase()}</td>
                          <td className="px-2 py-1 text-white">{t.entry}</td>
                          <td className="px-2 py-1 text-neon-short">{t.sl}</td>
                          <td className="px-2 py-1 text-neon-long">{t.tp}</td>
                          <td className="px-2 py-1 text-white">{t.exit}</td>
                          <td className={`px-2 py-1 ${t.pips >= 0 ? "text-neon-long" : "text-neon-short"}`}>{t.pips}</td>
                          <td className={`px-2 py-1 ${t.r >= 0 ? "text-neon-long" : "text-neon-short"}`}>{t.r}</td>
                          <td className="px-2 py-1 text-muted-foreground uppercase">{t.outcome}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </>
          )}

          {opt.data && (
            <Panel title={`// OPTIMIZER — ${opt.data.tested} configs tested`}>
              <div className="overflow-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead className="text-muted-foreground text-left">
                    <tr>{["RANK", "PARAMS", "TRADES", "WIN%", "PF", "EXPECT.", "SCORE", ""].map((h) => (
                      <th key={h} className="px-2 py-1.5 font-normal uppercase tracking-widest text-[10px]">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody className="divide-y divide-cyber-border">
                    {opt.data.top.map((r, i) => (
                      <tr key={i} className="hover:bg-cyber-surface-2">
                        <td className="px-2 py-1 text-neon-accent">#{i + 1}</td>
                        <td className="px-2 py-1 text-white">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(" ")}</td>
                        <td className="px-2 py-1">{r.stats.trades}</td>
                        <td className="px-2 py-1 text-neon-long">{r.stats.winRate}%</td>
                        <td className="px-2 py-1">{r.stats.profitFactor}</td>
                        <td className="px-2 py-1">{r.stats.expectancyR}R</td>
                        <td className="px-2 py-1 text-neon-accent">{r.score}</td>
                        <td className="px-2 py-1">
                          <button
                            onClick={() => { setParams(r.params); toast.success("Params applied — run backtest to verify"); }}
                            className="rounded-sm border border-neon-accent/40 px-2 py-0.5 text-neon-accent hover:bg-neon-accent/10"
                          >APPLY</button>
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

const selectCls = "mt-1 w-full rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 text-sm text-white";

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
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${100 - ((v - min) / span) * 100}`).join(" ");
  const zero = 100 - ((0 - min) / span) * 100;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }} className="w-full">
      <line x1="0" x2="100" y1={zero} y2={zero} stroke="currentColor" className="text-muted-foreground" strokeWidth="0.3" strokeDasharray="2 2" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function FanChart({ curves }: { curves: number[][] }) {
  if (!curves.length) return null;
  const all = curves.flat();
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full" style={{ height: 180 }}>
      {curves.map((c, i) => (
        <polyline
          key={i}
          points={c.map((v, j) => `${(j / (c.length - 1)) * 100},${100 - ((v - min) / span) * 100}`).join(" ")}
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

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "long" | "short" | "accent" }) {
  const c = tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : tone === "accent" ? "text-neon-accent" : "text-white";
  return (
    <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold ${c}`}>{value}</div>
    </div>
  );
}
