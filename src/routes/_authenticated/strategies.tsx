import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

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
      { property: "og:description", content: "Enable, disable, and tune the 28 confluence strategies." },
    ],
  }),
  component: Strategies,
});

function Strategies() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: user } = await supabase.auth.getUser();
      const uid = user.user!.id;
      const [{ data: strats }, { data: sets }] = await Promise.all([
        supabase.from("strategies").select("id,name,category,description,timeframes").order("category"),
        supabase.from("strategy_settings").select("strategy_id, enabled").eq("user_id", uid),
      ]);
      setStrategies((strats ?? []) as Strategy[]);
      const map: Record<string, boolean> = {};
      (strats ?? []).forEach((s) => { map[s.id] = true; });
      (sets ?? []).forEach((s) => { map[s.strategy_id] = s.enabled; });
      setEnabled(map);
      setLoading(false);
    })();
  }, []);

  async function toggle(id: string) {
    const next = !enabled[id];
    setEnabled((e) => ({ ...e, [id]: next }));
    const { data: user } = await supabase.auth.getUser();
    const uid = user.user!.id;
    const { error } = await supabase.from("strategy_settings").upsert(
      { user_id: uid, strategy_id: id, enabled: next },
      { onConflict: "user_id,strategy_id" },
    );
    if (error) toast.error(error.message);
  }

  const grouped = strategies.reduce<Record<string, Strategy[]>>((a, s) => {
    (a[s.category] ??= []).push(s); return a;
  }, {});
  const enabledCount = Object.values(enabled).filter(Boolean).length;

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// STRATEGY_MATRIX</div>
        <h1 className="text-2xl font-bold text-white">
          Strategies <span className="text-neon-accent">{enabledCount}</span><span className="text-muted-foreground">/{strategies.length}</span>
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Toggle strategies used in confluence scanning. All 28 = maximum confluence.</p>
      </header>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {Object.entries(grouped).map(([cat, list]) => (
        <section key={cat}>
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-neon-accent mb-2">// {cat.replace("_"," ")}</h2>
          <div className="grid gap-2 md:grid-cols-2">
            {list.map((s) => (
              <label key={s.id} className={`flex items-start gap-3 rounded-sm border p-3 cursor-pointer transition ${
                enabled[s.id] ? "border-neon-accent/40 bg-neon-accent/5" : "border-cyber-border bg-cyber-surface hover:border-cyber-border"
              }`}>
                <input type="checkbox" checked={!!enabled[s.id]} onChange={() => toggle(s.id)} className="mt-0.5 accent-neon-accent" />
                <div className="flex-1">
                  <div className="text-sm font-bold text-white">{s.name}</div>
                  <div className="text-xs text-muted-foreground">{s.description}</div>
                  <div className="mt-1 flex gap-1 flex-wrap">
                    {s.timeframes.map((t) => (
                      <span key={t} className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyber-border text-muted-foreground">{t}</span>
                    ))}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
