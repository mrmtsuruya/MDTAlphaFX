import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listUsage } from "@/lib/ai-consult.functions";

export const Route = createFileRoute("/_authenticated/usage")({
  head: () => ({
    meta: [
      { title: "Token Usage — MDTAlphaFX" },
      { name: "description", content: "AI token and credit consumption across models." },
      { property: "og:title", content: "Token Usage — MDTAlphaFX" },
      { property: "og:description", content: "AI token and credit consumption across models." },
    ],
  }),
  component: Usage,
});

function Usage() {
  const fn = useServerFn(listUsage);
  const q = useQuery({ queryKey: ["usage"], queryFn: () => fn() });
  const usage = q.data?.usage ?? [];

  const byModel = usage.reduce<Record<string, { in: number; out: number; calls: number }>>(
    (a, u) => {
      a[u.model] ??= { in: 0, out: 0, calls: 0 };
      a[u.model].in += u.input_tokens;
      a[u.model].out += u.output_tokens;
      a[u.model].calls += 1;
      return a;
    },
    {},
  );

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // TOKEN_LEDGER
        </div>
        <h1 className="text-2xl font-bold text-white">Token & Credit Usage</h1>
      </header>

      <div className="grid gap-3 md:grid-cols-3">
        {Object.entries(byModel).map(([model, s]) => (
          <div key={model} className="rounded-lg border border-cyber-border bg-cyber-surface p-4">
            <div className="text-[10px] font-mono uppercase text-muted-foreground truncate">
              {model}
            </div>
            <div className="mt-2 text-2xl font-bold text-neon-accent">{s.calls}</div>
            <div className="text-[10px] font-mono text-muted-foreground">CALLS</div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-mono">
              <div>
                <span className="text-muted-foreground">IN </span>
                <span className="text-white">{s.in}</span>
              </div>
              <div>
                <span className="text-muted-foreground">OUT </span>
                <span className="text-white">{s.out}</span>
              </div>
            </div>
          </div>
        ))}
        {Object.keys(byModel).length === 0 && (
          <div className="col-span-3 rounded-lg border border-cyber-border bg-cyber-surface p-8 text-center text-sm text-muted-foreground">
            No AI consults yet. Ask AI on a signal to start tracking usage.
          </div>
        )}
      </div>

      <section className="rounded-lg border border-cyber-border bg-cyber-surface">
        <div className="px-4 py-3 border-b border-cyber-border">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-neon-accent">
            // RECENT_CALLS
          </h2>
        </div>
        <div className="divide-y divide-cyber-border">
          {usage.slice(0, 30).map((u) => (
            <div key={u.id} className="p-3 flex items-center gap-3 font-mono text-xs">
              <span className="text-muted-foreground w-40 truncate">{u.model}</span>
              <span className="text-white flex-1">{u.purpose}</span>
              <span className="text-neon-accent">
                {u.input_tokens}→{u.output_tokens}
              </span>
              <span className="text-muted-foreground">
                {new Date(u.created_at).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
