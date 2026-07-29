import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/_authenticated/chart")({
  head: () => ({
    meta: [
      { title: "Live Chart — MDTAlphaFX" },
      { name: "description", content: "Real-time TradingView forex chart integrated into the terminal." },
      { property: "og:title", content: "Live Chart — MDTAlphaFX" },
      { property: "og:description", content: "Real-time TradingView forex chart integrated into the terminal." },
    ],
  }),
  component: Chart,
});

const PAIRS = ["OANDA:EURUSD","OANDA:GBPUSD","OANDA:USDJPY","OANDA:AUDUSD","OANDA:USDCAD","OANDA:NZDUSD","OANDA:XAUUSD"];

function Chart() {
  const [symbol, setSymbol] = useState("OANDA:EURUSD");
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    container.current.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: "60",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      toolbar_bg: "#0f1115",
      enable_publishing: false,
      allow_symbol_change: true,
      hide_side_toolbar: false,
      studies: ["STD;RSI", "STD;ATR"],
      support_host: "https://www.tradingview.com",
    });
    container.current.appendChild(script);
  }, [symbol]);

  return (
    <div className="p-6 space-y-4 animate-fade-up h-[calc(100vh-3.5rem)] flex flex-col">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// LIVE_CHART</div>
          <h1 className="text-2xl font-bold text-white">Live Chart</h1>
        </div>
        <div className="flex gap-1 flex-wrap">
          {PAIRS.map((p) => (
            <button
              key={p}
              onClick={() => setSymbol(p)}
              className={`rounded-sm border px-3 py-1.5 text-[10px] font-mono transition ${
                symbol === p
                  ? "border-neon-accent/40 bg-neon-accent/10 text-neon-accent"
                  : "border-cyber-border bg-cyber-surface text-muted-foreground hover:text-white"
              }`}
            >{p.split(":")[1]}</button>
          ))}
        </div>
      </header>
      <div className="flex-1 rounded-lg border border-cyber-border bg-cyber-surface overflow-hidden">
        <div ref={container} className="tradingview-widget-container h-full w-full" />
      </div>
    </div>
  );
}
