import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getXauusdPaperHealth,
  getXauusdPaperProfile,
  listXauusdPaperSignals,
  setXauusdPaperEnabled,
  type PaperSignalListItem,
} from "@/lib/xauusd-paper.functions";
import { XauusdAutoPaperPanel } from "@/components/xauusd-auto-paper-panel";
import { mySubscription } from "@/lib/subscriptions.functions";
import { Activity, Radio, TrendingUp, AlertTriangle, KeyRound } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — MDTAlphaFX" },
      { name: "description", content: "Market overview, live signals, and quick actions." },
      { property: "og:title", content: "Dashboard — MDTAlphaFX" },
      { property: "og:description", content: "Market overview, live signals, and quick actions." },
    ],
  }),
  component: Dashboard,
});

const ACTIVE_TRADE_STATES = ["waiting_entry", "open", "tp1_protected"];

function Dashboard() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  const profileFn = useServerFn(getXauusdPaperProfile);
  const healthFn = useServerFn(getXauusdPaperHealth);
  const listFn = useServerFn(listXauusdPaperSignals);
  const setEnabledFn = useServerFn(setXauusdPaperEnabled);
  const subFn = useServerFn(mySubscription);
  const qc = useQueryClient();

  const profileQ = useQuery({ queryKey: ["xauusd-paper-profile"], queryFn: () => profileFn() });
  const healthQ = useQuery({ queryKey: ["xauusd-paper-health"], queryFn: () => healthFn() });
  const signalsQ = useQuery({
    queryKey: ["xauusd-paper-signals", false],
    queryFn: () => listFn({ data: { archived: false } }),
  });
  const subQ = useQuery({ queryKey: ["subscription"], queryFn: () => subFn() });

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => setEnabledFn({ data: { enabled } }),
    onSuccess: (_data, enabled) => {
      qc.invalidateQueries({ queryKey: ["xauusd-paper-profile"] });
      qc.invalidateQueries({ queryKey: ["xauusd-paper-health"] });
      qc.invalidateQueries({ queryKey: ["xauusd-paper-signals"] });
      toast.success(
        enabled
          ? "Auto-Paper enabled — the worker starts on the next minute."
          : "Auto-Paper disabled.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const signals = signalsQ.data ?? [];
  const active = signals.filter((s) => ACTIVE_TRADE_STATES.includes(s.trade.state)).length;
  const longs = signals.filter((s) => s.direction === "long").length;
  const shorts = signals.filter((s) => s.direction === "short").length;
  const avgConf = signals.length
    ? Math.round(signals.reduce((a, s) => a + s.confluence, 0) / signals.length)
    : 0;

  return (
    <div className="p-6 space-y-6 animate-fade-up">
      <header className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            // OPERATOR_TERMINAL
          </div>
          <h1 className="mt-1 text-2xl font-bold text-white">
            Welcome back,{" "}
            <span className="text-neon-accent">{email?.split("@")[0] ?? "trader"}</span>
          </h1>
        </div>
      </header>

      <XauusdAutoPaperPanel
        profile={profileQ.data}
        health={healthQ.data}
        mutating={toggleEnabled.isPending}
        onEnabledChange={(enabled) => toggleEnabled.mutate(enabled)}
      />

      {!subQ.data?.subscription && (
        <div className="rounded-lg border border-neon-warn/40 bg-neon-warn/5 p-4 flex items-start gap-3">
          <KeyRound className="size-4 text-neon-warn mt-0.5" />
          <div className="flex-1">
            <div className="text-sm text-white font-bold">Redeem your subscription key</div>
            <p className="text-xs text-muted-foreground mt-1">
              Unlock full 28-strategy confluence, MT5 automation, and AI consult.
            </p>
          </div>
          <Link to="/redeem" className="text-xs font-mono text-neon-warn hover:underline">
            REDEEM →
          </Link>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <StatCard icon={Radio} label="ACTIVE TRADES" value={active} tone="accent" />
        <StatCard icon={TrendingUp} label="LONGS" value={longs} tone="long" />
        <StatCard icon={AlertTriangle} label="SHORTS" value={shorts} tone="short" />
        <StatCard icon={Activity} label="AVG CONFLUENCE" value={`${avgConf}%`} tone="accent" />
      </div>

      <section className="rounded-lg border border-cyber-border bg-cyber-surface">
        <div className="px-4 py-3 border-b border-cyber-border flex items-center justify-between">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            // RECENT_PAPER_SIGNALS
          </h2>
          <Link to="/signals" className="text-[10px] font-mono text-neon-accent hover:underline">
            VIEW_ALL →
          </Link>
        </div>
        <div className="divide-y divide-cyber-border">
          {signalsQ.isLoading && (
            <div className="p-6 text-sm text-muted-foreground">Loading paper signals…</div>
          )}
          {!signalsQ.isLoading && signals.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">
              {healthQ.data?.status === "migration_required"
                ? "The Auto-Paper schema is not deployed yet — run the paper-trading migrations before paper signals can appear."
                : healthQ.data?.code === "no_health_reported"
                  ? "The worker has not reported health yet — paper signals appear once it is deployed and the minute cron is running."
                  : "No paper signals yet. Auto-Paper is disabled or the worker is degraded — enable Auto-Paper above and the worker publishes eligible XAUUSD signals automatically."}
            </div>
          )}
          {signals.slice(0, 8).map((s) => (
            <PaperSignalRow key={s.id} signal={s} />
          ))}
        </div>
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Radio;
  label: string;
  value: string | number;
  tone: "accent" | "long" | "short";
}) {
  const color =
    tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : "text-neon-accent";
  return (
    <div className="rounded-lg border border-cyber-border bg-cyber-surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          {label}
        </span>
        <Icon className={`size-4 ${color}`} />
      </div>
      <div className={`mt-2 text-2xl font-mono-strong font-bold ${color}`}>{value}</div>
    </div>
  );
}

const TRADE_STATE_LABEL: Record<string, string> = {
  waiting_entry: "WAITING_ENTRY",
  open: "OPEN",
  tp1_protected: "TP1_PROTECTED",
  closed_tp2: "CLOSED_TP2 +2.0R",
  closed_breakeven: "SCRATCHED 0.0R",
  closed_stop: "CLOSED_SL −1.0R",
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
        : signal.trade.state === "closed_breakeven"
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
      <div className="col-span-2">
        <div className="h-1.5 rounded bg-cyber-border overflow-hidden">
          <div className="h-full bg-neon-accent" style={{ width: `${signal.confluence}%` }} />
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {signal.confluence}% conf · 0.01 lot
        </div>
      </div>
      <div className="col-span-1">
        <span className={`uppercase text-[10px] ${stateTone}`}>{stateLabel}</span>
      </div>
      <div className="col-span-3 text-[10px] text-muted-foreground truncate">
        <span title={signal.timestampUtc} className="text-white">
          {signal.timestampPht}
        </span>
        <span className="ml-2">{signal.contributingStrategies.slice(0, 2).join(" · ")}</span>
      </div>
    </div>
  );
}
