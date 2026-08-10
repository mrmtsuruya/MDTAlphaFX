import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { mySubscription, redeemSubscription } from "@/lib/subscriptions.functions";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/redeem")({
  head: () => ({
    meta: [
      { title: "Subscription — MDTAlphaFX" },
      { name: "description", content: "Redeem your MDTAlphaFX subscription key." },
      { property: "og:title", content: "Subscription — MDTAlphaFX" },
      { property: "og:description", content: "Redeem your MDTAlphaFX subscription key." },
    ],
  }),
  component: Redeem,
});

function Redeem() {
  const subFn = useServerFn(mySubscription);
  const redeemFn = useServerFn(redeemSubscription);
  const qc = useQueryClient();
  const [key, setKey] = useState("");

  const q = useQuery({ queryKey: ["subscription"], queryFn: () => subFn() });
  const m = useMutation({
    mutationFn: (k: string) => redeemFn({ data: { key: k } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["subscription"] });
      toast.success("Subscription activated");
      setKey("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sub = q.data?.subscription;

  return (
    <div className="p-6 max-w-2xl animate-fade-up">
      <header>
        <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          // SUBSCRIPTION
        </div>
        <h1 className="text-2xl font-bold text-white">Subscription</h1>
      </header>

      {sub ? (
        <div className="mt-4 rounded-lg border border-neon-long/40 bg-neon-long/5 p-5">
          <div className="flex items-center gap-2 text-neon-long">
            <KeyRound className="size-4" />
            <span className="font-mono text-xs uppercase tracking-widest">ACTIVE · {sub.tier}</span>
          </div>
          <div className="mt-2 text-sm text-white">
            Full 28-strategy engine, MT5 automation, and AI consult unlocked.
          </div>
          <div className="mt-3 font-mono text-[10px] text-muted-foreground">
            REDEEMED · {sub.redeemed_at ? new Date(sub.redeemed_at).toLocaleString() : "—"}
            {sub.expires_at && <> · EXPIRES {new Date(sub.expires_at).toLocaleDateString()}</>}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-cyber-border bg-cyber-surface p-5">
          <p className="text-sm text-muted-foreground">
            Enter the subscription key that was issued to your account email.
          </p>
          <div className="mt-4 flex gap-2">
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              className="flex-1 rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-neon-accent"
            />
            <button
              onClick={() => m.mutate(key)}
              disabled={m.isPending || !key.trim()}
              className="rounded-sm bg-neon-accent px-4 py-2 font-mono text-xs font-bold text-cyber-bg hover:brightness-110 disabled:opacity-50"
            >
              REDEEM
            </button>
          </div>
          <p className="mt-3 text-[10px] font-mono text-muted-foreground">
            Don't have a key? Contact your MDTAlphaFX admin.
          </p>
        </div>
      )}
    </div>
  );
}
