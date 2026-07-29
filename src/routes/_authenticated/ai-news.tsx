import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/ai-news")({
  head: () => ({
    meta: [
      { title: "AI News — MDTAlphaFX" },
      { name: "description", content: "New AI models, benchmarks, and vibe-coding project ideas." },
      { property: "og:title", content: "AI News — MDTAlphaFX" },
      { property: "og:description", content: "New AI models, benchmarks, and vibe-coding project ideas." },
    ],
  }),
  component: AINews,
});

const RANKINGS = [
  { r: 1, model: "GPT-5.6 Sol", score: 94.2, provider: "OpenAI" },
  { r: 2, model: "Claude Opus 4.5", score: 93.8, provider: "Anthropic" },
  { r: 3, model: "Gemini 3.1 Pro", score: 92.9, provider: "Google" },
  { r: 4, model: "GPT-5.5", score: 92.1, provider: "OpenAI" },
  { r: 5, model: "Gemini 3.6 Flash", score: 88.4, provider: "Google" },
  { r: 6, model: "Claude Sonnet 4.5", score: 87.9, provider: "Anthropic" },
  { r: 7, model: "GPT-5.4", score: 87.2, provider: "OpenAI" },
  { r: 8, model: "Grok 4", score: 85.6, provider: "xAI" },
  { r: 9, model: "DeepSeek R2", score: 84.8, provider: "DeepSeek" },
  { r: 10, model: "Llama 4 405B", score: 83.9, provider: "Meta" },
];

const NEWS = [
  { title: "Anthropic ships Claude 4.5 with 2M-token context", tag: "MODEL" },
  { title: "OpenAI releases GPT-5.6 with 'sol/terra/luna' variants", tag: "MODEL" },
  { title: "Vibe-coding project idea: real-time meeting summarizer", tag: "PROJECT" },
  { title: "Google Gemini 3.1 Pro tops MMLU-Pro leaderboard", tag: "BENCHMARK" },
  { title: "Vibe-coding project idea: personal RSS AI curator", tag: "PROJECT" },
];

function AINews() {
  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">// AI_INTEL</div>
        <h1 className="text-2xl font-bold text-white">AI News & Model Rankings</h1>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-lg border border-cyber-border bg-cyber-surface">
          <div className="px-4 py-3 border-b border-cyber-border">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-neon-accent">// TOP_10_MODELS</h2>
          </div>
          <div className="divide-y divide-cyber-border">
            {RANKINGS.map((m) => (
              <div key={m.r} className="px-4 py-2.5 flex items-center gap-3 font-mono text-xs hover:bg-cyber-surface-2">
                <span className="w-6 text-neon-accent font-bold">#{m.r}</span>
                <span className="flex-1 text-white">{m.model}</span>
                <span className="text-muted-foreground">{m.provider}</span>
                <span className="text-neon-long w-16 text-right">{m.score}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-cyber-border bg-cyber-surface">
          <div className="px-4 py-3 border-b border-cyber-border">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-neon-accent">// NEWS_WIRE</h2>
          </div>
          <div className="divide-y divide-cyber-border">
            {NEWS.map((n, i) => (
              <div key={i} className="p-4 hover:bg-cyber-surface-2">
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
                  n.tag === "MODEL" ? "bg-neon-accent/20 text-neon-accent" :
                  n.tag === "BENCHMARK" ? "bg-neon-long/20 text-neon-long" :
                  "bg-neon-warn/20 text-neon-warn"
                }`}>{n.tag}</span>
                <div className="text-sm text-white mt-1.5">{n.title}</div>
              </div>
            ))}
          </div>
        </section>
      </div>
      <p className="text-[10px] font-mono text-muted-foreground">// Live leaderboard integration is stubbed — wire lmsys/livebench feeds via a scheduled server route.</p>
    </div>
  );
}
