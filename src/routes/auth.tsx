import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/auth")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) throw redirect({ to: "/dashboard" });
  },
  head: () => ({
    meta: [
      { title: "Access Terminal — MDTAlphaFX" },
      { name: "description", content: "Sign in to your MDTAlphaFX trading terminal." },
      { property: "og:title", content: "Access Terminal — MDTAlphaFX" },
      { property: "og:description", content: "Sign in to your MDTAlphaFX trading terminal." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    async function completeOAuthCallback() {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");

      if (!accessToken || !refreshToken) return;

      window.history.replaceState(null, "", window.location.pathname);
      setBusy(true);
      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (error) {
        toast.error(error.message);
        setBusy(false);
        return;
      }

      window.location.replace(`${window.location.origin}/dashboard`);
    }

    void completeOAuthCallback();
  }, [navigate]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        toast.success("Check your email to confirm your account, then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate({ to: "/dashboard" });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  function google() {
    setBusy(true);
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      if (!supabaseUrl) throw new Error("Supabase URL is not configured");

      const authorizeUrl = new URL("/auth/v1/authorize", supabaseUrl);
      authorizeUrl.searchParams.set("provider", "google");
      authorizeUrl.searchParams.set("redirect_to", `${window.location.origin}/auth`);
      window.location.assign(authorizeUrl.toString());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Google sign-in failed");
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-cyber-bg text-foreground flex items-center justify-center px-4 relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 scanline opacity-40" />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/4 left-1/2 -translate-x-1/2 h-[400px] w-[600px] rounded-full blur-3xl opacity-30"
        style={{ background: "radial-gradient(closest-side, #00d1ff, transparent)" }}
      />

      <div className="relative z-10 w-full max-w-md rounded-lg border border-cyber-border bg-cyber-surface p-8 animate-fade-up">
        <div className="mb-6 flex items-center gap-2">
          <div className="size-8 rounded bg-neon-accent flex items-center justify-center font-black text-cyber-bg">
            FX
          </div>
          <span className="font-mono-strong font-bold tracking-tighter text-white text-xl">
            MDT<span className="text-neon-accent">ALPHA</span>
          </span>
        </div>

        <h1 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          // {mode === "signin" ? "ACCESS_TERMINAL" : "REGISTER_OPERATOR"}
        </h1>
        <p className="mt-1 text-2xl font-bold text-white">
          {mode === "signin" ? "Sign in" : "Create account"}
        </p>

        <button
          onClick={google}
          disabled={busy}
          className="mt-6 w-full inline-flex items-center justify-center gap-2 rounded-sm border border-cyber-border bg-cyber-bg px-4 py-2.5 text-sm font-medium text-white hover:bg-cyber-surface-2 transition disabled:opacity-50"
        >
          <svg className="size-4" viewBox="0 0 24 24">
            <path
              fill="#EA4335"
              d="M12 10.2v3.9h5.5c-.2 1.5-1.7 4.3-5.5 4.3-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.9 1.5l2.6-2.5C16.9 3.7 14.7 2.8 12 2.8 6.9 2.8 2.8 6.9 2.8 12s4.1 9.2 9.2 9.2c5.3 0 8.9-3.7 8.9-9 0-.6-.1-1.1-.2-1.6H12Z"
            />
          </svg>
          Continue with Google
        </button>

        <div className="my-6 flex items-center gap-3 text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
          <div className="h-px flex-1 bg-cyber-border" /> OR{" "}
          <div className="h-px flex-1 bg-cyber-border" />
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              EMAIL
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2 text-sm text-white focus:outline-none focus:border-neon-accent"
            />
          </div>
          <div>
            <label className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
              PASSWORD
            </label>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2 text-sm text-white focus:outline-none focus:border-neon-accent"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-sm bg-neon-accent px-4 py-2.5 text-sm font-mono font-bold text-cyber-bg hover:brightness-110 transition disabled:opacity-50"
          >
            {busy ? "…" : mode === "signin" ? "SIGN_IN" : "REGISTER"}
          </button>
        </form>

        <button
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className="mt-4 w-full text-xs text-muted-foreground hover:text-neon-accent font-mono"
        >
          {mode === "signin" ? "No account? Register →" : "Already have an account? Sign in →"}
        </button>
      </div>
    </div>
  );
}
