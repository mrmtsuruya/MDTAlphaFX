import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const redeemSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ key: z.string().trim().min(6).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId, claims } = context;
    const email = (claims?.email as string | undefined)?.toLowerCase();

    const { data: sub, error: findError } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("subscription_key", data.key)
      .maybeSingle();

    if (findError) throw new Error(findError.message);
    if (!sub) throw new Error("Invalid subscription key.");
    if (sub.user_id && sub.user_id !== userId)
      throw new Error("Key already redeemed by another account.");
    if (sub.status !== "active") throw new Error(`Key is ${sub.status}.`);
    if (email && sub.email.toLowerCase() !== email)
      throw new Error("Key was issued to a different email.");

    const { error: updErr } = await supabase
      .from("subscriptions")
      .update({ user_id: userId, redeemed_at: new Date().toISOString() })
      .eq("id", sub.id);
    if (updErr) throw new Error(updErr.message);

    return { ok: true, tier: sub.tier };
  });

export const mySubscription = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { subscription: data };
  });
