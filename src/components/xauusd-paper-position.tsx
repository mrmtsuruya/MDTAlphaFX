import type { PaperSignalListItem } from "@/lib/xauusd-paper.functions";
import type { MarketQuote } from "@/lib/market-data.server";
import { computePaperPosition } from "@/lib/xauusd-paper-pnl";
import { formatPhtTimestamp } from "@/lib/pht-time";

const OPEN_STATES = new Set(["waiting_entry", "open", "tp1_protected"]);

const STATE_META: Record<string, { label: string; cls: string }> = {
  waiting_entry: {
    label: "WAITING_ENTRY",
    cls: "border-neon-warn/40 bg-neon-warn/5 text-neon-warn",
  },
  open: { label: "OPEN", cls: "border-neon-accent/40 bg-neon-accent/5 text-neon-accent" },
  tp1_protected: {
    label: "TP1_PROTECTED",
    cls: "border-neon-long/40 bg-neon-long/5 text-neon-long",
  },
};

type LadderLevel = {
  label: string;
  price: number | null;
  tone: "long" | "short" | "muted" | "accent";
};

const LEVEL_TONE: Record<LadderLevel["tone"], string> = {
  long: "text-neon-long",
  short: "text-neon-short",
  muted: "text-muted-foreground",
  accent: "text-neon-accent",
};

/**
 * MT5-style open-position block for a canonical paper signal. Rendered only
 * while the trade is open: entry (or planned entry), live price, floating
 * P&L in $ and R, and a price ladder of TP2 / TP1 / CURRENT / ENTRY / SL.
 * Closed trades keep the existing R-result display in the inspector.
 */
export function XauusdPaperPosition({
  signal,
  quote,
}: {
  signal: PaperSignalListItem;
  quote?: MarketQuote;
}) {
  if (!OPEN_STATES.has(signal.trade.state)) return null;
  const meta = STATE_META[signal.trade.state] ?? STATE_META.open;

  const entry = signal.trade.entryPrice ?? signal.entry;
  const current = quote?.mid ?? null;
  const math =
    current != null
      ? computePaperPosition({
          direction: signal.direction,
          entry,
          stopLoss: signal.stopLoss,
          lotSize: signal.lotSize,
          current,
        })
      : null;

  const pnlTone =
    math == null
      ? "text-muted-foreground"
      : math.usd > 0
        ? "text-neon-long"
        : math.usd < 0
          ? "text-neon-short"
          : "text-muted-foreground";

  const ladder: (LadderLevel & { price: number })[] = [
    { label: "TP2", price: signal.takeProfit2, tone: "long" },
    { label: "TP1", price: signal.takeProfit1, tone: "long" },
    { label: "CURRENT", price: current, tone: "accent" },
    { label: "ENTRY", price: entry, tone: "muted" },
    { label: "SL", price: signal.stopLoss, tone: "short" },
  ]
    .filter(
      (level): level is LadderLevel & { price: number } =>
        level.price != null && Number.isFinite(level.price),
    )
    .sort((a, b) => b.price - a.price);

  return (
    <div className="rounded-sm border border-neon-accent/30 bg-cyber-bg px-3 py-2.5 font-mono">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] uppercase tracking-widest text-neon-accent">
          // POSITION · {signal.pair}
        </span>
        <span className={`rounded-sm border px-1.5 py-0.5 text-[8px] uppercase ${meta.cls}`}>
          {meta.label}
        </span>
      </div>

      <div className="mt-2 flex items-baseline justify-between">
        <div>
          <div className="text-[8px] uppercase text-muted-foreground">FLOATING P&L</div>
          <div className={`text-base font-bold ${pnlTone}`}>
            {math == null
              ? "—"
              : `${math.usd > 0 ? "+" : ""}$${math.usd.toFixed(2)} · ${math.r > 0 ? "+" : ""}${math.r.toFixed(2)}R`}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[8px] uppercase text-muted-foreground">
            {signal.direction.toUpperCase()} · {signal.lotSize} LOT
          </div>
          <div className="text-[11px] text-white">
            CURRENT{" "}
            <span className={current != null ? "text-neon-accent" : "text-muted-foreground"}>
              {current?.toFixed(2) ?? "—"}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
        <PositionRow label="ENTRY" value={entry.toFixed(2)} />
        <PositionRow
          label="OPENED"
          value={signal.trade.entryTime ? formatPhtTimestamp(signal.trade.entryTime) : "—"}
        />
        <PositionRow label="TP1" value={signal.takeProfit1.toFixed(2)} tone="long" />
        <PositionRow label="TP2" value={signal.takeProfit2.toFixed(2)} tone="long" />
        <PositionRow label="SL" value={signal.stopLoss.toFixed(2)} tone="short" />
        <PositionRow label="TF" value={signal.timeframe} />
      </div>

      <div className="mt-2 border-t border-cyber-border pt-2">
        <div className="text-[8px] uppercase tracking-widest text-muted-foreground">
          PRICE LADDER
        </div>
        <div className="mt-1 space-y-0.5">
          {ladder.map((level) => (
            <div key={level.label} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[8px] uppercase text-muted-foreground">
                {level.label}
              </span>
              <span
                className={`h-px flex-1 ${level.tone === "accent" ? "bg-neon-accent/70" : "bg-cyber-border"}`}
              />
              <span className={`text-[10px] font-bold ${LEVEL_TONE[level.tone]}`}>
                {level.tone === "accent" ? "▶ " : ""}
                {level.price.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PositionRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "long" | "short";
}) {
  const cls =
    tone === "long" ? "text-neon-long" : tone === "short" ? "text-neon-short" : "text-white";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[8px] uppercase text-muted-foreground">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}
