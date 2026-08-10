import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listSignals, generateSignals } from "@/lib/signals.functions";
import { classifyOrder, isResolvedStatus, type OrderTicket } from "@/lib/order-ticket";
import { mySubscription } from "@/lib/subscriptions.functions";
import { Activity, Radio, TrendingUp, AlertTriangle, KeyRound } from "lucide-react";
import { Link } from "@tanstack/react-router";
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

function Dashboard() {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  const listFn = useServerFn(listSignals);
  const genFn = useServerFn(generateSignals);
  const subFn = useServerFn(mySubscription);
  const qc = useQueryClient();

  const signalsQ = useQuery({ queryKey: ["signals"], queryFn: () => listFn() });
  const subQ = useQuery({ queryKey: ["subscription"], queryFn: () => subFn() });

  const generate = useMutation({
    mutationFn: (mode: "intraday" | "scalper") => genFn({ data: { mode } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["signals"] });
      toast.success("Signals generated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const signals = signalsQ.data?.signals ?? [];
  const active = signals.filter(
    (s) => s.live_status === "valid" || s.live_status === "fresh",
  ).length;
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
        <div className="flex gap-2">
          <button
            onClick={() => generate.mutate("intraday")}
            disabled={generate.isPending}
            className="rounded-sm border border-neon-accent/40 bg-neon-accent/10 px-4 py-2 text-xs font-mono font-bold text-neon-accent hover:bg-neon-accent/20 transition disabled:opacity-50"
          >
            SCAN_INTRADAY
          </button>
          <button
            onClick={() => generate.mutate("scalper")}
            disabled={generate.isPending}
            className="rounded-sm border border-neon-warn/40 bg-neon-warn/10 px-4 py-2 text-xs font-mono font-bold text-neon-warn hover:bg-neon-warn/20 transition disabled:opacity-50"
          >
            SCAN_SCALPER
          </button>
        </div>
      </header>

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
        <StatCard icon={Radio} label="ACTIVE SIGNALS" value={active} tone="accent" />
        <StatCard icon={TrendingUp} label="LONGS" value={longs} tone="long" />
        <StatCard icon={AlertTriangle} label="SHORTS" value={shorts} tone="short" />
        <StatCard icon={Activity} label="AVG CONFLUENCE" value={`${avgConf}%`} tone="accent" />
      </div>

      <section className="rounded-lg border border-cyber-border bg-cyber-surface">
        <div className="px-4 py-3 border-b border-cyber-border flex items-center justify-between">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            // RECENT_SIGNALS
          </h2>
          <Link to="/signals" className="text-[10px] font-mono text-neon-accent hover:underline">
            VIEW_ALL →
          </Link>
        </div>
        <div className="divide-y divide-cyber-border">
          {signalsQ.isLoading && (
            <div className="p-6 text-sm text-muted-foreground">Loading signals…</div>
          )}
          {!signalsQ.isLoading && signals.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">
              No signals yet. Click SCAN_INTRADAY or SCAN_SCALPER to generate.
            </div>
          )}
          {signals.slice(0, 8).map((s) => (
            <SignalRow key={s.id} signal={s} />
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

type SignalRowData = {
  pair: string;
  direction: "long" | "short";
  timeframe: string;
  entry: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  confluence: number;
  contributing_strategies: string[];
  status: string;
  live_status?: string;
  market_data_verified?: boolean;
  followable?: boolean;
  follow_distance_pct?: number | null;
  live_mid?: number | null;
};

const STATUS_LABEL: Record<string, string> = {
  fresh: "FRESH",
  valid: "VALID",
  late: "LATE",
  invalidated: "INVALIDATED",
  hit_tp1: "BE_AFTER_TP1",
  hit_tp2: "TP2_HIT",
  hit_sl: "SL_HIT",
};

const TICKET_TEXT: Record<OrderTicket["tone"], string> = {
  long: "text-neon-long",
  short: "text-neon-short",
  warn: "text-neon-warn",
  dead: "text-muted-foreground",
};

export function SignalRow({ signal }: { signal: SignalRowData }) {
  const long = signal.direction === "long";
  const verified = signal.market_data_verified === true;
  const status: string = signal.live_status ?? signal.status;
  const resolved = isResolvedStatus(status);
  const tooLate = verified && !resolved && signal.followable === false;
  // Resolved rows keep their historical direction; open ones show the order
  // you'd actually place right now, derived from the live mid.
  const ticket =
    verified && !resolved
      ? classifyOrder(signal, signal.live_mid)
      : {
          label: long ? "LONG" : "SHORT",
          note: "",
          tone: long ? ("long" as const) : ("short" as const),
        };
  const statusColor: Record<string, string> = {
    fresh: "text-neon-long",
    valid: "text-neon-long",
    late: "text-neon-warn",
    invalidated: "text-neon-short",
    hit_tp1: "text-muted-foreground",
    hit_tp2: "text-neon-long",
    hit_sl: "text-neon-short",
  };
  return (
    <div className="grid grid-cols-12 gap-2 px-4 py-3 items-center font-mono text-xs hover:bg-cyber-surface-2 transition">
      <div className="col-span-2 flex items-center gap-2">
        <span
          className={`inline-block size-2 rounded-full ${long ? "bg-neon-long" : "bg-neon-short"}`}
        />
        <span className="text-white font-bold">{signal.pair}</span>
        {/* The placeable order rather than a bare direction — BUY STOP for a
            breakout, BUY LIMIT for a pullback, TOO LATE / INVALIDATED once
            price has taken TP1 or the stop. */}
        <span className={TICKET_TEXT[ticket.tone]} title={ticket.note}>
          {ticket.label}
        </span>
      </div>
      <div className="col-span-1 text-muted-foreground">{signal.timeframe}</div>
      <div className="col-span-1 text-white">{verified ? signal.entry : "—"}</div>
      <div className="col-span-1 text-neon-short">{verified ? signal.stop_loss : "—"}</div>
      <div className="col-span-1 text-neon-long">{verified ? signal.take_profit_1 : "—"}</div>
      <div className="col-span-1 text-neon-long">{verified ? signal.take_profit_2 : "—"}</div>
      <div className="col-span-2">
        <div className="h-1.5 rounded bg-cyber-border overflow-hidden">
          <div
            className={`h-full ${verified ? "bg-neon-accent" : "bg-neon-warn/40"}`}
            style={{ width: verified ? `${signal.confluence}%` : "100%" }}
          />
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5">
          {verified ? `${signal.confluence}% conf` : "legacy demo"}
        </div>
      </div>
      <div className="col-span-1 flex flex-col items-start gap-0.5">
        <span className={`uppercase text-[10px] ${statusColor[status] ?? "text-muted-foreground"}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
        {tooLate && (
          <span
            className="uppercase text-[9px] text-neon-warn"
            title={
              signal.follow_distance_pct != null
                ? `Price has moved ${Math.abs(signal.follow_distance_pct * 100).toFixed(0)}% of the risk distance from entry`
                : "Price has moved beyond the entry zone"
            }
          >
            TOO_LATE
          </span>
        )}
        {resolved && (
          <span className="uppercase text-[9px] text-muted-foreground">
            {status === "hit_tp2" ? "+2.0R" : status === "hit_tp1" ? "0.0R" : "−1.0R"}
          </span>
        )}
      </div>
      <div className="col-span-2 text-[10px] text-muted-foreground truncate">
        {verified
          ? (signal.contributing_strategies as string[]).slice(0, 3).join(" · ")
          : "strategy labels hidden"}
      </div>
    </div>
  );
}
