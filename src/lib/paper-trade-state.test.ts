import assert from "node:assert/strict";
import test from "node:test";
import {
  advancePaperTrade,
  PAPER_LOT_SIZE,
  PAPER_POLICY_VERSION,
  PAPER_INSTRUMENT_SPEC_VERSION,
  type PaperObservation,
  type PaperTrade,
} from "./paper-trade-state.ts";
import type { NativeXauusdQuote, TwoSidedCandle } from "./xauusd-market-data.ts";

const NOW = Date.parse("2026-08-11T07:42:18Z");
const T1 = Date.parse("2026-08-11T07:43:00Z");
const T2 = Date.parse("2026-08-11T07:44:00Z");

const LONG: PaperTrade = {
  id: "trade-long",
  signalId: "sig-long",
  userId: "user-1",
  symbol: "XAUUSD",
  lotSize: 0.01,
  executionPolicyVersion: "b_single_v1",
  instrumentSpecVersion: "xauusd_0_01_lot_v1",
  direction: "long",
  timeframe: "M1",
  state: "waiting_entry",
  stateVersion: 0,
  plannedEntry: 3400,
  stopLoss: 3390,
  takeProfit1: 3412.5,
  takeProfit2: 3420,
  expiresAt: "2026-08-11T08:00:00.000Z",
  entryPrice: null,
  entryTime: null,
  exitPrice: null,
  exitTime: null,
  tp1ArmedAt: null,
  lastObservedAt: null,
  resultR: null,
  maeR: 0,
  mfeR: 0,
  barsHeld: 0,
  ambiguousIntrabar: false,
  createdAt: "2026-08-11T07:42:00.000Z",
};

const SHORT: PaperTrade = {
  ...LONG,
  id: "trade-short",
  signalId: "sig-short",
  direction: "short",
  plannedEntry: 3400,
  stopLoss: 3410,
  takeProfit1: 3387.5,
  takeProfit2: 3380,
};

function quote(bid: number, ask: number, providerTime = "2026-08-11T07:42:10.000Z"): PaperObservation {
  return {
    kind: "quote",
    value: {
      provider: "OANDA_V20_PRACTICE",
      instrument: "XAU_USD",
      bid,
      ask,
      providerTime,
      receivedAt: providerTime,
      tradeable: true,
    } satisfies NativeXauusdQuote,
  };
}

function candle({
  time = "2026-08-11T07:43:00.000Z",
  bidHigh = 3400.2,
  bidLow = 3399.9,
  askHigh = 3400.4,
  askLow = 3400.0,
}: {
  time?: string;
  bidHigh?: number;
  bidLow?: number;
  askHigh?: number;
  askLow?: number;
} = {}): PaperObservation {
  return {
    kind: "candle",
    value: {
      instrument: "XAU_USD",
      timeframe: "M1",
      time,
      bid: { open: 3400.0, high: bidHigh, low: bidLow, close: 3400.1 },
      ask: { open: 3400.2, high: askHigh, low: askLow, close: 3400.3 },
      volume: 1_000,
      complete: true,
    } satisfies TwoSidedCandle,
  };
}

test("generation quote fills long at native ask and short at native bid", () => {
  const longFilled = advancePaperTrade(LONG, quote(3399.8, 3400.0), NOW);
  assert.equal(longFilled?.next.state, "open");
  assert.equal(longFilled?.next.entryPrice, 3400.0);
  assert.equal(longFilled?.next.entryTime, "2026-08-11T07:42:10.000Z");
  assert.equal(longFilled?.event.type, "entry_filled");
  assert.equal(longFilled?.expectedVersion, 0);

  const shortFilled = advancePaperTrade(SHORT, quote(3400.0, 3400.2), NOW);
  assert.equal(shortFilled?.next.state, "open");
  assert.equal(shortFilled?.next.entryPrice, 3400.0);
  assert.equal(shortFilled?.next.entryTime, "2026-08-11T07:42:10.000Z");
});

