import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listSignals, generateSignals, invalidateSignal } from "@/lib/signals.functions";
import { consultOnSignal } from "@/lib/ai-consult.functions";
import { SignalRow } from "./dashboard";
import { useState } from "react";
import { toast } from "sonner";
import { Bot } from "lucide-react";

export const Route = createFileRoute("/_authenticated/signals")({
  head: () => ({
    meta: [
      { title: "Signal Center — MDTAlphaFX" },
      { name: "description", content: "All live and historical trading signals with AI consult." },
      { property: "og:title", content: "Signal Center — MDTAlphaFX" },
      { property: "og:description", content: "All live and historical trading signals with AI consult." },
    ],
  }),
  component: Signals,
});

function Signals() {
  const listFn = useServerFn(listSignals);
  const genFn = useServerFn(generateSignals);
  const invalidateFn = useServerFn(invalidateSignal);
  const consultFn = useServerFn(consultOnSignal);
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"all" | "intraday" | "scalper">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [consultText, setConsultText] = useState<string | null>(null);

  const q = useQuery({ queryKey: ["signals"], queryFn: () => listFn() });

  const gen = useMutation({
    mutationFn: (mode: "intraday" | "scalper") => genFn({ data: { mode } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["signals"] }); toast.success("Scan complete"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const inv = useMutation({
    mutationFn: (id: string) => invalidateFn({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["signals"] }); toast.success("Signal invalidated"); },
  });
  const consult = useMutation({
    mutationFn: (id: string) => consultFn({ data: { signalId: id, model: "google/gemini-3.6-flash" } }),
    onSuccess: (d) => { setConsultText(d.text); toast.success("AI verdict ready"); },
    onError: (e: Error) => toast.error(e.message),
  });

  const signals = (q.data?.signals ?? []).filter((s) => filter === "all" ? true : s.mode === filter);

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// SIGNAL_CENTER</div>
          <h1 className="text-2xl font-bold text-white">Signal Center</h1>
        </div>
        <div className="flex gap-2">
          {(["all", "intraday", "scalper"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-sm border px-3 py-1.5 text-[10px] font-mono uppercase tracking-widest transition ${
                filter === f
                  ? "border-neon-accent/40 bg-neon-accent/10 text-neon-accent"
                  : "border-cyber-border bg-cyber-surface text-muted-foreground hover:text-white"
              }`}
            >{f}</button>
          ))}
          <button
            onClick={() => gen.mutate("intraday")}
            disabled={gen.isPending}
            className="rounded-sm border border-neon-accent/40 bg-neon-accent/10 px-3 py-1.5 text-[10px] font-mono font-bold text-neon-accent hover:bg-neon-accent/20 transition disabled:opacity-50"
          >SCAN_INTRADAY</button>
          <button
            onClick={() => gen.mutate("scalper")}
            disabled={gen.isPending}
            className="rounded-sm border border-neon-warn/40 bg-neon-warn/10 px-3 py-1.5 text-[10px] font-mono font-bold text-neon-warn hover:bg-neon-warn/20 transition disabled:opacity-50"
          >SCAN_SCALPER</button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <section className="rounded-lg border border-cyber-border bg-cyber-surface">
          <div className="divide-y divide-cyber-border max-h-[70vh] overflow-auto">
            {q.isLoading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
            {!q.isLoading && signals.length === 0 && (
              <div className="p-6 text-sm text-muted-foreground">No signals. Run a scan.</div>
            )}
            {signals.map((s) => (
              <div
                key={s.id}
                onClick={() => setSelected(s.id)}
                className={`cursor-pointer ${selected === s.id ? "bg-cyber-surface-2" : ""}`}
              >
                <SignalRow signal={s} />
              </div>
            ))}
          </div>
        </section>

        <aside className="rounded-lg border border-cyber-border bg-cyber-surface p-4 h-fit sticky top-4">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// SIGNAL_INSPECTOR</h2>
          {!selected ? (
            <p className="mt-3 text-sm text-muted-foreground">Select a signal to inspect and consult AI.</p>
          ) : (() => {
            const s = signals.find((x) => x.id === selected);
            if (!s) return <p className="mt-3 text-sm text-muted-foreground">Signal not found.</p>;
            return (
              <div className="mt-3 space-y-3 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-white font-bold">{s.pair} · {s.direction.toUpperCase()}</span>
                  <span className="text-neon-accent">{s.confluence}%</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Entry" value={s.entry} />
                  <Field label="ATR" value={s.atr} />
                  <Field label="SL" value={s.stop_loss} tone="short" />
                  <Field label="TP1" value={s.take_profit_1} tone="long" />
                  <Field label="TP2" value={s.take_profit_2} tone="long" />
                  <Field label="TF" value={s.timeframe} />
                </div>
                <div>
                  <div className="text-[10px] uppercase text-muted-foreground">Strategies</div>
                  <div className="text-[11px] text-white">{(s.contributing_strategies as string[]).join(" · ")}</div>
                </div>
                <p className="text-[11px] text-muted-foreground">{s.rationale}</p>
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => consult.mutate(s.id)}
                    disabled={consult.isPending}
                    className="flex-1 inline-flex items-center justify-center gap-1 rounded-sm border border-neon-accent/40 bg-neon-accent/10 px-2 py-1.5 text-[10px] font-mono text-neon-accent hover:bg-neon-accent/20 disabled:opacity-50"
                  ><Bot className="size-3" /> AI_CONSULT</button>
                  <button
                    onClick={() => inv.mutate(s.id)}
                    className="rounded-sm border border-neon-short/40 bg-neon-short/10 px-2 py-1.5 text-[10px] font-mono text-neon-short hover:bg-neon-short/20"
                  >INVALIDATE</button>
                </div>
                {consultText && (
                  <div className="rounded-sm border border-cyber-border bg-cyber-bg p-3 whitespace-pre-wrap text-[11px] text-white">
                    {consultText}
                  </div>
                )}
              </div>
            );
          })()}
        </aside>
      </div>
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: any; tone?: "long" | "short" }) {
  const color = tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : "text-white";
  return (
    <div>
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={`${color}`}>{String(value)}</div>
    </div>
  );
}
