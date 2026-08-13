// View-model tests for the canonical XAUUSD paper slice.
//
// The mapper is pure: rows arrive from the authenticated read functions and
// are turned into DTOs with full PHT timestamps, PAPER ONLY branding, the
// B-single trade state, and provider provenance. Invalid canonical rows throw
// a safe mapping error — they are never shown as valid.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mapPaperSignalListItem,
  mapPaperShadowLearningReport,
  summarizePaperPerformance,
  summarizePaperStrategyHealth,
  PaperViewMappingError,
  type PaperLearningOutcomeRow,
  type PaperSignalJoinRow,
  type PaperStrategyHealthRow,
} from "./xauusd-paper-view.ts";

const ACTIVE_ROW: PaperSignalJoinRow = {
  id: "sig-1",
  pair: "XAUUSD",
  direction: "long",
  mode: "intraday",
  timeframe: "H1",
  entry: "3412.75",
  stop_loss: "3408.25",
  take_profit_1: "3421.50",
  take_profit_2: "3430.00",
  atr: "3.25",
  confluence: "78",
  contributing_strategies: ["momentum_breakout", "trend_following"],
  rationale: "Breakout of the Asian range with momentum confirmation.",
  created_at: "2026-08-11T05:30:00.000Z",
  archived_at: null,
  engine_version: "3",
  policy_version: "walkforward_v3",
  execution_policy_version: "b_single_v1",
  generated_by: "xauusd_paper_worker",
  scan_fingerprint: "fp-1",
  paper_trades: {
    state: "open",
    entry_price: "3412.87",
    entry_time: "2026-08-11T05:30:02.000Z",
    tp1_armed_at: null,
    exit_price: null,
    exit_time: null,
    result_r: null,
  },
  market_snapshots: {
    provider: "TV_OANDA_FEED",
    instrument: "XAU_USD",
    provider_time: "2026-08-11T05:29:58.123Z",
  },
  scan_runs: {
    engine_accounting: {
      evaluated: ["momentum_breakout"],
      abstained: ["trend_following"],
      incompatible: ["asian_range"],
      excluded: [],
      failed: [{ strategyId: "news_reactive", code: "macro_context_unavailable" }],
    },
  },
};

const ARCHIVED_ROW: PaperSignalJoinRow = {
  ...ACTIVE_ROW,
  id: "sig-2",
  archived_at: "2026-09-10T00:05:00.000Z",
  paper_trades: {
    state: "closed_tp2",
    entry_price: "3398.10",
    entry_time: "2026-08-11T05:30:02.000Z",
    tp1_armed_at: "2026-08-11T06:12:00.000Z",
    exit_price: "3406.10",
    exit_time: "2026-08-11T06:30:00.000Z",
    result_r: "2",
    mae_r: "-0.4",
    mfe_r: "1.9",
    bars_held: 14,
    ambiguous_intrabar: false,
    expires_at: "2026-08-11T07:00:00.000Z",
  },
};

function outcomeRow(overrides: Partial<PaperLearningOutcomeRow>): PaperLearningOutcomeRow {
  return {
    id: "sig-3",
    pair: "XAUUSD",
    direction: "long",
    mode: "intraday",
    timeframe: "H1",
    confluence: 70,
    contributing_strategies: ["momentum_breakout"],
    created_at: "2026-08-10T04:00:00.000Z",
    archived_at: null,
    execution_policy_version: "b_single_v1",
    generated_by: "xauusd_paper_worker",
    paper_trades: { state: "closed_tp2" },
    ...overrides,
  };
}

