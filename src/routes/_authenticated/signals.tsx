import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listSignals,
  generateSignals,
  invalidateSignal,
  scoreSignalPerformance,
  getLearningReport,
  type LearningReport,
  type PerformanceReport,
} from "@/lib/signals.functions";
import { getMarketDataStatus } from "@/lib/market-data.functions";
import {
  consultSignalWithLocalCli,
  getLocalCliHealth,
  type LocalCliProvider,
  type LocalCliSignal,
} from "@/lib/local-cli-client";
import {
  classifyOrder,
  isResolvedStatus,
  summarizeSignal,
  type OrderTicket,
} from "@/lib/order-ticket";
import { SignalRow } from "./dashboard";

const TICKET_TONE: Record<OrderTicket["tone"], string> = {
  long: "border-neon-long/40 bg-neon-long/10 text-neon-long",
  short: "border-neon-short/40 bg-neon-short/10 text-neon-short",
  warn: "border-neon-warn/40 bg-neon-warn/10 text-neon-warn",
  dead: "border-cyber-border bg-cyber-surface text-muted-foreground",
};
import { useState } from "react";
import { toast } from "sonner";
import { Bot, BrainCircuit, CircleAlert, Radio, Terminal } from "lucide-react";

export const Route = createFileRoute("/_authenticated/signals")({
  head: () => ({
    meta: [
      { title: "Signal Center — MDTAlphaFX" },
      { name: "description", content: "All live and historical trading signals with AI consult." },
      { property: "og:title", content: "Signal Center — MDTAlphaFX" },
      {
        property: "og:description",
        content: "All live and historical trading signals with AI consult.",
      },
    ],
  }),
  component: Signals,
});

