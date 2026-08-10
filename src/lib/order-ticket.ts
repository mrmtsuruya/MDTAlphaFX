// Order-ticket layer.
//
// A signal is a direction + four price levels. What a trader actually needs is
// the ORDER: given where price is trading right now, is this a market fill, a
// breakout stop order, a pullback limit order — or is it already dead? The
// classification is purely a function of (direction, entry, sl, tp1, live mid)
// so it re-evaluates on every tick without touching the server.
//
// Client-safe: no server imports, no side effects.

export type OrderKind =
  | "buy_now"
  | "sell_now"
  | "buy_stop"
  | "buy_limit"
  | "sell_stop"
  | "sell_limit"
  | "missed"
  | "invalidated";

export type OrderTicket = {
  kind: OrderKind;
  /** Ticket text, e.g. "BUY LIMIT" — what you'd actually place in MT5. */
  label: string;
  /** One line on how to act on it. */
  note: string;
  tone: "long" | "short" | "warn" | "dead";
  /** Distance from live price to entry, in units of the trade's own risk (R). */
  distanceR: number;
  /** True once the order is no longer placeable. */
  closed: boolean;
};

export type TicketInput = {
  direction: "long" | "short";
  entry: number;
  stop_loss: number;
  take_profit_1: number;
};

/**
 * A signal is finished — no order can be placed against it any more.
 *
 * This list is load-bearing in two different places and they MUST agree:
 * `listSignals` uses it to decide which pairs are worth a live-quote fetch (so
 * a finished signal gets `live_mid: null`), and the client uses it to decide
 * whether to render a live order ticket at all. When the client's copy omitted
 * `"invalidated"`, an invalidated signal took the ticket path with a null mid —
 * and the null-mid branch of `classifyOrder` reports BUY NOW / SELL NOW. A dead
 * setup rendered as an actionable market order. Keep this the single source.
 */
export const RESOLVED_STATUSES = ["hit_tp1", "hit_tp2", "hit_sl", "invalidated"] as const;

export function isResolvedStatus(status: string): boolean {
  return (RESOLVED_STATUSES as readonly string[]).includes(status);
}

/**
 * R booked per outcome, as the learning loop scores it.
 *
 * TP1 is 1.25R rather than 1R because the engine's TP1 sits beyond one unit of
 * risk; TP2 is the 2R target. An invalidated signal books nothing — it was
 * never entered, so it is neither a win nor a loss.
 *
 * Lives here, not in signal-learning.ts, because the UI has to show the same
 * numbers the trust multipliers are computed from. Two copies would drift and
 * the panel would quietly disagree with the strategy league table.
 */
export const R_OF_STATUS: Record<string, number> = {
  hit_tp2: 2,
  // UNDER B-SINGLE, `hit_tp1` IS THE BREAKEVEN EXIT — NOT A BANKED PARTIAL WIN.
  // A 0.01 lot cannot be halved, so there is no "take 50% off at TP1". TP1
  // instead arms a breakeven stop; this status means price came back and took
  // that stop out. The trader walked away flat, so the R is 0. It is a scratch,
  // not a win: anything counting wins must exclude it from BOTH tallies.
  hit_tp1: 0,
  hit_sl: -1,
  invalidated: 0,
};

/** Booked R for a resolved status, or null while the signal is still open. */
export function rForStatus(status: string): number | null {
  return isResolvedStatus(status) ? (R_OF_STATUS[status] ?? 0) : null;
}

/**
 * Anything inside this fraction of the trade's risk counts as "at market" —
 * chasing a fill 3% of the way to the stop is not worth a pending order, and
 * the spread alone can cover it.
 */
const AT_MARKET_R = 0.08;

/**
 * Classify a signal into a placeable order given the live mid.
 *
 * The stop/limit split is the standard one: a pending order that fills as
 * price moves TOWARD the trade's direction is a STOP (breakout); one that
 * fills as price moves AGAINST it first is a LIMIT (pullback).
 */
