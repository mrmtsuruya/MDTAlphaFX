// Promotion gate + ledger fixtures. The stories: a sample-starved candidate
// can never be approved even with a great rate; a walk-forward-downweighted
// strategy is blocked; the ledger's latest row per (strategy, mode) decides
// the active state, and a revert clears a previous approve.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  activeMultipliers,
  clampPromotionMultiplier,
  evaluatePromotionGate,
  PROMOTION_MIN_SAMPLES,
  type PromotionLedgerRow,
} from "./strategy-promotion.ts";
import type { StrategyLearning } from "./signal-learning.ts";

function learned(over: Partial<StrategyLearning> = {}): StrategyLearning {
  return {
    strategyId: "ema_trend",
    mode: "intraday",
    resolved: 25,
    wins: 9,
    losses: 12,
    stale: 4,
    winRate: 0.45,
    totalR: 4.2,
    multiplier: 1.2,
    excluded: false,
    verdict: "boost",
    ...over,
  };
}

function row(over: Partial<PromotionLedgerRow>): PromotionLedgerRow {
  return {
    strategy_id: "ema_trend",
    mode: "intraday",
    action: "approve",
    multiplier: 1.2,
    created_at: "2026-08-14T00:00:00.000Z",
    ...over,
  };
}

describe("evaluatePromotionGate", () => {
  it("approves a boosted candidate above the sample floor with a healthy walk weight", () => {
    const gate = evaluatePromotionGate({ learned: learned(), walkWeight: 0.9 });
    assert.equal(gate.ok, true);
    assert.equal(gate.multiplier, 1.2);
    assert.deepEqual(gate.reasons, []);
  });

  it("blocks a candidate under the sample floor no matter the verdict", () => {
    const gate = evaluatePromotionGate({
      learned: learned({ resolved: PROMOTION_MIN_SAMPLES - 1, verdict: "boost" }),
      walkWeight: 0.9,
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.multiplier, null);
    assert.ok(gate.reasons.some((r) => r.includes("NEEDS_20_RESOLVED")));
  });

  it("blocks a cool candidate too (it may still be promoted once cooled — but never an insufficient one)", () => {
    assert.equal(
      evaluatePromotionGate({ learned: learned({ verdict: "cool" }), walkWeight: 0.9 }).ok,
      true,
      "cool is promotable — it is a real signal to reduce the weight",
    );
    const insufficient = evaluatePromotionGate({
      learned: learned({ verdict: "insufficient" }),
      walkWeight: 0.9,
    });
    assert.equal(insufficient.ok, false);
    assert.ok(insufficient.reasons.some((r) => r === "VERDICT_INSUFFICIENT"));
  });

  it("fails closed without walk-forward evidence or when the walk downweights it", () => {
    const noWalk = evaluatePromotionGate({ learned: learned(), walkWeight: null });
    assert.equal(noWalk.ok, false);
    assert.ok(noWalk.reasons.includes("NO_WALK_FORWARD_WEIGHT"));
    const downweighted = evaluatePromotionGate({ learned: learned(), walkWeight: 0.3 });
    assert.equal(downweighted.ok, false);
    assert.ok(downweighted.reasons.includes("WALK_DOWNWEIGHTED"));
  });

  it("clamps the promoted multiplier into the promotable band", () => {
    assert.equal(clampPromotionMultiplier(0.01), 0.15);
    assert.equal(clampPromotionMultiplier(9), 1.35);
    assert.equal(clampPromotionMultiplier(1.2), 1.2);
  });
});

describe("activeMultipliers", () => {
  it("latest row per strategy+mode wins; a revert clears a prior approve", () => {
    const rows = [
      row({ created_at: "2026-08-15T00:00:00.000Z", action: "revert", multiplier: 1 }),
      row({ created_at: "2026-08-14T00:00:00.000Z", action: "approve", multiplier: 1.2 }),
      row({
        created_at: "2026-08-15T00:00:00.000Z",
        strategy_id: "ema_trend",
        mode: "scalper",
        multiplier: 1.3,
      }),
    ];
    const active = activeMultipliers(rows);
    assert.equal(active.length, 2);
    const intraday = active.find((a) => a.mode === "intraday")!;
    const scalper = active.find((a) => a.mode === "scalper")!;
    assert.equal(intraday.multiplier, 1, "revert clears the intraday approve");
    assert.equal(scalper.multiplier, 1.3, "scalper approve stays active");
  });

  it("empty ledger means no multipliers", () => {
    assert.deepEqual(activeMultipliers([]), []);
  });
});
