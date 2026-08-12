import { Switch } from "@/components/ui/switch";
import type { XauusdPaperHealth, XauusdPaperProfile } from "@/lib/xauusd-paper.functions";
import { Cpu } from "lucide-react";

export const PAPER_ONLY_COPY = "PAPER ONLY · 0.01 LOT · NO BROKER CONNECTION" as const;

/**
 * The single browser-facing control for the unattended worker. Enabling a
 * profile only ever passes `{ p_enabled: true }` to the authenticated RPC —
 * everything else (symbol, lot, timezone, strategy scope) is fixed server-side.
 * The toggle stays blocked until the worker's live provider health proves the
 * schema exists, the OANDA practice credentials are configured, the instrument
 * is supported, and the last check passed.
 */
export function XauusdAutoPaperPanel({
  profile,
  health,
  mutating,
  onEnabledChange,
}: {
  profile: XauusdPaperProfile | undefined;
  health: XauusdPaperHealth | undefined;
  mutating: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const enabled = profile?.enabled ?? false;
  const { blocked, reason } = toggleBlocked(health);

  const statusMeta: Record<XauusdPaperHealth["status"], { label: string; cls: string }> = {
    healthy: { label: "WORKER_HEALTHY", cls: "border-neon-long/40 bg-neon-long/5 text-neon-long" },
    degraded: {
      label: "WORKER_DEGRADED",
      cls: "border-neon-warn/40 bg-neon-warn/5 text-neon-warn",
    },
    disabled: { label: "WORKER_STANDBY", cls: "border-cyber-border text-muted-foreground" },
    // Display label deliberately not "MIGRATION_REQUIRED": at 9px mono that
    // reads as "migration expired" (same length, same -IRED ending). The state
    // is that migrations have NOT run yet — NOT_DEPLOYED matches the toggle
    // reason and cannot be misread as a past-tense failure.
    migration_required: {
      label: "NOT_DEPLOYED",
      cls: "border-neon-warn/40 bg-neon-warn/5 text-neon-warn",
    },
  };
  const meta = statusMeta[health?.status ?? "disabled"];

  return (
    <section className="rounded-lg border border-cyber-border bg-cyber-surface">
      <div className="px-4 py-3 border-b border-cyber-border flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Cpu className="size-4 text-neon-accent" />
          <div>
            <div className="font-mono text-[9px] uppercase tracking-widest text-neon-accent">
              // XAUUSD_AUTO_PAPER
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              Unattended worker scans once per minute and paper-trades every eligible signal at 0.01
              lot — no browser, no broker connection.
            </div>
          </div>
        </div>
        <span
          className={`shrink-0 rounded-sm border px-2 py-1 text-[9px] font-mono uppercase ${meta.cls}`}
        >
          {meta.label}
        </span>
      </div>

      <div className="p-4">
        <div className="rounded-sm border border-neon-accent/30 bg-neon-accent/5 px-3 py-2 font-mono text-[11px] font-bold text-neon-accent">
          {PAPER_ONLY_COPY}
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 font-mono text-[10px]">
          <PanelField label="ZONE" value="Asia/Manila (PHT)" />
          <PanelField
            label="PROVIDER · INSTRUMENT"
            value={
              health?.provider
                ? `${health.provider} · ${health.instrument}`
                : "TV_OANDA_FEED · XAU_USD"
            }
          />
          <PanelField
            label="LAST ATTEMPT"
            value={health?.lastAttemptPht ?? "—"}
            title={health?.checkedAtUtc ?? undefined}
          />
          <PanelField label="LAST SUCCESS" value={health?.lastSuccessPht ?? "—"} />
          <PanelField
            label="QUOTE AGE"
            value={health?.quoteAgeMs != null ? formatAge(health.quoteAgeMs) : "—"}
          />
          <PanelField
            label="SPREAD"
            value={health?.spread != null ? `$${health.spread.toFixed(3)}` : "—"}
          />
          <PanelField
            label="CHECKED"
            value={health?.checkedAtPht ?? "—"}
            title={health?.checkedAtUtc ?? undefined}
          />
          <PanelField
            label="DEGRADATION"
            // Degradation is a runtime concept: only an ENABLED worker whose last
            // health check failed is degraded. "migration_required" (schema not
            // deployed) and "no_health_reported" (standby) are not degradation —
            // showing them here in red read like a live provider failure.
            value={health?.status === "degraded" ? (health.code ?? "unknown") : "NONE"}
            tone={health?.status === "degraded" ? "short" : "muted"}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-sm border border-cyber-border bg-cyber-bg px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[11px] font-bold text-white">Unattended XAUUSD paper trading</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {blocked
                ? (reason ?? "Toggle blocked.")
                : enabled
                  ? "Worker is live — every eligible signal opens a 0.01-lot paper trade."
                  : "Turn on to let the worker generate and paper-trade XAUUSD signals."}
            </div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={onEnabledChange}
            disabled={blocked || mutating}
            aria-label="Enable unattended XAUUSD paper trading"
            className="shrink-0"
          />
        </div>
      </div>
    </section>
  );
}

function toggleBlocked(health: XauusdPaperHealth | undefined): {
  blocked: boolean;
  reason: string | null;
} {
  if (!health) {
    return { blocked: true, reason: "Worker health has not been reported yet." };
  }
  if (health.status === "migration_required") {
    return {
      blocked: true,
      // Canonical not-deployed copy — kept identical to the dashboard and Signal
      // Center empty states (see xauusd-auto-paper-copy-contract.test.ts).
      // Deliberately free of "schema"/"migrations" jargon: that phrasing read
      // like an expired state instead of "not set up yet".
      reason: "Auto-Paper is not deployed yet — paper signals appear once the worker is running.",
    };
  }
  if (health.code === "credentials_missing") {
    return {
      blocked: true,
      reason: "OANDA practice credentials are missing — the provider cannot check the live feed.",
    };
  }
  if (health.code === "instrument_mismatch" || health.code === "not_tradeable") {
    return {
      blocked: true,
      reason: "Unsupported instrument — the worker only trades OANDA practice XAU_USD.",
    };
  }
  if (health.code === "no_health_reported") {
    // Schema exists but the worker has never posted a health row: not deployed
    // yet, or the minute cron has not fired. This is standby, not a feed
    // failure — the toggle unlocks on the first healthy report.
    return {
      blocked: true,
      reason:
        "The worker has not reported health yet — it posts once per minute once deployed and the minute cron is running; activation unlocks on the first healthy report.",
    };
  }
  if (!health.ok) {
    return {
      blocked: true,
      reason: `Live provider health failed (${health.code}) — activation refused until the feed is healthy.`,
    };
  }
  return { blocked: false, reason: null };
}

function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function PanelField({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: "muted" | "short";
  title?: string;
}) {
  const color =
    tone === "short"
      ? "text-neon-short"
      : tone === "muted"
        ? "text-muted-foreground"
        : "text-white";
  return (
    <div title={title}>
      <div className="text-[8px] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className={`mt-0.5 truncate ${color}`}>{value}</div>
    </div>
  );
}
