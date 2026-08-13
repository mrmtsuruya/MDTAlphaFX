// Exit-policy simulator fixtures. Each fixture is a real trading story:
// SL-first, TP1→TP2 runner, TP1→reversal (where a trail saves profit), a
// +0.5R excursion that reverses (where early BE saves the trade), the trail
// ratchet, and adversarial same-candle touches.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  simulateExitPolicies,
  type PolicySimInput,
  type PolicySimResult,
} from "./paper-policy-sim.ts";

// Long fixture: entry 3400, SL 3390 (risk 10 = 1R), TP1 3412.5 (1.25R),
// TP2 3420 (2R), ATR 5.
const LONG: PolicySimInput = {
  direction: "long",
  entry: 3400,
  stopLoss: 3390,
  takeProfit1: 3412.5,
  takeProfit2: 3420,
  atr: 5,
  entryTime: "2026-08-01T00:00:00Z",
  candles: [],
};

function candle(time: string, open: number, high: number, low: number, close: number) {
  return { time, open, high, low, close };
}

function byPolicy(results: PolicySimResult[]): Record<string, PolicySimResult> {
  return Object.fromEntries(results.map((r) => [r.policy, r]));
}

function closeTo(actual: number | null, expected: number, eps = 1e-5) {
  assert.ok(actual !== null, `expected ${expected}, got null`);
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected ${expected} ± ${eps}, got ${actual}`,
  );
}

describe("simulateExitPolicies", () => {
  it("SL first: every policy loses 1R", () => {
    const r = byPolicy(
      simulateExitPolicies({
        ...LONG,
        candles: [candle("2026-08-01T00:15:00Z", 3400, 3401, 3388, 3392)],
      }),
    );
    for (const policy of Object.keys(r)) {
      assert.equal(r[policy].state, "closed_stop");
      assert.equal(r[policy].resultR, -1);
      assert.equal(r[policy].barsHeld, 1);
    }
  });

  it("TP1 then TP2 runner: control +2R; close-at-TP1 stops at 1.25R", () => {
    const r = byPolicy(
      simulateExitPolicies({
        ...LONG,
        candles: [
          candle("2026-08-01T00:15:00Z", 3400, 3413, 3398, 3410),
          candle("2026-08-01T00:30:00Z", 3410, 3421, 3409, 3419),
        ],
      }),
    );
    assert.equal(r.b_single_v1.state, "closed_tp2");
    assert.equal(r.b_single_v1.resultR, 2);
    assert.equal(r.close_at_tp1_v1.state, "closed_tp1");
    closeTo(r.close_at_tp1_v1.resultR, 1.25);
    assert.equal(r.trail_after_tp1_v1.state, "closed_tp2");
    assert.equal(r.early_be_v1.state, "closed_tp2");
  });

  it("TP1 then reversal: trail exits +0.8R where control only scratches", () => {
    // Candle 1 touches TP1 (trail armed at 3413 - ATR = 3408). Candle 2
    // reverses below entry. Control: breakeven scratch. Trail: candle 2 low
    // 3398 trips the 3408 trail -> +0.8R.
    const r = byPolicy(
      simulateExitPolicies({
        ...LONG,
        candles: [
          candle("2026-08-01T00:15:00Z", 3400, 3413, 3398, 3410),
          candle("2026-08-01T00:30:00Z", 3410, 3411, 3398, 3401),
        ],
      }),
    );
    assert.equal(r.b_single_v1.state, "closed_breakeven");
    assert.equal(r.b_single_v1.resultR, 0);
    assert.equal(r.close_at_tp1_v1.state, "closed_tp1");
    closeTo(r.close_at_tp1_v1.resultR, 1.25);
    assert.equal(r.trail_after_tp1_v1.state, "trail_exit");
    closeTo(r.trail_after_tp1_v1.resultR, 0.8);
    assert.equal(r.early_be_v1.state, "closed_breakeven");
    assert.equal(r.early_be_v1.resultR, 0);
  });

  it("below early-BE threshold: no early protection, SL takes the trade", () => {
    // Candle 1 gains +0.4R (3404) — under the 0.5R threshold, so early_be
    // never arms. Candle 2 stops the trade.
    const r = byPolicy(
      simulateExitPolicies({
        ...LONG,
        candles: [
          candle("2026-08-01T00:15:00Z", 3400, 3404, 3396, 3402),
          candle("2026-08-01T00:30:00Z", 3402, 3403, 3388, 3392),
        ],
      }),
    );
    for (const policy of Object.keys(r)) {
      assert.equal(r[policy].state, "closed_stop");
      assert.equal(r[policy].resultR, -1);
    }
  });

  it("+0.6R excursion then reversal: early BE saves the trade, control loses 1R", () => {
    const r = byPolicy(
      simulateExitPolicies({
        ...LONG,
        candles: [
          candle("2026-08-01T00:15:00Z", 3400, 3406, 3396, 3404),
          candle("2026-08-01T00:30:00Z", 3404, 3405, 3388, 3392),
        ],
      }),
    );
    assert.equal(r.early_be_v1.state, "closed_breakeven");
    assert.equal(r.early_be_v1.resultR, 0);
    assert.equal(r.b_single_v1.state, "closed_stop");
    assert.equal(r.b_single_v1.resultR, -1);
    assert.equal(r.close_at_tp1_v1.state, "closed_stop");
    assert.equal(r.trail_after_tp1_v1.state, "closed_stop");
  });

  it("trail ratchets: +1.4R trail exit where control still holds open", () => {
    // TP1 at candle 1 (peak 3413, trail armed at 3408). Candle 2 pushes to
    // 3419 without touching the trail (low 3409), ratcheting it to 3414.
    // Candle 3 pulls back to 3410 — the 3414 trail takes +1.4R. Control never
    // sees BE (low stays above 3400) nor TP2, so it stays open.
    const r = byPolicy(
      simulateExitPolicies({
        ...LONG,
        candles: [
          candle("2026-08-01T00:15:00Z", 3400, 3413, 3398, 3410),
          candle("2026-08-01T00:30:00Z", 3410, 3419, 3409, 3416),
          candle("2026-08-01T00:45:00Z", 3416, 3417, 3410, 3412),
        ],
      }),
    );
    assert.equal(r.trail_after_tp1_v1.state, "trail_exit");
    closeTo(r.trail_after_tp1_v1.resultR, 1.4);
    assert.equal(r.trail_after_tp1_v1.barsHeld, 3);
    assert.equal(r.b_single_v1.state, "still_open");
    assert.equal(r.close_at_tp1_v1.state, "closed_tp1");
  });

  it("short mirrors the long mechanics", () => {
    // Short: entry 3400, SL 3410 (risk 10), TP1 3387.5, TP2 3380.
    const r = byPolicy(
      simulateExitPolicies({
        direction: "short",
        entry: 3400,
        stopLoss: 3410,
        takeProfit1: 3387.5,
        takeProfit2: 3380,
        atr: 5,
        entryTime: "2026-08-01T00:00:00Z",
        candles: [
          candle("2026-08-01T00:15:00Z", 3400, 3402, 3387, 3390),
          candle("2026-08-01T00:30:00Z", 3390, 3393, 3379, 3385),
        ],
      }),
    );
    assert.equal(r.b_single_v1.state, "closed_tp2");
    assert.equal(r.b_single_v1.resultR, 2);
    assert.equal(r.close_at_tp1_v1.state, "closed_tp1");
    closeTo(r.close_at_tp1_v1.resultR, 1.25);
  });

  it("same-candle stop + target resolves adversarially to the stop", () => {
    // Candle touches TP1 (3413 high) AND SL (3390 low) in one bar. The worker
    // treats intrabar order as unknowable: stop wins, flagged ambiguous.
    const r = byPolicy(
      simulateExitPolicies({
        ...LONG,
        candles: [candle("2026-08-01T00:15:00Z", 3400, 3413, 3390, 3400)],
      }),
    );
    assert.equal(r.b_single_v1.state, "closed_stop");
    assert.equal(r.b_single_v1.resultR, -1);
    assert.equal(r.b_single_v1.ambiguousIntrabar, true);
    assert.equal(r.trail_after_tp1_v1.ambiguousIntrabar, true);
  });

  it("candles at or before entry time are never replayed", () => {
    const r = byPolicy(
      simulateExitPolicies({
        ...LONG,
        candles: [
          candle("2026-08-01T00:00:00Z", 3400, 3413, 3390, 3400), // == entry time
          candle("2026-07-31T23:45:00Z", 3400, 3413, 3390, 3400), // older
        ],
      }),
    );
    assert.equal(r.b_single_v1.state, "still_open");
    assert.equal(r.b_single_v1.barsHeld, 0);
  });
});