describe("mapPaperSignalListItem", () => {
  it("maps a canonical active row with full PHT timestamp, UTC title, paper branding, trade state and provider provenance", () => {
    const item = mapPaperSignalListItem(ACTIVE_ROW);

    assert.equal(item.pair, "XAUUSD");
    assert.equal(item.direction, "long");
    assert.equal(item.mode, "intraday");
    assert.equal(item.timeframe, "H1");
    assert.equal(item.entry, 3412.75);
    assert.equal(item.stopLoss, 3408.25);
    assert.equal(item.takeProfit1, 3421.5);
    assert.equal(item.takeProfit2, 3430);
    assert.equal(item.atr, 3.25);
    assert.equal(item.confluence, 78);
    assert.deepEqual(item.contributingStrategies, ["momentum_breakout", "trend_following"]);
    assert.equal(item.rationale, "Breakout of the Asian range with momentum confirmation.");
    assert.equal(item.lotSize, 0.01);
    assert.equal(item.paperOnly, true);
    assert.equal(item.paperLabel, "PAPER ONLY · 0.01 LOT · NO BROKER CONNECTION");

    // Full PHT timestamp: weekday, date, time, and the fixed zone label.
    assert.match(item.timestampPht, /^Tue, \d{2} Aug 2026 · \d{1,2}:\d{2}:\d{2} (AM|PM) PHT$/);
    assert.equal(item.timestampUtc, "2026-08-11T05:30:00.000Z");

    assert.equal(item.archived, false);
    assert.deepEqual(item.trade, {
      state: "open",
      entryPrice: 3412.87,
      entryTime: "2026-08-11T05:30:02.000Z",
      tp1ArmedAt: null,
      exitPrice: null,
      exitTime: null,
      resultR: null,
      maeR: null,
      mfeR: null,
      barsHeld: 0,
      ambiguousIntrabar: false,
      expiresAtUtc: "",
    });
    assert.deepEqual(item.provider, {
      name: "TV_OANDA_FEED",
      instrument: "XAU_USD",
      providerTime: "2026-08-11T05:29:58.123Z",
    });
    assert.deepEqual(item.engine, {
      version: "3",
      policyVersion: "walkforward_v3",
      accounting: {
        evaluated: ["momentum_breakout"],
        abstained: ["trend_following"],
        incompatible: ["asian_range"],
        excluded: [],
        failed: [{ strategyId: "news_reactive", code: "macro_context_unavailable" }],
      },
    });

    // No broker/order/account fields ever leak into the DTO.
    for (const forbidden of [
      "broker",
      "orderId",
      "order_id",
      "accountId",
      "account_id",
      "mt5",
      "magic",
      "ticket",
    ]) {
      assert.equal(forbidden in item, false, `DTO must not expose ${forbidden}`);
    }
    assert.equal("user_id" in item, false);
  });

  it("maps an archived row with archived=true and the terminal B-single trade state", () => {
    const item = mapPaperSignalListItem(ARCHIVED_ROW);
    assert.equal(item.archived, true);
    assert.deepEqual(item.trade, {
      state: "closed_tp2",
      entryPrice: 3398.1,
      entryTime: "2026-08-11T05:30:02.000Z",
      tp1ArmedAt: "2026-08-11T06:12:00.000Z",
      exitPrice: 3406.1,
      exitTime: "2026-08-11T06:30:00.000Z",
      resultR: 2,
      maeR: -0.4,
      mfeR: 1.9,
      barsHeld: 14,
      ambiguousIntrabar: false,
      expiresAtUtc: "2026-08-11T07:00:00.000Z",
    });
  });

  it("throws a safe mapping error for a non-XAUUSD canonical row", () => {
    assert.throws(
      () => mapPaperSignalListItem({ ...ACTIVE_ROW, pair: "EURUSD" }),
      (error: unknown) => error instanceof PaperViewMappingError && /XAUUSD/.test(error.message),
    );
  });

  it("throws a safe mapping error for a non-finite decimal string", () => {
    assert.throws(
      () => mapPaperSignalListItem({ ...ACTIVE_ROW, entry: "not-a-number" }),
      (error: unknown) => error instanceof PaperViewMappingError,
    );
    assert.throws(
      () =>
        mapPaperSignalListItem({
          ...ACTIVE_ROW,
          paper_trades: { ...ACTIVE_ROW.paper_trades!, result_r: "oops" },
        }),
      (error: unknown) => error instanceof PaperViewMappingError,
    );
  });

  it("throws a safe mapping error when the canonical trade row is missing", () => {
    assert.throws(
      () => mapPaperSignalListItem({ ...ACTIVE_ROW, paper_trades: null }),
      (error: unknown) => error instanceof PaperViewMappingError,
    );
  });

  it("tolerates a missing scan_runs join by defaulting accounting to empty lists", () => {
    const { scan_runs: _drop, ...row } = ACTIVE_ROW;
    const item = mapPaperSignalListItem(row);
    assert.deepEqual(item.engine.accounting, {
      evaluated: [],
      abstained: [],
      incompatible: [],
      excluded: [],
      failed: [],
    });
  });
});

