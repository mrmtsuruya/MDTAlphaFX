import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ConsultInput = z.object({
  signalId: z.string().uuid(),
  model: z
    .enum(["google/gemini-3.6-flash", "google/gemini-3.1-pro-preview", "openai/gpt-5.4-mini"])
    .default("google/gemini-3.6-flash"),
});

export const consultOnSignal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => ConsultInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY not configured");

    const { data: signal, error } = await supabase
      .from("signals")
      .select("*")
      .eq("id", data.signalId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !signal) throw new Error("Signal not found");

    const prompt = `You are a professional forex trading analyst. Evaluate this signal and give a TAKE / SKIP / WAIT verdict with a 1-sentence reason.

Signal:
- Pair: ${signal.pair}
- Direction: ${signal.direction}
- Mode: ${signal.mode} (${signal.timeframe})
- Entry: ${signal.entry}
- Stop Loss: ${signal.stop_loss}
- Take Profit 1: ${signal.take_profit_1}
- Take Profit 2: ${signal.take_profit_2}
- ATR: ${signal.atr}
- Confluence: ${signal.confluence}%
- Contributing strategies: ${(signal.contributing_strategies as string[]).join(", ")}
- Expires: ${signal.expires_at}

Respond in the format:
VERDICT: <TAKE|SKIP|WAIT>
REASON: <one sentence>
RISK: <one sentence on the main risk>`;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({
        model: data.model,
        messages: [
          { role: "system", content: "You are a disciplined risk-first forex analyst." },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) throw new Error("Rate limited — please wait and retry.");
      if (res.status === 402)
        throw new Error("AI credits exhausted. Add credits in workspace settings.");
      throw new Error(`AI consult failed [${res.status}]: ${body}`);
    }

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content ?? "No response.";
    const usage = json.usage ?? {};

    await supabase.from("ai_usage").insert({
      user_id: userId,
      model: data.model,
      purpose: "signal_consult",
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      signal_id: data.signalId,
    });

    return { text, model: data.model };
  });

export const listUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("ai_usage")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    return { usage: data ?? [] };
  });