function Signals() {
  const listFn = useServerFn(listSignals);
  const genFn = useServerFn(generateSignals);
  const invalidateFn = useServerFn(invalidateSignal);
  const scoreFn = useServerFn(scoreSignalPerformance);
  const learningFn = useServerFn(getLearningReport);
  const marketStatusFn = useServerFn(getMarketDataStatus);
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "intraday" | "scalper">("all");
  const [scanMode, setScanMode] = useState<"intraday" | "scalper">("intraday");
  const [cliProvider, setCliProvider] = useState<LocalCliProvider>("codex");
  const [selected, setSelected] = useState<string | null>(null);
  const [consultResult, setConsultResult] = useState<{
    signalId: string;
    provider: LocalCliProvider;
    output: string;
  } | null>(null);

  const q = useQuery({ queryKey: ["signals"], queryFn: () => listFn() });
  const perf = useQuery({
    queryKey: ["signal-performance"],
    queryFn: () => scoreFn(),
    refetchInterval: 30_000,
    retry: false,
  });
  const learning = useQuery({
    queryKey: ["signal-learning"],
    queryFn: () => learningFn(),
    refetchInterval: 30_000,
    retry: false,
  });
  const marketStatus = useQuery({
    queryKey: ["market-data-status"],
    queryFn: () => marketStatusFn(),
    refetchInterval: 5_000,
    retry: false,
  });
  const cliStatus = useQuery({
    queryKey: ["local-cli-health"],
    queryFn: getLocalCliHealth,
    refetchInterval: 15_000,
    retry: false,
  });

  const gen = useMutation({
    mutationFn: (mode: "intraday" | "scalper") => genFn({ data: { mode } }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["signals"] });
      qc.invalidateQueries({ queryKey: ["market-quotes"] });
      if (data.warnings.length > 0) {
        toast.warning(`Scan completed with ${data.warnings.length} unavailable pair(s)`);
      } else {
        toast.success(`${data.signals.length} signals generated`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const inv = useMutation({
    mutationFn: (id: string) => invalidateFn({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signals"] });
      toast.success("Signal invalidated");
    },
  });
  const consult = useMutation({
    mutationFn: ({
      provider,
      signal,
    }: {
      signalId: string;
      provider: LocalCliProvider;
      signal: LocalCliSignal;
    }) => consultSignalWithLocalCli(provider, signal),
    onMutate: () => setConsultResult(null),
    onSuccess: (result, variables) => {
      setConsultResult({
        signalId: variables.signalId,
        provider: result.provider,
        output: result.output,
      });
      toast.success(`${result.provider === "codex" ? "Codex" : "Claude Code"} verdict ready`);
    },
    onError: (e: Error) => {
      setConsultResult(null);
      toast.error(e.message);
    },
  });

  const signals = (q.data?.signals ?? []).filter((s) =>
    filter === "all" ? true : s.mode === filter,
  );
  const feedReady = marketStatus.data?.configured === true;
  const rateLimited = marketStatus.data?.rate_limit?.limited === true;
  const activeCliStatus = cliStatus.data?.providers[cliProvider];
  const activeCliReady =
    activeCliStatus?.available === true && activeCliStatus.authenticated === true;

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            // SIGNAL_CENTER
          </div>
          <h1 className="text-2xl font-bold text-white">Signal Center</h1>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <div className="mb-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
              // SCAN_MODE
            </div>
            <div
              className="flex rounded-sm border border-cyber-border bg-cyber-surface p-0.5"
              role="radiogroup"
              aria-label="Scan mode"
            >
              {(["intraday", "scalper"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={scanMode === mode}
                  onClick={() => setScanMode(mode)}
                  className={`rounded-sm px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest transition ${
                    scanMode === mode
                      ? mode === "scalper"
                        ? "bg-neon-warn/10 text-neon-warn"
                        : "bg-neon-accent/10 text-neon-accent"
                      : "text-muted-foreground hover:text-white"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={() => gen.mutate(scanMode)}
            disabled={gen.isPending || !feedReady}
            className={`h-[35px] rounded-sm border px-4 text-[10px] font-mono font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
              scanMode === "scalper"
                ? "border-neon-warn/40 bg-neon-warn/10 text-neon-warn hover:bg-neon-warn/20"
                : "border-neon-accent/40 bg-neon-accent/10 text-neon-accent hover:bg-neon-accent/20"
            }`}
          >
            {gen.isPending ? "SCANNING…" : rateLimited ? "RATE_LIMITED…" : "RUN_SCAN"}
          </button>
        </div>
      </header>

      {marketStatus.isLoading ? (
        <div className="rounded-lg border border-cyber-border bg-cyber-surface p-3 text-xs font-mono text-muted-foreground">
          CHECKING_LIVE_FEED…
        </div>
      ) : rateLimited ? (
        <div className="rounded-lg border border-neon-warn/40 bg-neon-warn/5 p-3 flex items-center gap-3">
          <Radio className="size-4 text-neon-warn" />
          <div>
            <div className="text-xs font-mono font-bold text-neon-warn">
              OANDA_FEED_RATE_LIMITED_RETRYING…
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Feed rate limit reached. Retrying automatically — scans are temporarily throttled.
            </p>
          </div>
        </div>
      ) : feedReady ? (
        <div className="rounded-lg border border-neon-long/30 bg-neon-long/5 p-3 flex items-center gap-3">
          <Radio className="size-4 text-neon-long" />
          <div>
            <div className="text-xs font-mono font-bold text-neon-long">
              {marketStatus.data?.provider ?? "LIVE"}_FEED_CONNECTED
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Retail-grade OANDA prices via TradingView — no API key required. Entries use the same
              live instrument feed shown in Live Chart.
            </p>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-neon-warn/40 bg-neon-warn/5 p-4 flex items-start gap-3">
          <CircleAlert className="size-4 text-neon-warn mt-0.5" />
          <div>
            <div className="text-sm font-bold text-white">Live market feed unavailable</div>
            <p className="mt-1 text-xs text-muted-foreground">
              The free market data feed is currently unreachable. Scans are disabled so synthetic
              prices cannot be mistaken for live quotes.
            </p>
          </div>
        </div>
      )}

      <PerformancePanel report={perf.data} loading={perf.isLoading} />

      <LearningPanel report={learning.data} loading={learning.isLoading} />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <section className="rounded-lg border border-cyber-border bg-cyber-surface">
          <div className="flex items-center justify-between gap-3 border-b border-cyber-border px-4 py-2.5">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                // HISTORY_FILTER
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Show stored signal results
              </div>
            </div>
            <div className="flex gap-1" aria-label="Signal history filter">
              {(["all", "intraday", "scalper"] as const).map((historyFilter) => (
                <button
                  key={historyFilter}
                  type="button"
                  onClick={() => setFilter(historyFilter)}
                  className={`rounded-sm border px-2.5 py-1 text-[9px] font-mono uppercase tracking-widest transition ${
                    filter === historyFilter
                      ? "border-neon-accent/40 bg-neon-accent/10 text-neon-accent"
                      : "border-cyber-border bg-cyber-bg text-muted-foreground hover:text-white"
                  }`}
                >
                  {historyFilter}
                </button>
              ))}
            </div>
          </div>
          <div className="divide-y divide-cyber-border max-h-[70vh] overflow-auto">
            {q.isLoading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
            {!q.isLoading && signals.length === 0 && (
              <div className="p-6 text-sm text-muted-foreground">No signals. Run a scan.</div>
            )}
            {signals.map((s) => (
              <div
                key={s.id}
                onClick={() => {
                  setSelected(s.id);
                  setConsultResult(null);
                }}
                className={`cursor-pointer ${selected === s.id ? "bg-cyber-surface-2" : ""}`}
              >
                <SignalRow signal={s} />
              </div>
            ))}
          </div>
        </section>

        <aside className="rounded-lg border border-cyber-border bg-cyber-surface p-4 h-fit sticky top-4">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            // SIGNAL_INSPECTOR
          </h2>
          {!selected ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Select a signal to inspect and consult AI.
            </p>
          ) : (
            (() => {
              const s = signals.find((x) => x.id === selected);
              if (!s)
                return <p className="mt-3 text-sm text-muted-foreground">Signal not found.</p>;
              const verified = s.market_data_verified === true;
              const resolved = isResolvedStatus(s.live_status ?? s.status);
              const ticket = classifyOrder(s, s.live_mid);
              return (
                <div className="mt-3 space-y-3 font-mono text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-white font-bold">
                      {s.pair} · {s.direction.toUpperCase()}
                    </span>
                    <span className={verified ? "text-neon-accent" : "text-neon-warn"}>
                      {verified ? `${s.confluence}%` : "LEGACY"}
                    </span>
                  </div>
                  {verified ? (
                    <>
                      {!resolved && (
                        <div
                          className={`rounded-sm border px-2.5 py-2 ${TICKET_TONE[ticket.tone]}`}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-bold tracking-wide">{ticket.label}</span>
                            <span className="text-[9px] opacity-80">
                              {ticket.closed ? "NO_ENTRY" : `${ticket.distanceR}R FROM_PRICE`}
                            </span>
                          </div>
                          <p className="mt-0.5 text-[10px] leading-snug opacity-90">
                            {ticket.note}
                          </p>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <Field label="Entry" value={s.entry} />
                        <Field label="ATR" value={s.atr} />
                        <Field label="SL" value={s.stop_loss} tone="short" />
                        <Field label="TP1" value={s.take_profit_1} tone="long" />
                        <Field label="TP2" value={s.take_profit_2} tone="long" />
                        <Field label="TF" value={s.timeframe} />
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-muted-foreground">
                          Technical read
                        </div>
                        <div className="mt-0.5 space-y-0.5">
                          {summarizeSignal(s).map((line, index) => (
                            <p
                              key={index}
                              className="text-[11px] leading-snug text-muted-foreground"
                            >
                              <span className="text-neon-accent">{index + 1}.</span> {line}
                            </p>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase text-muted-foreground">
                          Verified strategy votes
                        </div>
                        <div className="text-[11px] text-white">
                          {(s.contributing_strategies as string[]).join(" · ")}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-sm border border-neon-warn/40 bg-neon-warn/5 p-3">
                      <div className="font-bold text-neon-warn">LEGACY_DEMO_LEVELS_HIDDEN</div>
                      <p className="mt-1 font-sans text-[11px] leading-relaxed text-muted-foreground">
                        Entry, stop, targets, confluence, and strategy labels were synthetic. They
                        are intentionally hidden and cannot be treated as a trading setup.
                      </p>
                    </div>
                  )}
                  <MarketSource signal={s} />
                  <div className="rounded-sm border border-cyber-border bg-cyber-bg p-2.5">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-widest text-muted-foreground">
                        <Terminal className="size-3" /> Local CLI
                      </span>
                      <span
                        className={`text-[9px] ${
                          activeCliReady ? "text-neon-long" : "text-neon-warn"
                        }`}
                      >
                        {cliStatus.isLoading
                          ? "CHECKING…"
                          : activeCliReady
                            ? "READY"
                            : activeCliStatus?.available
                              ? "SIGN_IN_REQUIRED"
                              : "BRIDGE_OFFLINE"}
                      </span>
                    </div>
                    <div
                      className="grid grid-cols-2 gap-1"
                      role="radiogroup"
                      aria-label="Local AI CLI"
                    >
                      {(["codex", "claude"] as const).map((provider) => {
                        const providerStatus = cliStatus.data?.providers[provider];
                        const ready =
                          providerStatus?.available === true &&
                          providerStatus.authenticated === true;
                        return (
                          <button
                            key={provider}
                            type="button"
                            role="radio"
                            aria-checked={cliProvider === provider}
                            disabled={consult.isPending}
                            onClick={() => {
                              setCliProvider(provider);
                              setConsultResult(null);
                            }}
                            className={`rounded-sm border px-2 py-1.5 text-[9px] transition disabled:cursor-not-allowed disabled:opacity-50 ${
                              cliProvider === provider
                                ? "border-neon-accent/40 bg-neon-accent/10 text-neon-accent"
                                : "border-cyber-border text-muted-foreground hover:text-white"
                            }`}
                          >
                            <span>{provider === "codex" ? "CODEX" : "CLAUDE_CODE"}</span>
                            <span
                              className={`ml-1 inline-block size-1.5 rounded-full ${
                                ready ? "bg-neon-long" : "bg-neon-warn"
                              }`}
                            />
                          </button>
                        );
                      })}
                    </div>
                    {activeCliStatus?.version ? (
                      <div className="mt-1.5 truncate text-[8px] text-muted-foreground">
                        {activeCliStatus.version}
                      </div>
                    ) : !cliStatus.isLoading ? (
                      <div className="mt-1.5 text-[8px] text-muted-foreground">
                        Start locally with npm run cli:bridge
                      </div>
                    ) : null}
                  </div>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() =>
                        consult.mutate({
                          signalId: s.id,
                          provider: cliProvider,
                          signal: {
                            pair: s.pair,
                            direction: s.direction,
                            mode: s.mode,
                            timeframe: s.timeframe,
                            entry: s.entry,
                            stopLoss: s.stop_loss,
                            takeProfit1: s.take_profit_1,
                            takeProfit2: s.take_profit_2,
                            atr: s.atr,
                            confluence: s.confluence,
                            status: s.live_status ?? s.status,
                            verified: s.market_data_verified === true,
                            strategies: s.contributing_strategies as string[],
                          },
                        })
                      }
                      disabled={consult.isPending || !activeCliReady}
                      className="flex-1 inline-flex items-center justify-center gap-1 rounded-sm border border-neon-accent/40 bg-neon-accent/10 px-2 py-1.5 text-[10px] font-mono text-neon-accent hover:bg-neon-accent/20 disabled:opacity-50"
                    >
                      <Bot className="size-3" />{" "}
                      {consult.isPending
                        ? "ANALYZING…"
                        : `ASK_${cliProvider === "codex" ? "CODEX" : "CLAUDE"}`}
                    </button>
                    <button
                      onClick={() => inv.mutate(s.id)}
                      className="rounded-sm border border-neon-short/40 bg-neon-short/10 px-2 py-1.5 text-[10px] font-mono text-neon-short hover:bg-neon-short/20"
                    >
                      INVALIDATE
                    </button>
                  </div>
                  {consultResult?.signalId === s.id && consultResult.provider === cliProvider && (
                    <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3 whitespace-pre-wrap text-[11px] text-white">
                      {consultResult.output}
                    </div>
                  )}
                </div>
              );
            })()
          )}
        </aside>
      </div>
    </div>
  );
}

function PerformancePanel({
  report,
  loading,
}: {
  report: PerformanceReport | undefined;
  loading: boolean;
}) {
  return (
    <section className="rounded-lg border border-cyber-border bg-cyber-surface">
      <div className="px-4 py-3 border-b border-cyber-border">
        <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
          // PAPER_TRADING_SCORE
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Live evaluation of stored signals vs the OANDA feed — hit-rate and R-multiple per
          strategy, updated every 30s
        </div>
      </div>
      {loading && <div className="p-4 text-sm text-muted-foreground">Scoring live signals…</div>}
      {!loading && report && report.scored === 0 && (
        <div className="p-4 text-sm text-muted-foreground">
          No live signals to score yet. Run a scan and the engine starts keeping score.
        </div>
      )}
      {!loading && report && report.scored > 0 && (
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5 font-mono">
            <ScoreStat label="TRACKED" value={report.scored} />
            <ScoreStat label="RESOLVED" value={report.resolved} />
            <ScoreStat
              label="WIN_RATE"
              value={`${report.winRate}%`}
              tone={report.winRate >= 50 ? "long" : "short"}
            />
            <ScoreStat
              label="AVG_R"
              value={report.avgR > 0 ? `+${report.avgR}` : report.avgR}
              tone={report.avgR >= 0 ? "long" : "short"}
            />
            <ScoreStat
              label="PROFIT_FACTOR"
              value={report.profitFactor}
              tone={report.profitFactor >= 1 ? "long" : "short"}
            />
          </div>
          <div className="text-[10px] font-mono text-muted-foreground">
            TOTAL_R:{" "}
            <span className={report.totalR >= 0 ? "text-neon-long" : "text-neon-short"}>
              {report.totalR >= 0 ? `+${report.totalR}` : report.totalR}
            </span>{" "}
            · BEST STRATEGIES
          </div>
          <div className="flex flex-wrap gap-1.5">
            {report.byStrategy.slice(0, 8).map((strategy) => (
              <span
                key={strategy.strategyId}
                className={`rounded-sm border px-2 py-1 font-mono text-[10px] ${
                  strategy.totalR > 0
                    ? "border-neon-long/30 bg-neon-long/5 text-neon-long"
                    : strategy.totalR < 0
                      ? "border-neon-short/30 bg-neon-short/5 text-neon-short"
                      : "border-cyber-border text-muted-foreground"
                }`}
              >
                {strategy.strategyId} {strategy.wins}/{strategy.signals} · R
                {strategy.totalR > 0 ? `+${strategy.totalR}` : strategy.totalR}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function LearningPanel({
  report,
  loading,
}: {
  report: LearningReport | undefined;
  loading: boolean;
}) {
  return (
    <section className="rounded-lg border border-neon-accent/20 bg-cyber-surface">
      <div className="px-4 py-3 border-b border-cyber-border flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
            <BrainCircuit className="mr-1 inline size-3" />
            // AUTONOMOUS_LEARNING_LOOP
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            The engine reweights itself from resolved outcomes on every scan — no manual tuning.
          </div>
        </div>
        <span
          className={`shrink-0 rounded-sm border px-2 py-1 text-[9px] font-mono uppercase tracking-widest ${
            report && report.resolved >= 3
              ? "border-neon-long/40 bg-neon-long/5 text-neon-long"
              : "border-neon-warn/40 bg-neon-warn/5 text-neon-warn"
          }`}
        >
          {loading
            ? "LEARNING…"
            : report && report.resolved >= 3
              ? `SELF_TUNING · ${report.adjustmentsApplied} ADJUSTED`
              : "GATHERING_SAMPLES…"}
        </span>
      </div>

      {loading && (
        <div className="p-4 text-sm text-muted-foreground">Learning from resolved trades…</div>
      )}
      {!loading && report && report.resolved === 0 && report.stale === 0 && (
        <div className="p-4 text-sm text-muted-foreground">
          No resolved trades yet. Run scans and let the market resolve them to TP1/TP2/SL — the loop
          starts tuning after ~3 outcomes per strategy.
        </div>
      )}
      {!loading && report && (report.resolved > 0 || report.stale > 0) && (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5 font-mono">
            <ScoreStat label="RESOLVED" value={report.resolved} />
            <ScoreStat label="WINS" value={report.wins} tone="long" />
            <ScoreStat label="LOSSES" value={report.losses} tone="short" />
            <ScoreStat
              label="WIN_RATE"
              value={`${report.winRate}%`}
              tone={report.winRate >= 50 ? "long" : "short"}
            />
            <ScoreStat
              label="TOTAL_R"
              value={report.totalR > 0 ? `+${report.totalR}` : report.totalR}
              tone={report.totalR >= 0 ? "long" : "short"}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3">
              <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-neon-long">
                <span className="inline-block size-1.5 rounded-full bg-neon-long" />
                WHAT_WENT_GOOD → BOOSTED
              </div>
              {report.strengths.length === 0 && (
                <div className="text-[11px] text-muted-foreground">
                  No strategy has proven itself yet. Resolved outcomes will surface them here.
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {report.strengths.map((s) => (
                  <div
                    key={`${s.strategyId}:${s.mode}`}
                    className="rounded-sm border border-neon-long/30 bg-neon-long/5 px-2 py-1 font-mono text-[10px]"
                  >
                    <span className="text-neon-long">BOOST ×{s.multiplier}</span>{" "}
                    <span className="text-white">{s.strategyId}</span>{" "}
                    <span className="text-muted-foreground">
                      {s.wins}/{s.resolved} · {s.mode}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3">
              <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-neon-short">
                <span className="inline-block size-1.5 rounded-full bg-neon-short" />
                WHAT_WENT_WRONG → COOLED
              </div>
              {report.weaknesses.length === 0 && (
                <div className="text-[11px] text-muted-foreground">
                  Nothing is bleeding R right now — the loop is holding all trust weights.
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {report.weaknesses.map((s) => (
                  <div
                    key={`${s.strategyId}:${s.mode}`}
                    className="rounded-sm border border-neon-short/30 bg-neon-short/5 px-2 py-1 font-mono text-[10px]"
                  >
                    <span className="text-neon-short">
                      {s.excluded ? "EXCLUDED ×" : "COOL ×"}
                      {s.multiplier}
                    </span>{" "}
                    <span className="text-white">{s.strategyId}</span>{" "}
                    <span className="text-muted-foreground">
                      {s.wins}/{s.resolved} · {s.mode}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {report.autopsies.length > 0 && (
            <div>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                // RECENT_AUTOPSIES
              </div>
              <div className="space-y-1.5">
                {report.autopsies.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2 text-[11px]"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-mono font-bold text-white">
                        {a.pair} · {a.direction.toUpperCase()} · {a.mode} {a.timeframe}
                      </span>
                      <span
                        className={`font-mono text-[9px] ${
                          a.status === "hit_sl"
                            ? "text-neon-short"
                            : a.status === "invalidated"
                              ? "text-neon-warn"
                              : "text-neon-long"
                        }`}
                      >
                        {a.status === "hit_tp2"
                          ? "TP2 +2.0R"
                          : a.status === "hit_tp1"
                            ? "BE after TP1 0.0R"
                            : a.status === "hit_sl"
                              ? "SL −1.0R"
                              : "EXPIRED"}
                      </span>
                    </div>
                    <div className="mt-1 text-muted-foreground">{a.diagnosis}</div>
                    <div className="mt-0.5 text-neon-accent">→ {a.lesson}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              // NEXT_ITERATION
            </div>
            <ul className="space-y-1">
              {report.recommendations.map((rec, index) => (
                <li key={index} className="flex gap-2 text-[11px] text-muted-foreground">
                  <span className="text-neon-accent">▸</span>
                  {rec}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function ScoreStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "long" | "short";
}) {
  const color =
    tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : "text-white";
  return (
    <div className="rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2">
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{String(value)}</div>
    </div>
  );
}

function MarketSource({ signal }: { signal: { news_context: unknown } }) {
  const context = signal.news_context;
  const marketData =
    context && !Array.isArray(context) && typeof context === "object"
      ? (context as Record<string, unknown>).market_data
      : null;
  if (!marketData || typeof marketData !== "object") {
    return (
      <div className="rounded-sm border border-neon-warn/30 bg-neon-warn/5 px-2 py-1.5 text-[10px] text-neon-warn">
        LEGACY_SYNTHETIC • UNVERIFIED_PRICE
      </div>
    );
  }

  const details = marketData as Record<string, unknown>;
  const note = typeof details.source_note === "string" ? details.source_note : null;
  return (
    <div className="rounded-sm border border-neon-long/30 bg-neon-long/5 px-2 py-1.5 text-[10px] text-neon-long">
      {String(details.provider)} • {String(details.price_type)} •{" "}
      {new Date(String(details.timestamp)).toLocaleString()}
      {note && <div className="mt-1 text-[9px] text-neon-warn">⚠ {note}</div>}
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: unknown; tone?: "long" | "short" }) {
  const color =
    tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : "text-white";
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`${color}`}>{String(value)}</div>
    </div>
  );
}