describe("mapPaperShadowLearningReport", () => {
  it("includes archived terminal rows and reports applied=false with a sample size", () => {
    const archivedWin = outcomeRow({
      id: "sig-a",
      archived_at: "2026-09-10T00:05:00.000Z",
      paper_trades: { state: "closed_tp2" },
    });
    const activeLoss = outcomeRow({
      id: "sig-b",
      archived_at: null,
      paper_trades: { state: "closed_stop" },
    });
    const report = mapPaperShadowLearningReport([archivedWin, activeLoss]);

    assert.equal(report.executionPolicyVersion, "b_single_v1");
    assert.equal(report.applied, false);
    assert.equal(report.sampleSize, 2);
    const candidate = report.candidates.find((c) => c.strategyId === "momentum_breakout");
    assert.ok(candidate);
    // Win + loss => resolved 2, wins 1, scratches 0, losses 1, totalR +1.
    assert.equal(candidate.resolved, 2);
    assert.equal(candidate.wins, 1);
    assert.equal(candidate.scratches, 0);
    assert.equal(candidate.losses, 1);
    assert.equal(candidate.totalR, 1);
    assert.equal(typeof candidate.candidateMultiplier, "number");
    assert.equal(["boost", "cool", "hold", "insufficient"].includes(candidate.verdict), true);
  });

  it("excludes legacy rows and rows with a mismatched policy version", () => {
    const legacy = outcomeRow({ id: "legacy-1", generated_by: "legacy_browser" });
    const mismatched = outcomeRow({
      id: "old-policy",
      execution_policy_version: "b_single_v0",
      paper_trades: { state: "closed_tp2" },
    });
    const report = mapPaperShadowLearningReport([legacy, mismatched]);
    assert.equal(report.sampleSize, 0);
    assert.deepEqual(report.candidates, []);
  });

  it("treats breakeven as a scratch: resolved denominator, neither win nor loss, totalR 0", () => {
    const scratch = outcomeRow({
      id: "be-1",
      paper_trades: { state: "closed_breakeven" },
    });
    const report = mapPaperShadowLearningReport([scratch]);
    const candidate = report.candidates.find((c) => c.strategyId === "momentum_breakout");
    assert.ok(candidate);
    assert.equal(candidate.resolved, 1);
    assert.equal(candidate.wins, 0);
    assert.equal(candidate.scratches, 1);
    assert.equal(candidate.losses, 0);
    assert.equal(candidate.totalR, 0);
  });

  it("counts expired trades as stale, not resolved", () => {
    const expired = outcomeRow({
      id: "exp-1",
      paper_trades: { state: "expired" },
    });
    const report = mapPaperShadowLearningReport([expired]);
    assert.equal(report.sampleSize, 1);
    const candidate = report.candidates.find((c) => c.strategyId === "momentum_breakout");
    assert.ok(candidate);
    // Expiry contributes nothing to the resolved record — the candidate is
    // reported as insufficient evidence rather than a win/loss/scratch.
    assert.equal(candidate.resolved, 0);
    assert.equal(candidate.wins, 0);
    assert.equal(candidate.scratches, 0);
    assert.equal(candidate.losses, 0);
    assert.equal(candidate.totalR, 0);
    assert.equal(candidate.verdict, "insufficient");
  });

  it("is mode-scoped: an intraday outcome never feeds a scalper candidate", () => {
    const report = mapPaperShadowLearningReport([outcomeRow({ mode: "intraday" })]);
    assert.equal(
      report.candidates.find((c) => c.mode === "scalper"),
      undefined,
    );
  });
});

describe("summarizePaperPerformance", () => {
  it("counts scratches in the resolved denominator but neither wins nor losses", () => {
    const report = summarizePaperPerformance([
      outcomeRow({ id: "w", paper_trades: { state: "closed_tp2" } }),
      outcomeRow({ id: "b", paper_trades: { state: "closed_breakeven" } }),
      outcomeRow({ id: "s", paper_trades: { state: "closed_stop" } }),
    ]);
    assert.equal(report.resolved, 3);
    assert.equal(report.wins, 1);
    assert.equal(report.scratches, 1);
    assert.equal(report.losses, 1);
    assert.equal(report.totalR, 1); // +2 win, 0 scratch, -1 loss
    assert.equal(report.winRate, 1 / 3);
    assert.equal(report.stale, 0);
  });

  it("excludes legacy rows, mismatched policies, and non-terminal trades", () => {
    const report = summarizePaperPerformance([
      outcomeRow({
        id: "legacy",
        generated_by: "legacy_browser",
        paper_trades: { state: "closed_tp2" },
      }),
      outcomeRow({
        id: "old",
        execution_policy_version: "b_single_v0",
        paper_trades: { state: "closed_tp2" },
      }),
      outcomeRow({ id: "open", paper_trades: { state: "open" } }),
    ]);
    assert.equal(report.resolved, 0);
    assert.equal(report.wins, 0);
    assert.equal(report.totalR, 0);
  });
});

