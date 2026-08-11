// Deterministic B-single paper state machine for the 0.01-lot XAUUSD worker.
//
// A 0.01 lot cannot be halved, so "take 50% at TP1" is unexecutable. TP1
// instead ARMS a breakeven stop at entry and the whole position runs to TP2:
//   - waiting_entry -> open (side-aware fill: long at ask, short at bid)
//   - open -> tp1_protected (TP1 reached; breakeven armed)
//   - tp1_protected -> closed_tp2 (+2R) | closed_breakeven (0R)
//   - open -> closed_tp2 (+2R) | closed_stop (-1R)
//   - waiting_entry -> expired
//
// Longs enter on the ask and exit on the bid; shorts mirror on the bid/ask.
// Intrabar order is unknowable, so a candle that touches both the initial
// stop and a target resolves adversarially (stop) with `ambiguousIntrabar`,
// and the candle that arms the breakeven stop can never also trigger it.
//
// The module is pure: no I/O, no wall-clock reads (the caller passes `now`),
// so replays of historical bars are deterministic.

import type { NativeXauusdQuote, PaperTimeframe, TwoSidedCandle } from "./xauusd-market-data.ts";

export const PAPER_LOT_SIZE = 0.01 as const;
export const PAPER_POLICY_VERSION = "b_single_v1" as const;
export const PAPER_INSTRUMENT_SPEC_VERSION = "xauusd_0_01_lot_v1" as const;

export type PaperTradeState =
  | "waiting_entry"
  | "open"
  | "tp1_protected"
  | "closed_tp2"
  | "closed_breakeven"
  | "closed_stop"
  | "expired";

export type PaperTrade = {
  id: string;
  signalId: string;
  userId: string;
  symbol: "XAUUSD";
  lotSize: 0.01;
  executionPolicyVersion: "b_single_v1";
  instrumentSpecVersion: "xauusd_0_01_lot_v1";
  direction: "long" | "short";
  timeframe: PaperTimeframe;
  state: PaperTradeState;
  stateVersion: number;
  plannedEntry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  expiresAt: string;
  entryPrice: number | null;
  entryTime: string | null;
  exitPrice: number | null;
  exitTime: string | null;
  tp1ArmedAt: string | null;
  lastObservedAt: string | null;
  resultR: number | null;
  maeR: number;
  mfeR: number;
  barsHeld: number;
  ambiguousIntrabar: boolean;
  createdAt: string;
};

export type PaperObservation =
  | { kind: "quote"; value: NativeXauusdQuote }
  | { kind: "candle"; value: TwoSidedCandle };

export type PaperTransitionEventType =
  | "market_observed"
  | "entry_filled"
  | "tp1_protected"
  | "closed_tp2"
  | "closed_breakeven"
  | "closed_stop"
  | "expired";

export type PaperTransition = {
  expectedVersion: number;
  next: PaperTrade;
  event: {
    eventKey: string;
    type: PaperTransitionEventType;
    providerTimestamp: string | null;
    evidence: Record<string, number | string | boolean | null>;
  };
};

const TERMINAL_STATES: ReadonlySet<PaperTradeState> = new Set([
  "closed_tp2",
  "closed_breakeven",
  "closed_stop",
  "expired",
]);

type Evidence = Record<string, number | string | boolean | null>;

function baseEvidence(trade: PaperTrade): Evidence {
  return {
    symbol: trade.symbol,
    direction: trade.direction,
    timeframe: trade.timeframe,
    lotSize: trade.lotSize,
  };
}

function transition(
  trade: PaperTrade,
  next: PaperTrade,
  event: PaperTransition["event"],
): PaperTransition {
  return { expectedVersion: trade.stateVersion, next, event };
}

function observationOnly(
  trade: PaperTrade,
  providerTimestamp: string,
  evidence: Evidence,
): PaperTransition {
  return transition(
    trade,
    { ...trade, stateVersion: trade.stateVersion + 1 },
    {
      eventKey: `observation:${providerTimestamp}`,
      type: "market_observed",
      providerTimestamp,
      evidence: { ...baseEvidence(trade), ...evidence },
    },
  );
}