export function classifyOrder(signal: TicketInput, mid: number | null | undefined): OrderTicket {
  const risk = Math.abs(signal.entry - signal.stop_loss);
  const long = signal.direction === "long";

  if (mid == null || !Number.isFinite(mid) || risk <= 0) {
    return {
      kind: long ? "buy_now" : "sell_now",
      label: long ? "BUY NOW" : "SELL NOW",
      note: "No live price — treat entry as a market reference.",
      tone: long ? "long" : "short",
      distanceR: 0,
      closed: false,
    };
  }

  const distanceR = +Math.abs((mid - signal.entry) / risk).toFixed(2);

  // Dead first: the stop is gone, so there is no order left to place.
  const stopBreached = long ? mid <= signal.stop_loss : mid >= signal.stop_loss;
  if (stopBreached) {
    return {
      kind: "invalidated",
      label: "INVALIDATED",
      note: `Price traded through the ${signal.stop_loss} stop. Do not enter — wait for the next scan.`,
      tone: "dead",
      distanceR,
      closed: true,
    };
  }

  // Target already taken: entering now buys the leftovers at a broken R:R.
  const tp1Taken = long ? mid >= signal.take_profit_1 : mid <= signal.take_profit_1;
  if (tp1Taken) {
    return {
      kind: "missed",
      label: "TOO LATE",
      note: `TP1 (${signal.take_profit_1}) already printed. The reward left doesn't justify the same stop.`,
      tone: "warn",
      distanceR,
      closed: true,
    };
  }

  if (distanceR <= AT_MARKET_R) {
    return {
      kind: long ? "buy_now" : "sell_now",
      label: long ? "BUY NOW" : "SELL NOW",
      note: `Trading at entry (${distanceR}R away). Market order, stop at ${signal.stop_loss}.`,
      tone: long ? "long" : "short",
      distanceR,
      closed: false,
    };
  }

  const entryAbove = signal.entry > mid;
  if (long) {
    return entryAbove
      ? {
          kind: "buy_stop",
          label: "BUY STOP",
          note: `Place at ${signal.entry}, ${distanceR}R above price — fills on the break up.`,
          tone: "long",
          distanceR,
          closed: false,
        }
      : {
          kind: "buy_limit",
          label: "BUY LIMIT",
          note: `Place at ${signal.entry}, ${distanceR}R below price — fills on the pullback.`,
          tone: "long",
          distanceR,
          closed: false,
        };
  }
  return entryAbove
    ? {
        kind: "sell_limit",
        label: "SELL LIMIT",
        note: `Place at ${signal.entry}, ${distanceR}R above price — fills on the pullback.`,
        tone: "short",
        distanceR,
        closed: false,
      }
    : {
        kind: "sell_stop",
        label: "SELL STOP",
        note: `Place at ${signal.entry}, ${distanceR}R below price — fills on the break down.`,
        tone: "short",
        distanceR,
        closed: false,
      };
}

// ---------------------------------------------------------------------------
// Technical summary — three sentences, built from what the engine actually
// recorded rather than restating the raw rationale string.
// ---------------------------------------------------------------------------

type EngineVote = { strategyId: string; direction: string; reason?: string };

export type SummarySource = {
  direction: "long" | "short";
  timeframe: string;
  confluence: number;
  contributing_strategies: string[];
  atr: number;
  entry: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  news_context: unknown;
};

function readEngine(context: unknown) {
  if (!context || Array.isArray(context) || typeof context !== "object") return null;
  const engine = (context as Record<string, unknown>).strategy_engine;
  if (!engine || Array.isArray(engine) || typeof engine !== "object") return null;
  return engine as {
    votes?: EngineVote[];
    mtf?: { confirmed?: string | null; agreementScore?: number };
    sweep?: { requested?: string[]; evaluated?: { timeframe: string; direction: string | null }[] };
    learning?: { multipliers?: { strategyId: string }[] };
  };
}

function humanise(strategyId: string) {
  return strategyId.replace(/[_-]+/g, " ").trim();
}

/**
 * Exactly three sentences: what fired, what the wider context says, and what
 * the trade risks. Returns plain strings so the caller controls layout.
 */
export function summarizeSignal(signal: SummarySource): string[] {
  const engine = readEngine(signal.news_context);
  const side = signal.direction === "long" ? "bullish" : "bearish";
  const agreeing = (engine?.votes ?? []).filter((v) => v.direction === signal.direction);
  const named = (
    agreeing.length > 0 ? agreeing.map((v) => v.strategyId) : signal.contributing_strategies
  )
    .slice(0, 3)
    .map(humanise);
  const total = signal.contributing_strategies.length;

  const first =
    named.length > 0
      ? `${named.join(", ")} agree on a ${side} setup on ${signal.timeframe}, ${total} strategies voting for ${signal.confluence}% confluence.`
      : `The engine reads a ${side} setup on ${signal.timeframe} at ${signal.confluence}% confluence.`;

  const mtf = engine?.mtf;
  const sweep = engine?.sweep;
  let second: string;
  if (mtf?.confirmed) {
    second = `Higher timeframes back it — the ${String(mtf.confirmed).toUpperCase()} tide is confirmed at ${mtf.agreementScore ?? 0}% alignment.`;
  } else if (mtf) {
    second = `Higher timeframes are split, so this rests on the ${signal.timeframe} read alone.`;
  } else if (sweep?.evaluated?.length) {
    const withSetup = sweep.evaluated.filter((a) => a.direction);
    const agreeingTfs = withSetup.filter((a) => a.direction === signal.direction).length;
    second = `Swept ${sweep.evaluated.length} timeframes; ${withSetup.length} produced a setup and ${agreeingTfs} pointed ${signal.direction}, with ${signal.timeframe} the strongest.`;
  } else {
    second = `Judged on ${signal.timeframe} alone — no higher-timeframe confirmation was run.`;
  }

  const risk = Math.abs(signal.entry - signal.stop_loss);
  const reward = Math.abs(signal.take_profit_2 - signal.entry);
  const rr = risk > 0 ? (reward / risk).toFixed(1) : "—";
  const atrPct = risk > 0 && signal.atr > 0 ? (risk / signal.atr).toFixed(1) : "—";
  const third = `Stop sits ${atrPct} ATR from entry for ${rr}R to TP2 — invalidated the moment price trades through ${signal.stop_loss}.`;

  return [first, second, third];
}
