import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const PAIRS = [
  "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "NZDUSD",
  "USDCHF", "EURGBP", "EURJPY", "GBPJPY", "AUDJPY", "XAUUSD",
];

const GenerateInput = z.object({
  mode: z.enum(["intraday", "scalper"]).default("intraday"),
  pairs: z.array(z.string()).optional(),
});

// Deterministic-ish pseudo-random for demo signals until a market data provider is wired.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function synthesize(pair: string, mode: "intraday" | "scalper", enabled: string[]) {
  const seed = Math.floor(Date.now() / 60000) + pair.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rand = rng(seed);
  const isJPY = pair.endsWith("JPY");
  const isGold = pair === "XAUUSD";
  const base = isGold ? 2634 + rand() * 20 : isJPY ? 145 + rand() * 15 : 1.05 + rand() * 0.3;
  const atrPct = mode === "scalper" ? 0.0006 : 0.0015;
  const atr = base * atrPct * (isGold ? 2 : 1);
  const direction = rand() > 0.5 ? "long" : "short";
  const dir = direction === "long" ? 1 : -1;
  const entry = +base.toFixed(isJPY || isGold ? 2 : 5);
  const sl = +(entry - dir * atr * 1.2).toFixed(isJPY || isGold ? 2 : 5);
  const tp1 = +(entry + dir * atr * 1.5).toFixed(isJPY || isGold ? 2 : 5);
  const tp2 = +(entry + dir * atr * 3.0).toFixed(isJPY || isGold ? 2 : 5);

  // Pick 3-6 contributing strategies from enabled set.
  const shuffled = [...enabled].sort(() => rand() - 0.5);
  const contributing = shuffled.slice(0, 3 + Math.floor(rand() * 4));
  const confluence = Math.min(98, 55 + contributing.length * 6 + Math.floor(rand() * 10));

  const timeframe = mode === "scalper" ? "M5" : "H1";
  const validityMinutes = mode === "scalper" ? 15 : 90;

  return {
    pair,
    direction: direction as "long" | "short",
    mode,
    timeframe,
    entry,
    stop_loss: sl,
    take_profit_1: tp1,
    take_profit_2: tp2,
    atr: +atr.toFixed(6),
    confluence,
    contributing_strategies: contributing,
    rationale: `${contributing.length} strategy confluence on ${timeframe}. ATR-anchored SL 1.2×, TP1 1.5×, TP2 3×.`,
    news_context: [],
    expires_at: new Date(Date.now() + validityMinutes * 60_000).toISOString(),
    status: "fresh" as const,
  };
}

export const generateSignals = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => GenerateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: settings } = await supabase
      .from("strategy_settings")
      .select("strategy_id, enabled")
      .eq("user_id", userId);

    let enabled = (settings ?? []).filter((s) => s.enabled).map((s) => s.strategy_id);
    if (enabled.length === 0) {
      // No settings row yet -> assume all strategies enabled by default.
      const { data: allStrategies } = await supabase.from("strategies").select("id");
      enabled = (allStrategies ?? []).map((s) => s.id);
    }

    const pairs = data.pairs && data.pairs.length > 0 ? data.pairs : PAIRS;
    const rows = pairs.map((p) => ({ ...synthesize(p, data.mode, enabled), user_id: userId }));

    const { data: inserted, error } = await supabase.from("signals").insert(rows).select();
    if (error) throw new Error(error.message);
    return { signals: inserted ?? [] };
  });

export const listSignals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("signals")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    // Compute validity in real-time
    const now = Date.now();
    const signals = (data ?? []).map((s) => {
      const expires = new Date(s.expires_at as string).getTime();
      const created = new Date(s.created_at as string).getTime();
      const age = now - created;
      const lateThreshold = (expires - created) * 0.6;
      let liveStatus = s.status as string;
      if (liveStatus === "fresh" || liveStatus === "valid") {
        if (now > expires) liveStatus = "invalidated";
        else if (age > lateThreshold) liveStatus = "late";
        else liveStatus = "valid";
      }
      return { ...s, live_status: liveStatus };
    });
    return { signals };
  });

export const invalidateSignal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("signals")
      .update({ status: "invalidated" })
      .eq("id", data.id)
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    await supabase.from("signal_events").insert({
      signal_id: data.id,
      user_id: userId,
      event: "invalidated_by_user",
    });
    return { ok: true };
  });
