import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOrder,
  isResolvedStatus,
  RESOLVED_STATUSES,
  summarizeSignal,
} from "./order-ticket.ts";

const long = {
  direction: "long" as const,
  entry: 3400,
  stop_loss: 3390,
  take_profit_1: 3412.5,
  take_profit_2: 3420,
};
const short = {
  direction: "short" as const,
  entry: 3400,
  stop_loss: 3410,
  take_profit_1: 3387.5,
  take_profit_2: 3380,
};

test("long: entry above price = buy stop (breakout)", () => {
  assert.equal(classifyOrder(long, 3396).kind, "buy_stop");
});
test("long: entry below price = buy limit (pullback)", () => {
  assert.equal(classifyOrder(long, 3404).kind, "buy_limit");
});
test("long: at entry = buy now", () => {
  assert.equal(classifyOrder(long, 3400.2).kind, "buy_now");
  assert.equal(classifyOrder(long, 3400).label, "BUY NOW");
});
test("long: stop breached = invalidated", () => {
  assert.equal(classifyOrder(long, 3389).kind, "invalidated");
  assert.equal(classifyOrder(long, 3390).kind, "invalidated");
  assert.equal(classifyOrder(long, 3389).closed, true);
});
test("long: tp1 already printed = too late", () => {
  assert.equal(classifyOrder(long, 3413).kind, "missed");
});
test("short: entry below price = sell stop (breakdown)", () => {
  assert.equal(classifyOrder(short, 3404).kind, "sell_stop");
});
test("short: entry above price = sell limit (pullback)", () => {
  assert.equal(classifyOrder(short, 3396).kind, "sell_limit");
});
test("short: stop breached = invalidated", () => {
  assert.equal(classifyOrder(short, 3411).kind, "invalidated");
});
test("short: tp1 taken = too late", () => {
  assert.equal(classifyOrder(short, 3386).kind, "missed");
});
test("invalidated wins over missed when both somehow true", () => {
  assert.equal(classifyOrder(long, 3380).kind, "invalidated");
});
test("no live price falls back to market reference", () => {
  assert.equal(classifyOrder(long, null).kind, "buy_now");
  assert.equal(classifyOrder(long, Number.NaN).kind, "buy_now");
});
// Regression: the null-mid branch above reports BUY NOW, which is only correct
// for a signal that is still live. `listSignals` deliberately skips the quote
// fetch for finished signals, so every finished signal arrives with a null mid.
// The client must therefore never route a finished signal into classifyOrder —
// the two lists that decide "finished" have to agree, or an invalidated setup
// renders as an actionable market order.
test("invalidated counts as resolved, so it never reaches the ticket path", () => {
  assert.equal(isResolvedStatus("invalidated"), true);
  assert.equal(classifyOrder(long, null).kind, "buy_now");
});
test("resolved statuses cover every terminal state listSignals can emit", () => {
  for (const status of ["hit_tp1", "hit_tp2", "hit_sl", "invalidated"]) {
    assert.equal(isResolvedStatus(status), true, `${status} should be resolved`);
  }
  for (const status of ["fresh", "valid", "late"]) {
    assert.equal(isResolvedStatus(status), false, `${status} should be open`);
  }
  assert.equal(RESOLVED_STATUSES.length, 4);
});
test("zero-risk signal does not divide by zero", () => {
  const t = classifyOrder({ ...long, stop_loss: 3400 }, 3400);
  assert.ok(Number.isFinite(t.distanceR));
});
test("distanceR is measured in units of risk", () => {
  assert.equal(classifyOrder(long, 3395).distanceR, 0.5);
});
test("summary is exactly three sentences", () => {
  const lines = summarizeSignal({
    ...long,
    timeframe: "M15",
    confluence: 72,
    atr: 4,
    contributing_strategies: ["ema_stack", "rsi_divergence", "order_block"],
    news_context: {
      strategy_engine: {
        votes: [{ strategyId: "ema_stack", direction: "long" }],
        mtf: { confirmed: "long", agreementScore: 80 },
      },
    },
  });
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.trim().endsWith(".")));
  assert.match(lines[1], /LONG tide is confirmed at 80%/);
  assert.match(lines[2], /2\.0R to TP2/);
});
test("summary describes a sweep when no mtf block is present", () => {
  const lines = summarizeSignal({
    ...long,
    timeframe: "H1",
    confluence: 65,
    atr: 4,
    contributing_strategies: ["ema_stack"],
    news_context: {
      strategy_engine: {
        sweep: {
          evaluated: [
            { timeframe: "M1", direction: null },
            { timeframe: "H1", direction: "long" },
            { timeframe: "H4", direction: "short" },
          ],
        },
      },
    },
  });
  assert.match(lines[1], /Swept 3 timeframes; 2 produced a setup and 1 pointed long/);
});
