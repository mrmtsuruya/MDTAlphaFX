import assert from "node:assert/strict";
import test from "node:test";
import { computePaperPosition } from "./xauusd-paper-pnl.ts";

test("long at 4400, price 4401.25, 0.01 lot: +$1.25 and +0.5R of a $2.50 stop", () => {
  const m = computePaperPosition({
    direction: "long",
    entry: 4400,
    stopLoss: 4397.5,
    lotSize: 0.01,
    current: 4401.25,
  });
  assert.deepEqual(m, { points: 1.25, usd: 1.25, r: 0.5 });
});

test("long at 4400, price 4398, 0.01 lot: -$2 and -0.8R", () => {
  const m = computePaperPosition({
    direction: "long",
    entry: 4400,
    stopLoss: 4397.5,
    lotSize: 0.01,
    current: 4398,
  });
  assert.deepEqual(m, { points: -2, usd: -2, r: -0.8 });
});

test("short benefits from falling price", () => {
  const m = computePaperPosition({
    direction: "short",
    entry: 4400,
    stopLoss: 4402.5,
    lotSize: 0.01,
    current: 4398.75,
  });
  assert.deepEqual(m, { points: 1.25, usd: 1.25, r: 0.5 });
});

test("lot size scales P&L but not R", () => {
  const half = computePaperPosition({
    direction: "long",
    entry: 4400,
    stopLoss: 4397.5,
    lotSize: 0.05,
    current: 4401.25,
  });
  assert.deepEqual(half, { points: 1.25, usd: 6.25, r: 0.5 });
});

test("non-finite or zero-risk inputs yield null", () => {
  assert.equal(
    computePaperPosition({
      direction: "long",
      entry: Number.NaN,
      stopLoss: 4397.5,
      lotSize: 0.01,
      current: 4401,
    }),
    null,
  );
  assert.equal(
    computePaperPosition({
      direction: "long",
      entry: 4400,
      stopLoss: 4400,
      lotSize: 0.01,
      current: 4401,
    }),
    null,
  );
  assert.equal(
    computePaperPosition({
      direction: "long",
      entry: 4400,
      stopLoss: 4397.5,
      lotSize: 0,
      current: 4401,
    }),
    null,
  );
});
