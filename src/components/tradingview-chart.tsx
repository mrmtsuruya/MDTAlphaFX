// TradingView's own advanced-chart widget, embedded as the ANALYSIS view.
//
// Why this exists alongside the signal chart rather than replacing it:
//
// The widget is a cross-origin iframe served from s3.tradingview.com. You hand
// it a config object at load time and after that the host page has no scripting
// access to it — there is no drawing API on the free embed. So it can never
// show ENTRY/SL/TP levels, the strategy markup, or the live tick engine's
// staleness state. What it CAN do, and the signal chart can't, is give you
// TradingView's full analysis toolkit: drawing tools, the indicator library,
// replay, multi-chart layouts.
//
// Keeping both means neither capability is traded away. The scanner panel is
// unaffected either way — it owns its own quote query and its own scan.
//
// Note this is third-party JavaScript loaded into the page. It is the same
// vendor the app already depends on for quotes (scanner.tradingview.com), but
// unlike those server-side calls this one runs in the browser.

import { useEffect, useRef } from "react";
import { MARKET_TIMEFRAMES, TV_SYMBOLS } from "@/lib/market-data.server";

type Granularity = (typeof MARKET_TIMEFRAMES)[number];

/** App granularity -> the widget's `interval` codes. */
const TV_INTERVALS: Record<Granularity, string> = {
  M1: "1",
  M5: "5",
  M15: "15",
  M30: "30",
  H1: "60",
  H4: "240",
  D1: "D",
};

const WIDGET_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";

export function TradingViewChart({ pair, timeframe }: { pair: string; timeframe: Granularity }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    // Each mount gets its OWN wrapper, and the shared container is never
    // blanked. That matters because the vendor script is async and reads its
    // own parent element when it finally executes: detach it mid-flight and
    // their bundle throws `Cannot read properties of null (reading
    // 'querySelector')`. Clicking through timeframes faster than the script
    // loads reproduced that every time when this cleared innerHTML on entry.
    //
    // So a wrapper is only ever removed once its own script has finished — by
    // the cleanup if it already loaded, otherwise by the load handler itself.
    // Worst case two wrappers overlap for the length of one script fetch, and
    // the stale one removes itself.
    const wrapper = document.createElement("div");
    wrapper.className = "tradingview-widget-container h-full w-full";

    let loaded = false;
    let cancelled = false;
    const settle = () => {
      loaded = true;
      if (cancelled) wrapper.remove();
    };

    const script = document.createElement("script");
    script.src = WIDGET_SRC;
    script.async = true;
    script.addEventListener("load", settle);
    // A blocked or offline CDN never fires `load`, so release the deferred
    // removal here too rather than leaking the dead wrapper.
    script.addEventListener("error", settle);
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: TV_SYMBOLS[pair] ?? `OANDA:${pair}`,
      interval: TV_INTERVALS[timeframe] ?? "60",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      toolbar_bg: "#0f1115",
      enable_publishing: false,
      // The pair and timeframe are driven by the terminal's own controls so
      // this view always matches the scanner sitting next to it. Letting the
      // widget change symbol on its own would silently desync the two, and the
      // scanner gives no hint that the chart has wandered off.
      allow_symbol_change: false,
      hide_side_toolbar: false,
      withdateranges: true,
      details: false,
      hotlist: false,
      calendar: false,
      studies: ["STD;RSI", "STD;ATR"],
      support_host: "https://www.tradingview.com",
    });
    wrapper.appendChild(script);
    node.appendChild(wrapper);

    return () => {
      cancelled = true;
      if (loaded) wrapper.remove();
    };
  }, [pair, timeframe]);

  return (
    <div className="relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-cyber-border bg-cyber-surface">
      <div ref={containerRef} className="h-full w-full min-h-[380px]" />
      <div className="pointer-events-none absolute left-3 top-3 z-10 rounded-sm border border-cyber-border bg-cyber-bg/85 px-2 py-1 font-mono text-[9px] text-muted-foreground backdrop-blur">
        ANALYSIS_VIEW · {pair} · {timeframe} · no signal overlays here — switch to SIGNAL
      </div>
    </div>
  );
}
