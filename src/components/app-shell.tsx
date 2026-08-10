import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  Radio,
  LineChart,
  Newspaper,
  FlaskConical,
  Bot,
  Cpu,
  Sparkles,
  ServerCog,
  Activity,
  KeyRound,
  Sliders,
  LogOut,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { getMarketQuotes } from "@/lib/market-data.functions";

type NavItem = { to: string; label: string; icon: typeof LayoutDashboard; badge?: string };

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "TRADING",
    items: [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/signals", label: "Signal Center", icon: Radio, badge: "LIVE" },
      { to: "/chart", label: "Live Chart", icon: LineChart },
      { to: "/news", label: "Market News", icon: Newspaper },
      { to: "/strategies", label: "Strategies", icon: Sliders },
      { to: "/backtester", label: "Backtester", icon: FlaskConical },
      { to: "/mt5", label: "MT5 Bridge", icon: ServerCog },
    ],
  },
  {
    section: "AI",
    items: [
      { to: "/consult", label: "AI Consult", icon: Bot },
      { to: "/ai-news", label: "AI News", icon: Sparkles },
      { to: "/builder", label: "Vibe Builder", icon: Sparkles },
      { to: "/usage", label: "Token Usage", icon: Activity },
    ],
  },
  {
    section: "SYSTEM",
    items: [
      { to: "/system", label: "System Monitor", icon: Cpu },
      { to: "/redeem", label: "Subscription", icon: KeyRound },
    ],
  },
];

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [collapsed, setCollapsed] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/auth" });
  }

  return (
    <div className="flex min-h-screen w-full bg-cyber-bg text-foreground font-sans">
      <aside
        className={cn(
          "flex flex-col border-r border-cyber-border bg-cyber-bg transition-all",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div className="flex items-center justify-between px-3 h-14 border-b border-cyber-border">
          <Link to="/dashboard" className="flex items-center gap-2 overflow-hidden">
            <div className="size-8 shrink-0 rounded bg-neon-accent flex items-center justify-center font-black text-cyber-bg">
              FX
            </div>
            {!collapsed && (
              <span className="font-mono-strong font-bold tracking-tighter text-white text-lg">
                MDT<span className="text-neon-accent">ALPHA</span>
              </span>
            )}
          </Link>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-muted-foreground hover:text-neon-accent"
            aria-label="Toggle sidebar"
          >
            {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {NAV.map((section) => (
            <div key={section.section}>
              <ul className="space-y-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.to || pathname.startsWith(item.to + "/");
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition-colors",
                          active
                            ? "bg-neon-accent/10 text-neon-accent border-l-2 border-neon-accent"
                            : "text-muted-foreground hover:bg-cyber-surface hover:text-white border-l-2 border-transparent",
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                        {!collapsed && item.badge && (
                          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-neon-long/20 text-neon-long">
                            {item.badge}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-cyber-border p-2">
          {!collapsed && email && (
            <div className="px-2 pb-2 text-[10px] font-mono text-muted-foreground truncate">
              {email}
            </div>
          )}
          <button
            onClick={signOut}
            className="w-full flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-cyber-surface hover:text-neon-short"
          >
            <LogOut className="size-4" />
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <TopTicker />
        <main className="flex-1 overflow-auto">{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}

const TICKER_PAIRS = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "USDCAD",
  "NZDUSD",
  "USDCHF",
  "EURGBP",
  "XAUUSD",
] as const;

function formatTickerPrice(pair: string, price: number) {
  return price.toFixed(pair === "XAUUSD" || pair.endsWith("JPY") ? 3 : 5);
}

// Rolling per-pair mid samples from consecutive polls, used to derive the
// ~45s change shown in the ticker (like the old OANDA +/- tape).
type TickerSample = { mid: number; ts: number };
const TICKER_SAMPLE_WINDOW = 4;
const TICKER_BASELINE_MIN_AGE_MS = 30_000;

function TopTicker() {
  const quotesFn = useServerFn(getMarketQuotes);
  const quotes = useQuery({
    queryKey: ["market-quotes", TICKER_PAIRS],
    queryFn: () => quotesFn({ data: { pairs: [...TICKER_PAIRS] } }),
    refetchInterval: 15_000,
    retry: false,
  });
  const prevSamples = useRef(new Map<string, TickerSample[]>());

  // Record each poll's mid after render so the next poll can diff against it.
  useEffect(() => {
    if (!quotes.data?.quotes?.length) return;
    const now = Date.now();
    const next = new Map(prevSamples.current);
    for (const quote of quotes.data.quotes) {
      const samples = next.get(quote.pair) ?? [];
      samples.push({ mid: quote.mid, ts: now });
      if (samples.length > TICKER_SAMPLE_WINDOW) samples.shift();
      next.set(quote.pair, samples);
    }
    prevSamples.current = next;
  }, [quotes.data]);

  const ticker =
    quotes.data?.quotes.map((quote) => {
      const samples = prevSamples.current.get(quote.pair) ?? [];
      const baseline = samples[0];
      const changePct =
        baseline && Date.now() - baseline.ts >= TICKER_BASELINE_MIN_AGE_MS && baseline.mid > 0
          ? ((quote.mid - baseline.mid) / baseline.mid) * 100
          : null;
      return {
        s: quote.pair,
        p: formatTickerPrice(quote.pair, quote.mid),
        changePct,
      };
    }) ?? [];
  const items = ticker.length > 0 ? [...ticker, ...ticker] : [];
  const rateLimited = quotes.data?.status.rate_limit?.limited === true;

  return (
    <div className="h-9 flex items-center border-b border-cyber-border bg-cyber-surface overflow-hidden">
      {rateLimited && (
        <div className="shrink-0 h-full flex items-center px-3 font-mono text-[10px] text-neon-warn border-r border-cyber-border">
          RATE_LIMITED_RETRYING…
        </div>
      )}
      {items.length > 0 ? (
        <div className="flex gap-6 whitespace-nowrap animate-marquee font-mono text-xs">
          {items.map((tickerItem, index) => (
            <span key={`${tickerItem.s}-${index}`} className="flex items-center gap-2 px-2">
              <span className="text-muted-foreground">{tickerItem.s}</span>
              <span className="text-white">{tickerItem.p}</span>
              <TickerChange changePct={tickerItem.changePct} />
              <span className="text-neon-long">OANDA</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="px-4 font-mono text-[10px] text-neon-warn">
          {quotes.isLoading ? "CONNECTING_LIVE_FEED…" : "LIVE_FEED_OFFLINE"}
        </div>
      )}
    </div>
  );
}

function TickerChange({ changePct }: { changePct: number | null }) {
  if (changePct === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (changePct === 0) {
    return <span className="text-muted-foreground">· 0.00%</span>;
  }
  const up = changePct > 0;
  return (
    <span className={up ? "text-neon-long" : "text-neon-short"}>
      {up ? "▲" : "▼"} {up ? "+" : ""}
      {changePct.toFixed(2)}%
    </span>
  );
}