test("later candle fills pending long only when ask range touches entry, short on bid range", () => {
  const noFill = advancePaperTrade(LONG, candle({ askLow: 3400.1 }), NOW);
  assert.equal(noFill?.next.state, "waiting_entry");
  assert.equal(noFill?.event.type, "market_observed");
  assert.equal(noFill?.next.lastObservedAt, "2026-08-11T07:43:00.000Z");

  const filled = advancePaperTrade(LONG, candle({ askLow: 3400.0 }), NOW);
  assert.equal(filled?.next.state, "open");
  assert.equal(filled?.next.entryPrice, 3400);

  const shortNoFill = advancePaperTrade(SHORT, candle({ bidHigh: 3399.9 }), NOW);
  assert.equal(shortNoFill?.next.state, "waiting_entry");
  const shortFilled = advancePaperTrade(SHORT, candle({ bidHigh: 3400.0 }), NOW);
  assert.equal(shortFilled?.next.state, "open");
  assert.equal(shortFilled?.next.entryPrice, 3400);
});

test("pending signal expires without fill, even when a fillable quote arrives late", () => {
  const late = Date.parse("2026-08-11T08:00:01Z");
  const expired = advancePaperTrade(LONG, null, late);
  assert.equal(expired?.next.state, "expired");
  assert.equal(expired?.event.type, "expired");
  assert.equal(expired?.next.resultR, null);

  // Expiry takes precedence over a fillable observation arriving after expiry.
  const alsoExpired = advancePaperTrade(LONG, quote(3399, 3399.5), late);
  assert.equal(alsoExpired?.next.state, "expired");
});

test("direct stop closes at -1R on both sides", () => {
  const longOpen = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  const stopped = advancePaperTrade(longOpen, candle({ bidLow: 3389.9 }), T1);
  assert.equal(stopped?.next.state, "closed_stop");
  assert.equal(stopped?.next.resultR, -1);
  assert.equal(stopped?.next.exitPrice, 3390);
  assert.equal(stopped?.event.type, "closed_stop");
  assert.equal(stopped?.event.providerTimestamp, "2026-08-11T07:43:00.000Z");

  const shortOpen = advancePaperTrade(SHORT, quote(3400.0, 3400.1), NOW)!.next;
  const shortStopped = advancePaperTrade(shortOpen, candle({ askHigh: 3410.1 }), T1);
  assert.equal(shortStopped?.next.state, "closed_stop");
  assert.equal(shortStopped?.next.resultR, -1);
});

test("TP1 arms the breakeven state and does not close", () => {
  const open = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  const armed = advancePaperTrade(open, candle({ bidHigh: 3413, bidLow: 3401 }), T1);
  assert.deepEqual(
    { to: armed?.next.state, resultR: armed?.next.resultR, event: armed?.event.type },
    { to: "tp1_protected", resultR: null, event: "tp1_protected" },
  );
  assert.equal(armed?.next.tp1ArmedAt, "2026-08-11T07:43:00.000Z");
});

test("the TP1 arming candle cannot also trigger the newly armed breakeven stop", () => {
  const open = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  // Same candle reaches TP1 (bidHigh 3413) AND dips back to entry (bidLow 3400).
  const armed = advancePaperTrade(open, candle({ bidHigh: 3413, bidLow: 3400 }), T1);
  assert.equal(armed?.next.state, "tp1_protected");
  assert.equal(armed?.event.type, "tp1_protected");
  assert.equal(armed?.next.resultR, null);
});

test("a later breakeven candle closes at 0R", () => {
  const open = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  const armed = advancePaperTrade(open, candle({ bidHigh: 3413, bidLow: 3401 }), T1)!.next;
  const scratched = advancePaperTrade(armed, candle({ time: "2026-08-11T07:44:00.000Z", bidLow: 3399.9 }), T2);
  assert.equal(scratched?.next.state, "closed_breakeven");
  assert.equal(scratched?.next.resultR, 0);
  assert.equal(scratched?.next.exitPrice, 3400);
  assert.equal(scratched?.event.type, "closed_breakeven");
});

