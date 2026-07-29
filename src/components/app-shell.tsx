import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
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
              {!collapsed && (
                <div className="px-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  // {section.section}
                </div>
              )}
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

const TICKER = [
  { s: "EURUSD", p: "1.0842", c: "+0.12%" },
  { s: "GBPUSD", p: "1.2691", c: "-0.05%" },
  { s: "USDJPY", p: "156.24", c: "+0.31%" },
  { s: "AUDUSD", p: "0.6584", c: "+0.08%" },
  { s: "USDCAD", p: "1.3721", c: "-0.11%" },
  { s: "NZDUSD", p: "0.6021", c: "+0.04%" },
  { s: "USDCHF", p: "0.8834", c: "+0.06%" },
  { s: "EURGBP", p: "0.8542", c: "+0.02%" },
  { s: "XAUUSD", p: "2634.5", c: "+0.44%" },
  { s: "BTCUSD", p: "97,821", c: "+1.22%" },
];

function TopTicker() {
  const items = [...TICKER, ...TICKER];
  return (
    <div className="h-9 flex items-center border-b border-cyber-border bg-cyber-surface overflow-hidden">
      <div className="flex gap-6 whitespace-nowrap animate-marquee font-mono text-xs">
        {items.map((t, i) => {
          const up = t.c.startsWith("+");
          return (
            <span key={i} className="flex items-center gap-2 px-2">
              <span className="text-muted-foreground">{t.s}</span>
              <span className="text-white">{t.p}</span>
              <span className={up ? "text-neon-long" : "text-neon-short"}>{t.c}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
