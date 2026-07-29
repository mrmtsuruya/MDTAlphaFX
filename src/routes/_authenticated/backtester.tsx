import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { FlaskConical, Play, BarChart3 } from "lucide-react";

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

function Backtester() {
  const [pair, setPair] = useState("EURUSD");
  const [strategy, setStrategy] = useState("ema_trend");
  const [result, setResult] = useState<any | null>(null);
  const [running, setRunning] = useState(false);

  function run() {
    setRunning(true);
    setTimeout(() => {
      const trades = 120 + Math.floor(Math.random() * 80);
      const wins = Math.floor(trades * (0.5 + Math.random() * 0.15));
      const pf = +(1 + Math.random() * 1.2).toFixed(2);
      setResult({
        trades, wins, losses: trades - wins,
        winRate: Math.round((wins / trades) * 100),
        profitFactor: pf,
        maxDD: +(3 + Math.random() * 8).toFixed(2),
        sharpe: +(0.8 + Math.random() * 1.5).toFixed(2),
        netPips: Math.floor(500 + Math.random() * 3500),
      });
      setRunning(false);
    }, 900);
  }

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// BACKTEST_LAB</div>
          <h1 className="text-2xl font-bold text-white">Strategy Backtester</h1>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <aside className="rounded-lg border border-cyber-border bg-cyber-surface p-4 space-y-3">
          <div>
            <label className="text-[10px] font-mono uppercase text-muted-foreground">PAIR</label>
            <select value={pair} onChange={(e) => setPair(e.target.value)} className="mt-1 w-full rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 text-sm text-white">
              {["EURUSD","GBPUSD","USDJPY","AUDUSD","XAUUSD"].map(p => <option key={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase text-muted-foreground">STRATEGY</label>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className="mt-1 w-full rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 text-sm text-white">
              {["ema_trend","macd_hist","bollinger_squeeze","order_block","fvg","supertrend","ichimoku"].map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase text-muted-foreground">PERIOD</label>
            <select className="mt-1 w-full rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 text-sm text-white">
              {["Last 30 days","Last 90 days","Last 12 months","Last 3 years"].map(p => <option key={p}>{p}</option>)}
            </select>
          </div>
          <button onClick={run} disabled={running} className="w-full inline-flex items-center justify-center gap-2 rounded-sm bg-neon-accent px-3 py-2 font-mono text-xs font-bold text-cyber-bg hover:brightness-110 disabled:opacity-50">
            <Play className="size-3" /> {running ? "RUNNING…" : "RUN_BACKTEST"}
          </button>
          <button className="w-full inline-flex items-center justify-center gap-2 rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2 font-mono text-xs text-white hover:bg-cyber-surface-2">
            <BarChart3 className="size-3" /> MONTE_CARLO (100 sims)
          </button>
          <button className="w-full inline-flex items-center justify-center gap-2 rounded-sm border border-neon-warn/40 bg-neon-warn/10 px-3 py-2 font-mono text-xs text-neon-warn hover:bg-neon-warn/20">
            OPTIMIZE_PARAMS
          </button>
        </aside>

        <section className="rounded-lg border border-cyber-border bg-cyber-surface p-6">
          {!result ? (
            <div className="text-center text-muted-foreground py-24">
              <FlaskConical className="size-8 mx-auto mb-3 text-neon-accent" />
              <p className="text-sm">Configure parameters and run a backtest.</p>
            </div>
          ) : (
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4 font-mono">
              <Metric label="TRADES" value={result.trades} />
              <Metric label="WIN RATE" value={`${result.winRate}%`} tone="long" />
              <Metric label="PROFIT FACTOR" value={result.profitFactor} tone="accent" />
              <Metric label="MAX DD" value={`${result.maxDD}%`} tone="short" />
              <Metric label="SHARPE" value={result.sharpe} tone="accent" />
              <Metric label="WINS" value={result.wins} tone="long" />
              <Metric label="LOSSES" value={result.losses} tone="short" />
              <Metric label="NET PIPS" value={`+${result.netPips}`} tone="long" />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: any; tone?: "long"|"short"|"accent" }) {
  const c = tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : tone === "accent" ? "text-neon-accent" : "text-white";
  return (
    <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold ${c}`}>{value}</div>
    </div>
  );
}