// ---------------------------------------------------------------------------
// summarizePaperStrategyHealth — the forward-tested scorecard aggregation.
// ---------------------------------------------------------------------------

function healthRow(
  strategies: string[],
  state: string,
  resultR: number | null,
  mode = "intraday",
): PaperStrategyHealthRow {
  return {
    id: crypto.randomUUID(),
    mode,
    timeframe: "M15",
    contributing_strategies: strategies,
    created_at: "2026-08-12T00:00:00.000Z",
    paper_trades: { state, result_r: resultR },
  };
}

it("aggregates wins, scratches, losses and R per contributing strategy", () => {
  const report = summarizePaperStrategyHealth([
    healthRow(["ema_trend", "donchian_break"], "closed_tp2", 2),
    healthRow(["ema_trend", "donchian_break"], "closed_breakeven", 0),
    healthRow(["ema_trend"], "closed_stop", -1),
    healthRow(["ema_trend"], "closed_stop", -1),
    healthRow(["vwap_mean_rev"], "closed_stop", -1),
  ]);
  const ema = report.strategies.find((s) => s.strategyId === "ema_trend")!;
  const donchian = report.strategies.find((s) => s.strategyId === "donchian_break")!;
  const vwap = report.strategies.find((s) => s.strategyId === "vwap_mean_rev")!;
  assert.equal(ema.signals, 4);
  assert.equal(ema.resolved, 4);
  assert.equal(ema.wins, 1);
  assert.equal(ema.scratches, 1);
  assert.equal(ema.losses, 2);
  assert.equal(ema.totalR, 0); // 2 + 0 - 1 - 1
  assert.equal(ema.winRate, 25);
  assert.equal(ema.sampleOk, false);
  assert.equal(donchian.resolved, 2);
  assert.equal(donchian.totalR, 2);
  // Winners sort first.
  assert.ok(report.strategies[0].strategyId === "donchian_break" || report.strategies[0].strategyId === "ema_trend");
  assert.equal(report.strategies.at(-1)!.strategyId, "vwap_mean_rev");
  assert.equal(vwap.totalR, -1);
  assert.equal(vwap.winRate, 0);
});

it("counts expired and open trades but never resolves them", () => {
  const report = summarizePaperStrategyHealth([
    healthRow(["rsi_momo"], "expired", null),
    healthRow(["rsi_momo"], "open", null),
    healthRow(["rsi_momo"], "tp1_protected", null),
    healthRow(["rsi_momo"], "closed_tp2", 2),
  ]);
  const rsi = report.strategies[0];
  assert.equal(rsi.signals, 4);
  assert.equal(rsi.resolved, 1);
  assert.equal(rsi.expired, 1);
  assert.equal(rsi.open, 2);
  assert.equal(rsi.winRate, 100);
});

it("splits by mode and reports null rates for empty strategy ids", () => {
  const report = summarizePaperStrategyHealth([
    healthRow(["bos_choch"], "closed_tp2", 2, "scalper"),
    healthRow(["bos_choch"], "closed_stop", -1, "scalper"),
    healthRow(["bos_choch"], "closed_tp2", 2, "intraday"),
  ]);
  const bos = report.strategies[0];
  assert.equal(bos.byMode.scalper!.resolved, 2);
  assert.equal(bos.byMode.scalper!.winRate, 50);
  assert.equal(bos.byMode.intraday!.resolved, 1);
  assert.equal(bos.byMode.intraday!.winRate, 100);
  assert.equal(bos.resolved, 3);
  assert.equal(bos.totalR, 3);
});

it("flags the 20-trade sample floor and never fabricates a rate", () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    healthRow(["ichimoku"], i % 2 === 0 ? "closed_tp2" : "closed_stop", i % 2 === 0 ? 2 : -1),
  );
  const ichimoku = summarizePaperStrategyHealth(rows).strategies[0];
  assert.equal(ichimoku.resolved, 25);
  assert.equal(ichimoku.sampleOk, true);
  const empty = summarizePaperStrategyHealth([]);
  assert.equal(empty.strategies.length, 0);
  assert.equal(empty.resolvedTotal, 0);
});
