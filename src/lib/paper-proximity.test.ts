// Hold-odds + meters fixtures. The story: trades that travel 50% of the way
// to TP1 usually make it; trades that stall under 90% often reverse. The
// meters test the live open-trade readout.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeHoldStats, openTradeMeters, tp1DistanceR } from "./paper-proximity.ts";
import type { PaperSignalListItem } from "./xauusd-paper-view.ts";

const BASE: PaperSignalListItem = {
  id: "s",
  pair: "XAUUSD",
  direction: "long",
  mode: "intraday",
  timeframe: "M15",
  entry: 3400,
  stopLoss: 3390,
  takeProfit1: 3412.5, // 1.25R away
  takeProfit2: 3420,
  atr: 5,
  confluence: 70,
  contributingStrategies: [],
  rationale: null,
  lotSize: 0.01,
  paperOnly: true,
  paperLabel: "PAPER ONLY · 0.01 LOT · NO BROKER CONNECTION",
  timestampPht: "",
  timestampUtc: "",
  archived: false,
  trade: {
    state: "closed_tp2",
    entryPrice: 3400,
    entryTime: null,
    tp1ArmedAt: null,
    exitPrice: null,
    exitTime: null,
    resultR: 2,
    maeR: -0.2,
    mfeR: 1.4,
    barsHeld: 5,
    ambiguousIntrabar: false,
    expiresAtUtc: "",
  },
  provider: { name: "TV_OANDA_FEED", instrument: "XAU_USD", providerTime: "" },
  engine: {
    version: "",
    policyVersion: "",
    accounting: { evaluated: [], abstained: [], incompatible: [], excluded: [], failed: [] },
  },
};

function resolved(
  over: Partial<PaperSignalListItem["trade"]> & { mfeR: number; resultR: number },
  extra: Partial<PaperSignalListItem> = {},
): PaperSignalListItem {
  return { ...BASE, ...extra, trade: { ...BASE.trade, ...over } };
}

function closeTo(actual: number | null, expected: number, eps = 1e-5) {
  assert.ok(actual !== null, `expected ${expected}, got null`);
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected} ± ${eps}, got ${actual}`);
}

describe("tp1DistanceR", () => {
  it("1.25R for the standard gold ladder", () => {
    closeTo(tp1DistanceR(BASE), 1.25);
  });
  it("null when risk is zero", () => {
    assert.equal(tp1DistanceR({ entry: 3400, stopLoss: 3400, takeProfit1: 3410 }), null);
  });
});

describe("computeHoldStats", () => {
  it("bucket hit-rates come from the resolved ledger", () => {
    // 4 resolved trades that reached >=50% toward TP1 (0.625R of 1.25R).
    // 3 of them touched TP1 (mfeR >= 1.25R); the 4th peaked at 0.9R (72%).
    const signals = [
      resolved({ mfeR: 1.3, resultR: 2 }), // hit TP1, ran to TP2
      resolved({ mfeR: 1.26, resultR: 0 }), // touched TP1, BE exit
      resolved({ mfeR: 1.4, resultR: 2 }), // hit TP1, ran to TP2
      resolved({ mfeR: 0.9, resultR: -1 }), // 72% of the way, reversed to SL
      resolved({ mfeR: 0.4, resultR: -1 }), // under 50% — excluded from all buckets
    ];
    const stats = computeHoldStats(signals, "XAUUSD", "M15");
    const fifty = stats.find((s) => s.thresholdPct === 50)!;
    const ninety = stats.find((s) => s.thresholdPct === 90)!;
    assert.equal(fifty.reached, 4);
    assert.equal(fifty.hitTp1, 3);
    closeTo(fifty.hitRate!, 0.75);
    assert.equal(ninety.reached, 3);
    assert.equal(ninety.hitRate, 1);
  });

  it("other pairs/timeframes are ignored", () => {
    const signals = [
      resolved({ mfeR: 1.3, resultR: 2 }, { timeframe: "H1" }),
      resolved({ mfeR: 1.3, resultR: 2 }, { pair: "EURUSD" as never }),
    ];
    const stats = computeHoldStats(signals, "XAUUSD", "M15");
    for (const bucket of stats) assert.equal(bucket.reached, 0);
  });

  it("empty bucket reports a null hit rate", () => {
    const stats = computeHoldStats([], "XAUUSD", "M15");
    for (const bucket of stats) {
      assert.equal(bucket.reached, 0);
      assert.equal(bucket.hitRate, null);
    }
  });
});

describe("openTradeMeters", () => {
  it("long 1.25R from TP1 with 1.5R buffer above SL", () => {
    const m = openTradeMeters(BASE, 3405);
    assert.ok(m);
    closeTo(m.toTp1R, 0.75); // 3412.5 - 3405 = 7.5 / 10
    closeTo(m.toSlR, 1.5); // 3405 - 3390 = 15 / 10
    closeTo(m.toTp1Usd, 7.5); // $1 per $1 move at 0.01 lot
    closeTo(m.progressPct!, 40); // 5 of 12.5 toward TP1
  });

  it("short meters mirror the direction", () => {
    const short: PaperSignalListItem = {
      ...BASE,
      direction: "short",
      stopLoss: 3410,
      takeProfit1: 3387.5, // 1.25R below entry
      takeProfit2: 3380,
    };
    const m = openTradeMeters(short, 3395);
    assert.ok(m);
    closeTo(m.toTp1R, 0.75); // 3395 - 3387.5 = 7.5 / 10
    closeTo(m.toSlR, 1.5); // 3410 - 3395 = 15 / 10
    closeTo(m.progressPct!, 40); // 5 of 12.5 toward TP1
  });

  it("null without a quote or on zero risk", () => {
    assert.equal(openTradeMeters(BASE, null), null);
    assert.equal(
      openTradeMeters({ direction: "long", entry: 3400, stopLoss: 3400, takeProfit1: 3410 }, 3405),
      null,
    );
  });
});
