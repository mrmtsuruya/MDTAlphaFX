import { createFileRoute } from "@tanstack/react-router";
import { Newspaper } from "lucide-react";

export const Route = createFileRoute("/_authenticated/news")({
  head: () => ({
    meta: [
      { title: "Market News — MDTAlphaFX" },
      { name: "description", content: "Live macro news and geopolitical events impacting FX." },
      { property: "og:title", content: "Market News — MDTAlphaFX" },
      { property: "og:description", content: "Live macro news and geopolitical events impacting FX." },
    ],
  }),
  component: News,
});

const MOCK = [
  { t: "USD", title: "Fed minutes signal patience on next cut", impact: "high", time: "12m ago" },
  { t: "EUR", title: "ECB Lagarde: inflation risks tilted to upside", impact: "medium", time: "34m ago" },
  { t: "JPY", title: "BoJ intervention chatter as USDJPY tests 156.5", impact: "high", time: "1h ago" },
  { t: "GBP", title: "UK CPI prints hotter than expected at 3.4%", impact: "medium", time: "2h ago" },
  { t: "AUD", title: "RBA holds rate; hawkish forward guidance", impact: "medium", time: "3h ago" },
  { t: "OIL", title: "OPEC+ delays output hike into Q2", impact: "low", time: "5h ago" },
  { t: "GEO", title: "Escalation risk in Middle East drives risk-off flows", impact: "high", time: "6h ago" },
];

function News() {
  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// MACRO_FEED</div>
        <h1 className="text-2xl font-bold text-white">Market News & Geopolitical Impact</h1>
        <p className="text-sm text-muted-foreground mt-1">Live macro news that feeds the signal validity engine.</p>
      </header>
      <div className="rounded-lg border border-cyber-border bg-cyber-surface divide-y divide-cyber-border">
        {MOCK.map((n, i) => (
          <div key={i} className="p-4 flex items-start gap-3 hover:bg-cyber-surface-2">
            <span className={`font-mono text-[10px] px-2 py-1 rounded ${
              n.impact === "high" ? "bg-neon-short/20 text-neon-short" :
              n.impact === "medium" ? "bg-neon-warn/20 text-neon-warn" :
              "bg-cyber-border text-muted-foreground"
            }`}>{n.t}</span>
            <div className="flex-1">
              <div className="text-sm text-white">{n.title}</div>
              <div className="text-[10px] font-mono text-muted-foreground mt-1">
                IMPACT_{n.impact.toUpperCase()} · {n.time}
              </div>
            </div>
            <Newspaper className="size-4 text-muted-foreground" />
          </div>
        ))}
      </div>
      <p className="text-[10px] font-mono text-muted-foreground">
        // Live news wire integration is stubbed. Wire a provider (Finnhub, TradingEconomics, or ForexFactory) via a scheduled server route to populate real events.
      </p>
    </div>
  );
}