function entryFill(
  trade: PaperTrade,
  entryPrice: number,
  providerTimestamp: string,
  evidence: Evidence,
): PaperTransition {
  const filled: PaperTrade = {
    ...trade,
    state: "open",
    stateVersion: trade.stateVersion + 1,
    entryPrice,
    entryTime: providerTimestamp,
  };
  return transition(trade, filled, {
    eventKey: `entry_filled:${providerTimestamp}`,
    type: "entry_filled",
    providerTimestamp,
    evidence: { ...baseEvidence(trade), entryPrice, ...evidence },
  });
}

function armTp1(trade: PaperTrade, providerTimestamp: string, evidence: Evidence): PaperTransition {
  const armed: PaperTrade = {
    ...trade,
    state: "tp1_protected",
    stateVersion: trade.stateVersion + 1,
    tp1ArmedAt: providerTimestamp,
  };
  return transition(trade, armed, {
    eventKey: `tp1_protected:${providerTimestamp}`,
    type: "tp1_protected",
    providerTimestamp,
    evidence: { ...baseEvidence(trade), takeProfit1: trade.takeProfit1, ...evidence },
  });
}

function closeStop(
  trade: PaperTrade,
  providerTimestamp: string,
  stopLevel: number,
  ambiguous: boolean,
  evidence: Evidence,
): PaperTransition {
  const closed: PaperTrade = {
    ...trade,
    state: "closed_stop",
    stateVersion: trade.stateVersion + 1,
    exitPrice: stopLevel,
    exitTime: providerTimestamp,
    resultR: -1,
    ambiguousIntrabar: trade.ambiguousIntrabar || ambiguous,
  };
  return transition(trade, closed, {
    eventKey: `closed_stop:${providerTimestamp}`,
    type: "closed_stop",
    providerTimestamp,
    evidence: {
      ...baseEvidence(trade),
      exitPrice: stopLevel,
      resultR: -1,
      ambiguousIntrabar: closed.ambiguousIntrabar,
      ...evidence,
    },
  });
}

function closeBreakeven(
  trade: PaperTrade,
  providerTimestamp: string,
  breakevenLevel: number,
  ambiguous: boolean,
  evidence: Evidence,
): PaperTransition {
  const closed: PaperTrade = {
    ...trade,
    state: "closed_breakeven",
    stateVersion: trade.stateVersion + 1,
    exitPrice: breakevenLevel,
    exitTime: providerTimestamp,
    resultR: 0,
    ambiguousIntrabar: trade.ambiguousIntrabar || ambiguous,
  };
  return transition(trade, closed, {
    eventKey: `closed_breakeven:${providerTimestamp}`,
    type: "closed_breakeven",
    providerTimestamp,
    evidence: {
      ...baseEvidence(trade),
      exitPrice: breakevenLevel,
      resultR: 0,
      ambiguousIntrabar: closed.ambiguousIntrabar,
      ...evidence,
    },
  });
}

function closeTp2(
  trade: PaperTrade,
  providerTimestamp: string,
  evidence: Evidence,
): PaperTransition {
  const closed: PaperTrade = {
    ...trade,
    state: "closed_tp2",
    stateVersion: trade.stateVersion + 1,
    exitPrice: trade.takeProfit2,
    exitTime: providerTimestamp,
    resultR: 2,
  };
  return transition(trade, closed, {
    eventKey: `closed_tp2:${providerTimestamp}`,
    type: "closed_tp2",
    providerTimestamp,
    evidence: { ...baseEvidence(trade), exitPrice: trade.takeProfit2, resultR: 2, ...evidence },
  });
}

/**
 * Advance a paper trade by one market observation (or by wall-clock expiry
 * when `observation` is null). Returns a transition to persist, or null when
 * the observation is stale/duplicate or the trade is already terminal.
 *
 * The returned `next` carries `stateVersion + 1`; the repository persists it
 * only if the stored row still matches `expectedVersion` (compare-and-swap).
 */