test("TP2 closes at +2R from open and from the armed state", () => {
  const open = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  const tp2Direct = advancePaperTrade(open, candle({ bidHigh: 3421 }), T1);
  assert.equal(tp2Direct?.next.state, "closed_tp2");
  assert.equal(tp2Direct?.next.resultR, 2);
  assert.equal(tp2Direct?.next.exitPrice, 3420);

  const armed = advancePaperTrade(open, candle({ bidHigh: 3413, bidLow: 3401 }), T1)!.next;
  const tp2Armed = advancePaperTrade(
    armed,
    candle({ time: "2026-08-11T07:44:00.000Z", bidHigh: 3421, bidLow: 3401 }),
    T2,
  );
  assert.equal(tp2Armed?.next.state, "closed_tp2");
  assert.equal(tp2Armed?.next.resultR, 2);
});

test("stop and TP touched in one candle resolves adverse with ambiguousIntrabar", () => {
  const open = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  const ambiguous = advancePaperTrade(open, candle({ bidHigh: 3421, bidLow: 3389.9 }), T1);
  assert.equal(ambiguous?.next.state, "closed_stop");
  assert.equal(ambiguous?.next.resultR, -1);
  assert.equal(ambiguous?.next.ambiguousIntrabar, true);

  // A clean resolution leaves the flag false.
  const clean = advancePaperTrade(open, candle({ bidLow: 3389.9 }), T1);
  assert.equal(clean?.next.ambiguousIntrabar, false);
});

test("duplicate or older provider timestamps return no transition and cannot double-count bars", () => {
  const open = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  const first = advancePaperTrade(open, candle({ bidLow: 3401 }), T1);
  assert.equal(first?.event.type, "market_observed");
  assert.equal(first?.next.barsHeld, 1);

  const duplicate = advancePaperTrade(first!.next, candle({ time: "2026-08-11T07:43:00.000Z", bidLow: 3389.9 }), T1);
  assert.equal(duplicate, null);
  assert.equal(first!.next.barsHeld, 1);

  const older = advancePaperTrade(first!.next, candle({ time: "2026-08-11T07:42:30.000Z", bidLow: 3389.9 }), T1);
  assert.equal(older, null);
});

test("terminal states return no transition", () => {
  const stopped = advancePaperTrade(
    advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next,
    candle({ bidLow: 3389.9 }),
    T1,
  )!.next;
  assert.equal(stopped.state, "closed_stop");
  assert.equal(advancePaperTrade(stopped, quote(3399, 3399.2), T2), null);

  const expired = advancePaperTrade(LONG, null, Date.parse("2026-08-11T08:00:01Z"))!.next;
  assert.equal(advancePaperTrade(expired, quote(3399, 3399.2), T2), null);
});

test("a lot size other than 0.01 throws", () => {
  assert.throws(
    () => advancePaperTrade({ ...LONG, lotSize: 0.02 } as never, null, NOW),
    /0\.01/,
  );
  assert.throws(
    () => advancePaperTrade({ ...LONG, lotSize: 0 } as never, null, NOW),
    /0\.01/,
  );
});

test("constants pin the fixed execution contract", () => {
  assert.equal(PAPER_LOT_SIZE, 0.01);
  assert.equal(PAPER_POLICY_VERSION, "b_single_v1");
  assert.equal(PAPER_INSTRUMENT_SPEC_VERSION, "xauusd_0_01_lot_v1");
});

test("quotes advance live trades through stop and TP resolution", () => {
  const open = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  const stopped = advancePaperTrade(
    open,
    quote(3389.8, 3390.0, "2026-08-11T07:43:00.000Z"),
    T1,
  );
  assert.equal(stopped?.next.state, "closed_stop");
  assert.equal(stopped?.next.resultR, -1);

  const open2 = advancePaperTrade(LONG, quote(3399.9, 3400.0), NOW)!.next;
  const tp2 = advancePaperTrade(
    open2,
    quote(3420.1, 3420.3, "2026-08-11T07:43:00.000Z"),
    T1,
  );
  assert.equal(tp2?.next.state, "closed_tp2");
  assert.equal(tp2?.next.resultR, 2);
});
