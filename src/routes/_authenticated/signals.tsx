import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  getXauusdPaperHealth,
  getXauusdPaperPerformance,
  getXauusdPaperProfile,
  getXauusdShadowLearning,
  listXauusdPaperSignals,
  setXauusdPaperEnabled,
  type PaperPerformanceReport,
  type PaperShadowLearningReport,
  type PaperSignalListItem,
} from "@/lib/xauusd-paper.functions";
import { XauusdAutoPaperPanel } from "@/components/xauusd-auto-paper-panel";
import {
  consultSignalWithLocalCli,
  getLocalCliHealth,
  type LocalCliProvider,
  type LocalCliSignal,
} from "@/lib/local-cli-client";
import { Bot, BrainCircuit, Terminal } from "lucide-react";

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
  const profileFn = useServerFn(getXauusdPaperProfile);
  const healthFn = useServerFn(getXauusdPaperHealth);
  const listFn = useServerFn(listXauusdPaperSignals);
  const perfFn = useServerFn(getXauusdPaperPerformance);
  const learningFn = useServerFn(getXauusdShadowLearning);
  const setEnabledFn = useServerFn(setXauusdPaperEnabled);
  const qc = useQueryClient();
  const [archive, setArchive] = useState<"active" | "archive">("active");
  const [selected, setSelected] = useState<string | null>(null);
  const [cliProvider, setCliProvider] = useState<LocalCliProvider>("codex");
  const [consultResult, setConsultResult] = useState<{
    signalId: string;
    provider: LocalCliProvider;
    output: string;
  } | null>(null);

  const profileQ = useQuery({ queryKey: ["xauusd-paper-profile"], queryFn: () => profileFn() });
  const healthQ = useQuery({
    queryKey: ["xauusd-paper-health"],
    queryFn: () => healthFn(),
    refetchInterval: 5_000,
    retry: false,
  });
  const signalsQ = useQuery({
    queryKey: ["xauusd-paper-signals", archive === "archive"],
    queryFn: () => listFn({ data: { archived: archive === "archive" } }),
  });
  const perfQ = useQuery({
    queryKey: ["xauusd-paper-performance"],
    queryFn: () => perfFn(),
    refetchInterval: 30_000,
    retry: false,
  });
  const learningQ = useQuery({
    queryKey: ["xauusd-shadow-learning"],
    queryFn: () => learningFn(),
    refetchInterval: 30_000,
    retry: false,
  });
  const cliStatus = useQuery({
    queryKey: ["local-cli-health"],
    queryFn: getLocalCliHealth,
    refetchInterval: 15_000,
    retry: false,
  });

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => setEnabledFn({ data: { enabled } }),
    onSuccess: (_data, enabled) => {
      qc.invalidateQueries({ queryKey: ["xauusd-paper-profile"] });
      qc.invalidateQueries({ queryKey: ["xauusd-paper-health"] });
      qc.invalidateQueries({ queryKey: ["xauusd-paper-signals"] });
      toast.success(enabled ? "Auto-paper enabled." : "Auto-paper disabled.");
    },
    onError: (e: Error) => toast.error(e.message),
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

  const signals = signalsQ.data ?? [];
  const activeCliStatus = cliStatus.data?.providers[cliProvider];
  const activeCliReady =
    activeCliStatus?.available === true && activeCliStatus.authenticated === true;

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // SIGNAL_CENTER
        </div>
        <h1 className="text-2xl font-bold text-white">Signal Center</h1>
      </header>

      <XauusdAutoPaperPanel
        profile={profileQ.data}
        health={healthQ.data}
        mutating={toggleEnabled.isPending}
        onEnabledChange={(enabled) => toggleEnabled.mutate(enabled)}
      />

      <PerformancePanel report={perfQ.data} loading={perfQ.isLoading} />

      <LearningPanel report={learningQ.data} loading={learningQ.isLoading} />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <section className="rounded-lg border border-cyber-border bg-cyber-surface">
          <div className="flex items-center justify-between gap-3 border-b border-cyber-border px-4 py-2.5">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                // HISTORY
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                Canonical worker signals — read-only, one 0.01-lot paper trade each
              </div>
            </div>
            <div className="flex gap-1" aria-label="Signal history filter">
              {(["active", "archive"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setArchive(tab);
                    setSelected(null);
                  }}
                  className={`rounded-sm border px-2.5 py-1 text-[9px] font-mono uppercase tracking-widest transition ${
                    archive === tab
                      ? "border-neon-accent/40 bg-neon-accent/10 text-neon-accent"
                      : "border-cyber-border bg-cyber-bg text-muted-foreground hover:text-white"
                  }`}
                >
                  {tab === "active" ? "ACTIVE" : "ARCHIVE"}
                </button>
              ))}
            </div>
          </div>
          <div className="divide-y divide-cyber-border max-h-[70vh] overflow-auto">
            {signalsQ.isLoading && (
              <div className="p-6 text-sm text-muted-foreground">Loading…</div>
            )}
            {!signalsQ.isLoading && signals.length === 0 && (
              <div className="p-6 text-sm text-muted-foreground">
                {archive === "active"
                  ? "No active paper signals yet. Enable Auto-Paper above and the worker publishes eligible XAUUSD signals automatically."
                  : "No archived paper signals yet — terminal signals are archived after 30 days."}
              </div>
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
                <PaperSignalRow signal={s} />
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
              Select a signal to inspect its paper-trade path and consult AI.
            </p>
          ) : (
            (() => {
              const s = signals.find((x) => x.id === selected);
              if (!s)
                return <p className="mt-3 text-sm text-muted-foreground">Signal not found.</p>;
              return (
                <div className="mt-3 space-y-3 font-mono text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-white font-bold">
                      {s.pair} · {s.direction.toUpperCase()}
                    </span>
                    <span className="text-neon-accent">{s.confluence}%</span>
                  </div>

                  <div className="rounded-sm border border-neon-accent/30 bg-neon-accent/5 px-2 py-1.5 text-[10px] font-bold text-neon-accent">
                    {s.paperLabel}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <InspectorField label="ENTRY" value={s.entry} />
                    <InspectorField label="ATR" value={s.atr} />
                    <InspectorField label="SL" value={s.stopLoss} tone="short" />
                    <InspectorField label="TP1" value={s.takeProfit1} tone="long" />
                    <InspectorField label="TP2" value={s.takeProfit2} tone="long" />
                    <InspectorField label="TF · LOT" value={`${s.timeframe} · ${s.lotSize}`} />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <InspectorField
                      label="FILL"
                      value={
                        s.trade.entryPrice != null
                          ? `${s.trade.entryPrice}${s.trade.entryTime ? ` @ ${formatTs(s.trade.entryTime)}` : ""}`
                          : "PENDING"
                      }
                    />
                    <InspectorField
                      label="TP1 PROTECTION"
                      value={
                        s.trade.state === "tp1_protected"
                          ? "ARMED"
                          : s.trade.tp1ArmedAt
                            ? formatTs(s.trade.tp1ArmedAt)
                            : "NOT_ARMED"
                      }
                    />
                    <InspectorField
                      label="EXIT"
                      value={
                        s.trade.exitPrice != null
                          ? `${s.trade.exitPrice}${s.trade.exitTime ? ` @ ${formatTs(s.trade.exitTime)}` : ""}`
                          : "—"
                      }
                    />
                    <InspectorField
                      label="R RESULT"
                      value={
                        s.trade.resultR != null
                          ? `${s.trade.resultR > 0 ? "+" : ""}${s.trade.resultR}R`
                          : "OPEN"
                      }
                      tone={
                        s.trade.resultR != null
                          ? s.trade.resultR > 0
                            ? "long"
                            : s.trade.resultR < 0
                              ? "short"
                              : "muted"
                          : undefined
                      }
                    />
                  </div>

                  <div>
                    <div className="mb-1 rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5">
                      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                        <span>ENGINE ACCOUNTING</span>
                        <span className="text-neon-accent">
                          v{s.engine.version} · {s.engine.policyVersion}
                        </span>
                      </div>
                      <div className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                        <AccountingLine
                          label="EVALUATED"
                          items={s.engine.accounting.evaluated}
                          cls="text-neon-long"
                        />
                        <AccountingLine
                          label="ABSTAINED"
                          items={s.engine.accounting.abstained}
                          cls="text-white"
                        />
                        <AccountingLine
                          label="INCOMPATIBLE"
                          items={s.engine.accounting.incompatible}
                          cls="text-muted-foreground"
                        />
                        <AccountingLine
                          label="EXCLUDED"
                          items={s.engine.accounting.excluded}
                          cls="text-neon-warn"
                        />
                        {s.engine.accounting.failed.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            <span className="uppercase text-[9px] text-neon-short">FAILED:</span>
                            {s.engine.accounting.failed.map((f) => (
                              <span key={f.strategyId} className="text-neon-short">
                                {f.strategyId}({f.code})
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="text-[10px] uppercase text-muted-foreground">
                      Provider evidence
                    </div>
                    <div className="mt-0.5 rounded-sm border border-neon-long/30 bg-neon-long/5 px-2 py-1.5 text-[10px] text-neon-long">
                      {s.provider.name} · {s.provider.instrument} ·{" "}
                      {formatTs(s.provider.providerTime)}
                    </div>
                    <div className="mt-1 text-[9px] text-muted-foreground" title={s.timestampUtc}>
                      Generated {s.timestampPht}
                    </div>
                  </div>

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
                          signal: toLocalCliSignal(s),
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

function toLocalCliSignal(s: PaperSignalListItem): LocalCliSignal {
  return {
    pair: s.pair,
    direction: s.direction,
    mode: s.mode,
    timeframe: s.timeframe,
    entry: s.entry,
    stopLoss: s.stopLoss,
    takeProfit1: s.takeProfit1,
    takeProfit2: s.takeProfit2,
    atr: s.atr,
    confluence: s.confluence,
    status: s.trade.state,
    verified: true,
    strategies: s.contributingStrategies,
  };
}

function formatTs(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(date) + " PHT"
  );
}

const TRADE_STATE_LABEL: Record<string, string> = {
  waiting_entry: "WAITING_ENTRY",
  open: "OPEN",
  tp1_protected: "TP1_PROTECTED",
  closed_tp2: "TP2 +2.0R",
  closed_breakeven: "SCRATCHED 0.0R",
  closed_stop: "SL −1.0R",
  expired: "EXPIRED",
};

function PaperSignalRow({ signal }: { signal: PaperSignalListItem }) {
  const long = signal.direction === "long";
  const stateLabel = TRADE_STATE_LABEL[signal.trade.state] ?? signal.trade.state;
  const stateTone =
    signal.trade.state === "closed_tp2"
      ? "text-neon-long"
      : signal.trade.state === "closed_stop"
        ? "text-neon-short"
        : signal.trade.state === "closed_breakeven" || signal.trade.state === "expired"
          ? "text-muted-foreground"
          : "text-neon-accent";
  return (
    <div className="grid grid-cols-12 gap-2 px-4 py-3 items-center font-mono text-xs hover:bg-cyber-surface-2 transition">
      <div className="col-span-2 flex items-center gap-2">
        <span
          className={`inline-block size-2 rounded-full ${long ? "bg-neon-long" : "bg-neon-short"}`}
        />
        <span className="text-white font-bold">{signal.pair}</span>
        <span className={long ? "text-neon-long" : "text-neon-short"}>
          {signal.direction.toUpperCase()}
        </span>
      </div>
      <div className="col-span-1 text-muted-foreground">{signal.timeframe}</div>
      <div className="col-span-1 text-white">{signal.entry}</div>
      <div className="col-span-1 text-neon-short">{signal.stopLoss}</div>
      <div className="col-span-1 text-neon-long">{signal.takeProfit1}</div>
      <div className="col-span-1 text-neon-long">{signal.takeProfit2}</div>
      <div className="col-span-1">
        <span className={`uppercase text-[10px] ${stateTone}`}>{stateLabel}</span>
      </div>
      <div className="col-span-1 text-[10px] text-muted-foreground">
        {signal.trade.resultR != null
          ? `${signal.trade.resultR > 0 ? "+" : ""}${signal.trade.resultR}R`
          : "0.01 lot"}
      </div>
      <div className="col-span-3 text-[10px] text-muted-foreground truncate">
        <span className="text-white" title={signal.timestampUtc}>
          {signal.timestampPht}
        </span>
        <span className="ml-2">{signal.contributingStrategies.slice(0, 2).join(" · ")}</span>
      </div>
    </div>
  );
}

function AccountingLine({ label, items, cls }: { label: string; items: string[]; cls: string }) {
  return (
    <div className="flex gap-1 flex-wrap">
      <span className="uppercase text-[9px] text-muted-foreground">{label}:</span>
      {items.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className={cls}>{items.join(", ")}</span>
      )}
    </div>
  );
}

function InspectorField({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "long" | "short" | "muted";
}) {
  const color =
    tone === "long"
      ? "text-neon-long"
      : tone === "short"
        ? "text-neon-short"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-white";
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={color}>{String(value)}</div>
    </div>
  );
}

function PerformancePanel({
  report,
  loading,
}: {
  report: PaperPerformanceReport | undefined;
  loading: boolean;
}) {
  return (
    <section className="rounded-lg border border-cyber-border bg-cyber-surface">
      <div className="px-4 py-3 border-b border-cyber-border">
        <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
          // PAPER_TRADING_SCORE · CANONICAL
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Resolved outcomes from the unattended worker's 0.01-lot ledger — breakeven scratches count
          toward the resolved denominator but neither win nor lose.
        </div>
      </div>
      {loading && <div className="p-4 text-sm text-muted-foreground">Loading paper record…</div>}
      {!loading && report && report.resolved === 0 && report.stale === 0 && (
        <div className="p-4 text-sm text-muted-foreground">
          No resolved paper trades yet — the worker's ledger is empty until Auto-Paper is enabled
          and signals resolve to TP2 / breakeven / SL.
        </div>
      )}
      {!loading && report && (report.resolved > 0 || report.stale > 0) && (
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-6 font-mono">
            <ScoreStat label="RESOLVED" value={report.resolved} />
            <ScoreStat label="WINS" value={report.wins} tone="long" />
            <ScoreStat label="SCRATCHES" value={report.scratches} />
            <ScoreStat label="LOSSES" value={report.losses} tone="short" />
            <ScoreStat
              label="WIN_RATE"
              value={`${Math.round(report.winRate * 100)}%`}
              tone={report.winRate >= 0.5 ? "long" : "short"}
            />
            <ScoreStat
              label="TOTAL_R"
              value={report.totalR > 0 ? `+${report.totalR}` : report.totalR}
              tone={report.totalR >= 0 ? "long" : "short"}
            />
          </div>
          {report.stale > 0 && (
            <div className="text-[10px] font-mono text-muted-foreground">
              {report.stale} expired without touching a level (stale — excluded from the resolved
              record).
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const VERDICT_TONE: Record<string, string> = {
  boost: "border-neon-long/40 bg-neon-long/5 text-neon-long",
  cool: "border-neon-short/40 bg-neon-short/5 text-neon-short",
  hold: "border-cyber-border text-muted-foreground",
  insufficient: "border-cyber-border text-muted-foreground",
};

function LearningPanel({
  report,
  loading,
}: {
  report: PaperShadowLearningReport | undefined;
  loading: boolean;
}) {
  return (
    <section className="rounded-lg border border-neon-accent/20 bg-cyber-surface">
      <div className="px-4 py-3 border-b border-cyber-border flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
            <BrainCircuit className="mr-1 inline size-3" />
            // AUTONOMOUS_LEARNING_LOOP · CANONICAL
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Candidate trust multipliers derived from the worker's canonical paper outcomes.
          </div>
        </div>
        <span className="shrink-0 rounded-sm border border-neon-warn/40 bg-neon-warn/5 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-neon-warn">
          SHADOW ONLY · NOT APPLIED
        </span>
      </div>

      {loading && (
        <div className="p-4 text-sm text-muted-foreground">Learning from paper trades…</div>
      )}
      {!loading && report && report.sampleSize === 0 && (
        <div className="p-4 text-sm text-muted-foreground">
          No canonical paper outcomes yet. Once the worker resolves trades, candidate multipliers
          appear here for review — nothing is applied to live weights.
        </div>
      )}
      {!loading && report && report.sampleSize > 0 && (
        <div className="p-4 space-y-3">
          <div className="text-[10px] font-mono text-muted-foreground">
            SAMPLE_SIZE: {report.sampleSize} terminal canonical trades
          </div>
          <div className="flex flex-wrap gap-1.5">
            {report.candidates.map((candidate) => (
              <div
                key={`${candidate.strategyId}:${candidate.mode}`}
                className={`rounded-sm border px-2 py-1 font-mono text-[10px] ${VERDICT_TONE[candidate.verdict] ?? "border-cyber-border text-muted-foreground"}`}
              >
                <span className="font-bold text-white">{candidate.strategyId}</span>{" "}
                <span className="text-muted-foreground">
                  ×{candidate.candidateMultiplier.toFixed(2)} · {candidate.mode}
                </span>{" "}
                <span className="text-muted-foreground">
                  {candidate.wins}W/{candidate.scratches}S/{candidate.losses}L ·{" "}
                  {candidate.totalR >= 0 ? "+" : ""}
                  {candidate.totalR}R
                </span>
              </div>
            ))}
          </div>
          <div className="rounded-sm border border-neon-warn/30 bg-neon-warn/5 px-3 py-2 text-[11px] text-neon-warn">
            SHADOW ONLY · NOT APPLIED — these multipliers are candidates for review. Promotion needs
            a later design covering minimum samples, walk-forward validation, approval, and
            rollback. The engine never writes strategy_settings from this report.
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
