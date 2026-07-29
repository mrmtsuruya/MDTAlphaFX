import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowRight, Zap, LineChart, Bot, Radio } from "lucide-react";

export const Route = createFileRoute("/")({
  ssr: false,
  beforeLoad: async () => {
    // If already authed, jump straight to dashboard.
    const { supabase } = await import("@/integrations/supabase/client");
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/dashboard" });
  },
  head: () => ({
    meta: [
      { title: "MDTAlphaFX — 28-strategy forex confluence terminal" },
      {
        name: "description",
        content:
          "Cyberpunk-grade forex signal engine. 28 confluence strategies, live macro news, AI consult on every signal, and MT5 automation.",
      },
      { property: "og:title", content: "MDTAlphaFX — 28-strategy forex confluence terminal" },
      {
        property: "og:description",
        content:
          "Cyberpunk-grade forex signal engine. 28 confluence strategies, live macro news, AI consult on every signal, and MT5 automation.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-cyber-bg text-foreground font-sans relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 scanline opacity-40" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 h-[500px] w-[900px] rounded-full blur-3xl opacity-30"
        style={{ background: "radial-gradient(closest-side, #00d1ff, transparent)" }}
      />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 border-b border-cyber-border">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded bg-neon-accent flex items-center justify-center font-black text-cyber-bg">
            FX
          </div>
          <span className="font-mono-strong font-bold tracking-tighter text-white text-xl">
            MDT<span className="text-neon-accent">ALPHA</span>
          </span>
        </div>
        <Link
          to="/auth"
          className="inline-flex items-center gap-2 rounded-sm border border-neon-accent/40 bg-neon-accent/10 px-4 py-2 text-sm font-mono text-neon-accent hover:bg-neon-accent/20 transition"
        >
          ACCESS_TERMINAL <ArrowRight className="size-4" />
        </Link>
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-neon-long/30 bg-neon-long/5 px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-neon-long">
            <span className="size-1.5 rounded-full bg-neon-long animate-pulse" />
            v4.0 // LIVE
          </div>
          <h1 className="mt-6 text-5xl md:text-7xl font-black tracking-tight text-white">
            The <span className="text-neon-accent">28-strategy</span> confluence
            <br />
            trading terminal.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl">
            MDTAlphaFX runs 28 professional forex strategies in parallel, cross-references
            live macro news &amp; geopolitical impact, and delivers ATR-anchored signals
            with entry, SL, TP1, TP2 — plus per-signal AI consult and MT5 automation.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 rounded-sm bg-neon-accent px-5 py-3 font-mono text-sm font-bold text-cyber-bg hover:brightness-110 transition glow-accent"
            >
              LAUNCH_TERMINAL <ArrowRight className="size-4" />
            </Link>
            <a
              href="#features"
              className="inline-flex items-center gap-2 rounded-sm border border-cyber-border bg-cyber-surface px-5 py-3 font-mono text-sm text-foreground hover:bg-cyber-surface-2"
            >
              FEATURE_MATRIX
            </a>
          </div>
        </div>

        <section id="features" className="mt-24 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Zap, title: "28 STRATEGIES", body: "Trend, momentum, harmonics, ICT order flow, news-reactive AI overlay — toggle any combination." },
            { icon: LineChart, title: "ATR SIGNALS", body: "Every signal ships entry, SL, TP1, TP2, confluence %, and 'don't chase' validity gate." },
            { icon: Radio, title: "MACRO SYNC", body: "Live news + geopolitical feed impacts signal validity in real time." },
            { icon: Bot, title: "AI CONSULT", body: "Ask Gemini or GPT for a take/skip verdict on any signal before you execute." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-lg border border-cyber-border bg-cyber-surface p-6 hover:border-neon-accent/40 transition group">
              <Icon className="size-6 text-neon-accent" />
              <h3 className="mt-4 font-mono text-sm font-bold tracking-widest text-white">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>

        <section className="mt-24 rounded-lg border border-cyber-border bg-cyber-surface p-8">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">// SUBSCRIPTION_KEYS</h2>
          <p className="mt-2 text-lg text-white">
            Access is gated by subscription key. Sign up, then redeem the key issued to
            your email to unlock the full 28-strategy engine and MT5 automation.
          </p>
        </section>
      </main>

      <footer className="relative z-10 border-t border-cyber-border px-6 py-6 text-center text-[10px] font-mono text-muted-foreground uppercase tracking-widest">
        © MDTALPHA DYNAMICS // TRADING SIGNALS ARE NOT FINANCIAL ADVICE.
      </footer>
    </div>
  );
}
