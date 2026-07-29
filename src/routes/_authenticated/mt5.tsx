import { createFileRoute } from "@tanstack/react-router";
import { ServerCog, Copy } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/mt5")({
  head: () => ({
    meta: [
      { title: "MT5 Bridge — MDTAlphaFX" },
      { name: "description", content: "Automate signals into MetaTrader 5 via the MDTAlphaFX Expert Advisor bridge." },
      { property: "og:title", content: "MT5 Bridge — MDTAlphaFX" },
      { property: "og:description", content: "Automate signals into MetaTrader 5 via the MDTAlphaFX Expert Advisor bridge." },
    ],
  }),
  component: MT5,
});

function MT5() {
  const endpoint = typeof window !== "undefined" ? `${window.location.origin}/api/public/mt5/pull` : "";
  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// MT5_BRIDGE</div>
        <h1 className="text-2xl font-bold text-white">MetaTrader 5 Automation</h1>
        <p className="text-sm text-muted-foreground mt-1">Install the MDTAlphaFX EA on your MT5 terminal (demo or real) and it will poll fresh signals and place trades with your SL/TP/lot settings.</p>
      </header>

      <div className="rounded-lg border border-cyber-border bg-cyber-surface p-4 space-y-3">
        <div>
          <div className="text-[10px] font-mono uppercase text-muted-foreground">SIGNAL PULL ENDPOINT</div>
          <div className="mt-1 flex items-center gap-2 rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2">
            <code className="text-xs font-mono text-neon-accent flex-1 truncate">{endpoint}</code>
            <button onClick={() => { navigator.clipboard.writeText(endpoint); toast.success("Copied"); }} className="text-muted-foreground hover:text-white">
              <Copy className="size-3" />
            </button>
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono uppercase text-muted-foreground">API KEY</div>
          <div className="mt-1 rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2">
            <code className="text-xs font-mono text-muted-foreground">Generate a personal API key in Settings → API Keys (coming soon)</code>
          </div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {[
          { l: "MAX RISK / TRADE", v: "1.0%" },
          { l: "MAX OPEN TRADES", v: "3" },
          { l: "AUTO-EXECUTE", v: "OFF" },
          { l: "MIN CONFLUENCE", v: "70%" },
          { l: "MODES", v: "INTRADAY" },
          { l: "TP MODE", v: "TP1 50% · TP2 50%" },
        ].map((p) => (
          <div key={p.l} className="rounded-lg border border-cyber-border bg-cyber-surface p-4">
            <div className="text-[10px] font-mono uppercase text-muted-foreground">{p.l}</div>
            <div className="mt-1 text-lg font-mono-strong text-white">{p.v}</div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-cyber-border bg-cyber-surface p-6">
        <div className="flex items-center gap-2 mb-3">
          <ServerCog className="size-4 text-neon-accent" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// EA_DOWNLOAD</span>
        </div>
        <p className="text-sm text-muted-foreground">The MDTAlphaFX.mq5 Expert Advisor and installation guide will be delivered here once the MT5 bridge is finalized. The EA connects with your personal API key and executes trades based on your risk parameters above.</p>
      </div>
    </div>
  );
}
