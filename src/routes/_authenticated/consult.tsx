import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Bot, Send } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listSignals } from "@/lib/signals.functions";
import { consultOnSignal } from "@/lib/ai-consult.functions";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/consult")({
  head: () => ({
    meta: [
      { title: "AI Consult — MDTAlphaFX" },
      { name: "description", content: "Ask Gemini or GPT for a take/skip verdict on any signal." },
      { property: "og:title", content: "AI Consult — MDTAlphaFX" },
      {
        property: "og:description",
        content: "Ask Gemini or GPT for a take/skip verdict on any signal.",
      },
    ],
  }),
  component: Consult,
});

const MODELS = [
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini" },
] as const;

function Consult() {
  const listFn = useServerFn(listSignals);
  const consultFn = useServerFn(consultOnSignal);
  const q = useQuery({ queryKey: ["signals"], queryFn: () => listFn() });
  const [model, setModel] = useState<(typeof MODELS)[number]["id"]>("google/gemini-3.6-flash");
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function ask() {
    if (!selected) {
      toast.error("Select a signal first");
      return;
    }
    setBusy(true);
    setOutput("Analyzing…");
    try {
      const r = await consultFn({ data: { signalId: selected, model } });
      setOutput(r.text);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOutput("");
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  const signals = q.data?.signals ?? [];

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // AI_CONSULT
        </div>
        <h1 className="text-2xl font-bold text-white">AI Consult</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Get an independent verdict from Gemini or GPT on any generated signal.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <aside className="rounded-lg border border-cyber-border bg-cyber-surface p-4 space-y-3">
          <div>
            <label className="text-[10px] font-mono uppercase text-muted-foreground">MODEL</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as (typeof MODELS)[number]["id"])}
              className="mt-1 w-full rounded-sm border border-cyber-border bg-cyber-bg px-2 py-1.5 text-sm text-white"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase text-muted-foreground">SIGNAL</label>
            <div className="mt-1 max-h-72 overflow-auto rounded-sm border border-cyber-border bg-cyber-bg divide-y divide-cyber-border">
              {signals.length === 0 && (
                <div className="p-3 text-xs text-muted-foreground">
                  No signals — generate some first.
                </div>
              )}
              {signals.slice(0, 30).map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelected(s.id)}
                  className={`w-full text-left px-3 py-2 text-xs font-mono ${
                    selected === s.id
                      ? "bg-neon-accent/10 text-neon-accent"
                      : "text-muted-foreground hover:text-white hover:bg-cyber-surface"
                  }`}
                >
                  {s.pair} ·{" "}
                  <span className={s.direction === "long" ? "text-neon-long" : "text-neon-short"}>
                    {s.direction.toUpperCase()}
                  </span>{" "}
                  · {s.confluence}%
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={ask}
            disabled={busy}
            className="w-full inline-flex items-center justify-center gap-2 rounded-sm bg-neon-accent px-3 py-2 font-mono text-xs font-bold text-cyber-bg hover:brightness-110 disabled:opacity-50"
          >
            <Send className="size-3" /> {busy ? "…" : "ASK_AI"}
          </button>
        </aside>

        <section className="rounded-lg border border-cyber-border bg-cyber-surface p-6 min-h-[400px]">
          <div className="flex items-center gap-2 mb-3">
            <Bot className="size-4 text-neon-accent" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              // AI_VERDICT
            </span>
          </div>
          {!output ? (
            <p className="text-sm text-muted-foreground">
              Select a signal and pick a model to receive a take/skip verdict.
            </p>
          ) : (
            <pre className="text-sm text-white font-mono whitespace-pre-wrap">{output}</pre>
          )}
        </section>
      </div>
    </div>
  );
}
