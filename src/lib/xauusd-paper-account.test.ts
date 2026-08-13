import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_STARTING_BALANCE_USD,
  summarizePaperAccount,
  type PaperAccountRow,
} from "./xauusd-paper-view.ts";

const base: Omit<PaperAccountRow, "id"> = {
  direction: "long",
  entry: 4400,
  stop_loss: 4390,
  created_at: "2026-08-13T00:00:00.000Z",
};

/** A closed trade at 4400 with a $10 risk (stop 4390). */
function closed(id: string, resultR: number, exitTime: string): PaperAccountRow {
  return {
    ...base,
    id,
    paper_trades: {
      state: resultR > 0 ? "closed_tp2" : resultR < 0 ? "closed_stop" : "closed_breakeven",
      entry_price: 4400,
      exit_price: null,
      exit_time: exitTime,
      result_r: resultR,
    },
  };
}

/** An open trade with a fill at entryPrice. */
function open(
  id: string,
  direction: "long" | "short",
  entryPrice: number,
  stopLoss: number,
): PaperAccountRow {
  return {
    ...base,
    id,
    direction,
    entry: entryPrice,
    stop_loss: stopLoss,
    paper_trades: {
      state: "open",
      entry_price: entryPrice,
      exit_price: null,
      result_r: null,
    },
  };
}

test("empty ledger is the starting balance", () => {
  assert.deepEqual(summarizePaperAccount([], null), {
    startingBalanceUsd: 200,
    balanceUsd: 200,
    floatingUsd: 0,
    equityUsd: 200,
    realizedUsd: 0,
    openCount: 0,
    resolvedCount: 0,
    maxDrawdownUsd: 0,
  });
});

test("TP2 books +2R as dollars of risk", () => {
  const summary = summarizePaperAccount(
    [closed("sig-tp2", 2, "2026-08-13T01:00:00.000Z")],
    null,
  );
  assert.equal(summary.realizedUsd, 20); // +2R × $10 risk
  assert.equal(summary.balanceUsd, 220);
  assert.equal(summary.equityUsd, 220);
  assert.equal(summary.resolvedCount, 1);
  assert.equal(summary.maxDrawdownUsd, 0);
});

test("stop-out books -1R and draws down realized equity", () => {
  const summary = summarizePaperAccount(
    [closed("sig-sl", -1, "2026-08-13T01:00:00.000Z")],
    null,
  );
  assert.equal(summary.realizedUsd, -10);
  assert.equal(summary.balanceUsd, 190);
  assert.equal(summary.maxDrawdownUsd, 10);
});

test("breakeven books 0R", () => {
  const summary = summarizePaperAccount(
    [closed("sig-be", 0, "2026-08-13T01:00:00.000Z")],
    null,
  );
  assert.equal(summary.realizedUsd, 0);
  assert.equal(summary.resolvedCount, 1);
  assert.equal(summary.balanceUsd, PAPER_STARTING_BALANCE_USD);
});

test("open long floats on the live mid", () => {
  const summary = summarizePaperAccount([open("sig-long", "long", 4400, 4390)], 4405);
  assert.equal(summary.floatingUsd, 5); // $1/point × 5
  assert.equal(summary.equityUsd, 205);
  assert.equal(summary.openCount, 1);
  assert.equal(summary.resolvedCount, 0);
});

test("open short floats on the live mid", () => {
  const summary = summarizePaperAccount([open("sig-short", "short", 4400, 4410)], 4395);
  assert.equal(summary.floatingUsd, 5);
});

test("floating is 0 while the feed is down", () => {
  const summary = summarizePaperAccount([open("sig-open", "long", 4400, 4390)], null);
  assert.equal(summary.floatingUsd, 0);
  assert.equal(summary.equityUsd, 200);
  assert.equal(summary.openCount, 1);
});

test("waiting_entry counts as open but has no floating", () => {
  const waiting: PaperAccountRow = {
    ...base,
    id: "sig-waiting",
    paper_trades: {
      state: "waiting_entry",
      entry_price: null,
      exit_price: null,
      result_r: null,
    },
  };
  const summary = summarizePaperAccount([waiting], 4405);
  assert.equal(summary.openCount, 1);
  assert.equal(summary.floatingUsd, 0);
  assert.equal(summary.resolvedCount, 0);
});

test("expired contributes nothing to the ledger", () => {
  const expired: PaperAccountRow = {
    ...base,
    id: "sig-expired",
    paper_trades: {
      state: "expired",
      entry_price: null,
      exit_price: null,
      result_r: null,
    },
  };
  const summary = summarizePaperAccount([expired], null);
  assert.equal(summary.openCount, 0);
  assert.equal(summary.resolvedCount, 0);
  assert.equal(summary.realizedUsd, 0);
});

test("drawdown follows exit-time order, not insertion order", () => {
  const l1 = closed("sig-l1", -1, "2026-08-13T01:00:00.000Z");
  const w1 = closed("sig-w1", 2, "2026-08-13T02:00:00.000Z");
  const l2 = closed("sig-l2", -1, "2026-08-13T03:00:00.000Z");
  const w2 = closed("sig-w2", 2, "2026-08-13T04:00:00.000Z");
  // Inserted with losses grouped; exit times interleave them. Correct order is
  // L1,W1,L2,W2 → 200→190→210→200→220, deepest dip 10. Grouped order would
  // dip 20 (190 then 180), so this pins the exit-time sort.
  const summary = summarizePaperAccount([l1, l2, w1, w2], null);
  assert.equal(summary.realizedUsd, 20);
  assert.equal(summary.maxDrawdownUsd, 10);
});
