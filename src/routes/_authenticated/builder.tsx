import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Sparkles, Send } from "lucide-react";

export const Route = createFileRoute("/_authenticated/builder")({
  head: () => ({
    meta: [
      { title: "Vibe Builder — MDTAlphaFX" },
      {
        name: "description",
        content: "Non-technical AI project builder — describe an app, get a spec and prompt kit.",
      },
      { property: "og:title", content: "Vibe Builder — MDTAlphaFX" },
      {
        property: "og:description",
        content: "Describe an app, get a spec and prompt kit for vibe-coding.",
      },
    ],
  }),
  component: Builder,
});

function Builder() {
  const [idea, setIdea] = useState("");
  const [output, setOutput] = useState("");

  function generate() {
    if (!idea.trim()) return;
    setOutput(
      `## Project Spec\n**Idea:** ${idea}\n\n**Recommended stack:** TanStack Start · Lovable Cloud · Tailwind v4\n\n**Screens:**\n- Landing\n- Auth (Google + Email)\n- Main dashboard\n- Settings\n\n**Backend tables:**\n- profiles\n- items\n- events\n\n**MVP milestones:**\n1. Auth + shell\n2. Core CRUD\n3. Realtime updates\n4. Polish + publish\n\n_This is a scaffold. Wire the Lovable AI Gateway (Gemini 3.6 Flash) into this page to have it generated dynamically per idea._`,
    );
  }

  return (
    <div className="p-6 space-y-4 animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // VIBE_BUILDER
        </div>
        <h1 className="text-2xl font-bold text-white">Unified Vibe Builder</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Describe what you want to build. Get a spec, screens, and backend plan.
        </p>
      </header>

      <div className="rounded-lg border border-cyber-border bg-cyber-surface p-4 space-y-3">
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="I want to build a delivery tracking app for a bakery…"
          rows={4}
          className="w-full rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2 text-sm text-white focus:outline-none focus:border-neon-accent"
        />
        <button
          onClick={generate}
          className="inline-flex items-center gap-2 rounded-sm bg-neon-accent px-4 py-2 font-mono text-xs font-bold text-cyber-bg hover:brightness-110"
        >
          <Sparkles className="size-3" /> GENERATE_SPEC
        </button>
      </div>

      {output && (
        <div className="rounded-lg border border-cyber-border bg-cyber-surface p-6">
          <pre className="text-sm text-white font-mono whitespace-pre-wrap">{output}</pre>
        </div>
      )}
    </div>
  );
}