export function advancePaperTrade(
  trade: PaperTrade,
  observation: PaperObservation | null,
  now: number,
): PaperTransition | null {
  if (trade.lotSize !== PAPER_LOT_SIZE) {
    throw new Error(`lot size must be ${PAPER_LOT_SIZE}, got ${trade.lotSize}`);
  }
  if (TERMINAL_STATES.has(trade.state)) return null;

  const providerTimestamp = observation
    ? observation.kind === "quote"
      ? observation.value.providerTime
      : observation.value.time
    : null;

  // Reject duplicate or older observations: they must never advance the trade
  // twice, and especially never re-resolve an already-observed bar.
  if (providerTimestamp !== null && trade.lastObservedAt !== null) {
    const ts = Date.parse(providerTimestamp);
    const last = Date.parse(trade.lastObservedAt);
    if (!Number.isFinite(ts) || ts <= last) return null;
  }

  // Expiry takes precedence over any observation: a pending order that is
  // still unfilled when `now` passes `expiresAt` must not fill late.
  if (trade.state === "waiting_entry" && now > Date.parse(trade.expiresAt)) {
    const expired: PaperTrade = {
      ...trade,
      state: "expired",
      stateVersion: trade.stateVersion + 1,
    };
    return transition(trade, expired, {
      eventKey: `expired:${trade.expiresAt}`,
      type: "expired",
      providerTimestamp: null,
      evidence: { ...baseEvidence(trade), expiresAt: trade.expiresAt },
    });
  }

  if (!observation) return null;
  const providerTs: string =
    observation.kind === "quote" ? observation.value.providerTime : observation.value.time;

  const seen = { ...trade, lastObservedAt: providerTs };

  if (trade.state === "waiting_entry") {
    if (observation.kind === "quote") {
      const q = observation.value;
      if (trade.direction === "long" && q.ask <= trade.plannedEntry) {
        return entryFill(seen, q.ask, q.providerTime, { side: "ask", bid: q.bid, ask: q.ask });
      }
      if (trade.direction === "short" && q.bid >= trade.plannedEntry) {
        return entryFill(seen, q.bid, q.providerTime, { side: "bid", bid: q.bid, ask: q.ask });
      }
      return observationOnly(seen, providerTs, {
        kind: "quote",
        bid: q.bid,
        ask: q.ask,
      });
    }
    const c = observation.value;
    if (trade.direction === "long" && c.ask.low <= trade.plannedEntry) {
      return entryFill(seen, trade.plannedEntry, c.time, {
        side: "ask",
        askLow: c.ask.low,
        askHigh: c.ask.high,
      });
    }
    if (trade.direction === "short" && c.bid.high >= trade.plannedEntry) {
      return entryFill(seen, trade.plannedEntry, c.time, {
        side: "bid",
        bidLow: c.bid.low,
        bidHigh: c.bid.high,
      });
    }
    return observationOnly(seen, providerTs, { kind: "candle", time: c.time });
  }

  // open / tp1_protected: exits run on the exit-side price (bid for long,
  // ask for short). Candles additionally record MAE/MFE and barsHeld.
  const risk = Math.abs((trade.entryPrice ?? trade.plannedEntry) - trade.stopLoss);
  let maeR = trade.maeR;
  let mfeR = trade.mfeR;
  let barsHeld = trade.barsHeld;

  if (observation.kind === "candle") {
    const c = observation.value;
    const exitHigh = trade.direction === "long" ? c.bid.high : c.ask.high;
    const exitLow = trade.direction === "long" ? c.bid.low : c.ask.low;
    const entry = trade.entryPrice ?? trade.plannedEntry;
    const favourable = trade.direction === "long" ? exitHigh - entry : entry - exitLow;
    const adverse = trade.direction === "long" ? entry - exitLow : exitHigh - entry;
    mfeR = Math.max(mfeR, risk > 0 ? favourable / risk : 0);
    maeR = Math.max(maeR, risk > 0 ? adverse / risk : 0);
    barsHeld += 1;

    const updated = {
      ...seen,
      maeR: +maeR.toFixed(4),
      mfeR: +mfeR.toFixed(4),
      barsHeld,
    };

    const touchedSl = trade.direction === "long" ? exitLow <= trade.stopLoss : exitHigh >= trade.stopLoss;
    const touchedTp2 = trade.direction === "long" ? exitHigh >= trade.takeProfit2 : exitLow <= trade.takeProfit2;
    const touchedTp1 = trade.direction === "long" ? exitHigh >= trade.takeProfit1 : exitLow <= trade.takeProfit1;

    if (trade.state === "open") {
      // Stop beats every target when ordering is unknowable within the bar.
      if (touchedSl && (touchedTp1 || touchedTp2)) {
        return closeStop(updated, c.time, trade.stopLoss, true, {
          bidLow: c.bid.low,
          bidHigh: c.bid.high,
          askLow: c.ask.low,
          askHigh: c.ask.high,
        });
      }
      if (touchedSl) {
        return closeStop(updated, c.time, trade.stopLoss, false, {
          bidLow: c.bid.low,
          bidHigh: c.bid.high,
          askLow: c.ask.low,
          askHigh: c.ask.high,
        });
      }
      if (touchedTp2) return closeTp2(updated, c.time, {});
      if (touchedTp1) return armTp1(updated, c.time, {});
      return observationOnly(updated, providerTs, { kind: "candle", time: c.time });
    }

    // tp1_protected: only the breakeven stop (entry) and TP2 are live. The
    // arming candle already returned above, so a strictly later candle can
    // reach the new stop — the same-candle round trip is never assumed.
    const breakevenLevel = entry;
    const touchedBE = trade.direction === "long" ? exitLow <= breakevenLevel : exitHigh >= breakevenLevel;
    if (touchedBE && touchedTp2) {
      return closeBreakeven(updated, c.time, breakevenLevel, true, {
        bidLow: c.bid.low,
        bidHigh: c.bid.high,
      });
    }
    if (touchedBE) {
      return closeBreakeven(updated, c.time, breakevenLevel, false, {
        bidLow: c.bid.low,
        bidHigh: c.bid.high,
      });
    }
    if (touchedTp2) return closeTp2(updated, c.time, {});
    return observationOnly(updated, providerTs, { kind: "candle", time: c.time });
  }

  // Quote observation on a live trade: a single price point, so no intrabar
  // ambiguity — but it can still hit the stop, TP1 (arming), or TP2.
  const q = observation.value;
  const sidePrice = trade.direction === "long" ? q.bid : q.ask;
  if (trade.state === "open") {
    if (trade.direction === "long" ? sidePrice <= trade.stopLoss : sidePrice >= trade.stopLoss) {
      return closeStop(seen, q.providerTime, trade.stopLoss, false, { bid: q.bid, ask: q.ask });
    }
    if (trade.direction === "long" ? sidePrice >= trade.takeProfit2 : sidePrice <= trade.takeProfit2) {
      return closeTp2(seen, q.providerTime, { bid: q.bid, ask: q.ask });
    }
    if (trade.direction === "long" ? sidePrice >= trade.takeProfit1 : sidePrice <= trade.takeProfit1) {
      return armTp1(seen, q.providerTime, { bid: q.bid, ask: q.ask });
    }
    return observationOnly(seen, providerTs, { kind: "quote", bid: q.bid, ask: q.ask });
  }

  const breakevenLevel = trade.entryPrice ?? trade.plannedEntry;
  if (trade.direction === "long" ? sidePrice <= breakevenLevel : sidePrice >= breakevenLevel) {
    return closeBreakeven(seen, q.providerTime, breakevenLevel, false, { bid: q.bid, ask: q.ask });
  }
  if (trade.direction === "long" ? sidePrice >= trade.takeProfit2 : sidePrice <= trade.takeProfit2) {
    return closeTp2(seen, q.providerTime, { bid: q.bid, ask: q.ask });
  }
  return observationOnly(seen, providerTs, { kind: "quote", bid: q.bid, ask: q.ask });
}
