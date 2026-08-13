import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runXauusdPaperCycle } from "./xauusd-paper-worker.ts";
import { OandaMarketDataError } from "./oanda-xauusd-provider.ts";
import { ALL_ENGINE_STRATEGY_IDS } from "./strategy-weights.ts";
import type {
  NativeXauusdQuote,
  PaperTimeframe,
  TwoSidedCandle,
  XauusdMarketDataProvider,
} from "./xauusd-market-data.ts";
import type { PaperTrade } from "./paper-trade-state.ts";
import type {
  CommitPaperSignal,
  FailScan,
  PaperProfile,
  PaperTransitionWrite,
  PaperWorkerRepository,
  ScanClaim,
} from "./xauusd-paper-repository.ts";

const NOW = () => new Date("2026-08-11T07:42:18.000Z");

// Narrow spread so scalp stop distances (a few units) comfortably clear the
// 10%-of-stop eligibility gate; the wide-spread test widens it deliberately.
const GOOD_QUOTE: NativeXauusdQuote = {
  provider: "OANDA_V20_PRACTICE",
  instrument: "XAU_USD",
  bid: 3400.0,
  ask: 3400.02,
  providerTime: "2026-08-11T07:42:10.000Z",
  receivedAt: "2026-08-11T07:42:11.000Z",
  tradeable: true,
};

const INTERVAL_MS: Record<PaperTimeframe, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

function trendCandles(
  timeframe: PaperTimeframe,
  direction: 1 | -1 = 1,
  count = 220,
  start = Date.parse("2026-08-11T00:00:00Z"),
  drift = 0.05,
): TwoSidedCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 3400 + direction * i * drift;
    const close = open + direction * drift + Math.sin(i * 0.7) * 0.02;
    const bidHigh = Math.max(open, close) + 0.08;
    const bidLow = Math.min(open, close) - 0.08;
    return {
      instrument: "XAU_USD",
      timeframe,
      time: new Date(start + i * INTERVAL_MS[timeframe]).toISOString(),
      bid: { open, high: bidHigh, low: bidLow, close },
      ask: { open: open + 0.2, high: bidHigh + 0.2, low: bidLow + 0.2, close: close + 0.2 },
      volume: 1_000 + i,
      complete: true,
    };
  });
}

class FakeProvider implements XauusdMarketDataProvider {
  quoteCalls = 0;
  quoteValue: NativeXauusdQuote = GOOD_QUOTE;
  latest: Partial<Record<PaperTimeframe, string>> = {};
  candleSets: Partial<Record<PaperTimeframe, TwoSidedCandle[]>> = {};
  throwQuote: Error | null = null;

  async health() {
    return { ok: true, code: "ok", checkedAt: "2026-08-11T07:42:11.000Z" };
  }
  async quote() {
    this.quoteCalls += 1;
    if (this.throwQuote) throw this.throwQuote;
    return this.quoteValue;
  }
  async latestCompleted() {
    const result = Object.fromEntries(
      (Object.keys(INTERVAL_MS) as PaperTimeframe[]).map((tf) => [tf, this.latest[tf] ?? null]),
    ) as Record<PaperTimeframe, string | null>;
    return result;
  }
  async completedCandles(timeframe: PaperTimeframe) {
    return this.candleSets[timeframe] ?? [];
  }
}

class FakeRepo implements PaperWorkerRepository {
  profiles: PaperProfile[] = [];
  enabledIds: string[] = [...ALL_ENGINE_STRATEGY_IDS];
  liveTrades: PaperTrade[] = [];
  claims: { fingerprint: string; scanRunId: string }[] = [];
  commits = 0;
  failCalls: { scanRunId: string; code: string }[] = [];
  healthCalls: { ok: boolean; code: string }[] = [];
  transitions: { tradeId: string; nextState: string; expectedVersion: number }[] = [];
  private nextId = 0;

  async recordWorkerHealth(input: { ok: boolean; code: string }) {
    this.healthCalls.push({ ok: input.ok, code: input.code });
  }
  async listEnabledProfiles() {
    return this.profiles;
  }
  async listEnabledStrategyIds() {
    return this.enabledIds;
  }
  async listActiveMultipliers() {
    return [];
  }
  async claimScan(input: ScanClaim) {
    const existing = this.claims.find((c) => c.fingerprint === input.scanFingerprint);
    if (existing) return { scanRunId: existing.scanRunId, claimed: false };
    this.nextId += 1;
    const scanRunId = `scan-${this.nextId}`;
    this.claims.push({ fingerprint: input.scanFingerprint, scanRunId });
    return { scanRunId, claimed: true };
  }
  async commitSignal(_input: CommitPaperSignal) {
    this.commits += 1;
    return { signalId: `sig-${this.commits}`, tradeId: `trade-${this.commits}`, created: true };
  }
  async failScan(input: FailScan) {
    this.failCalls.push({ scanRunId: input.scanRunId, code: input.code });
  }
  async listLiveTrades() {
    return this.liveTrades;
  }
  async applyTransition(input: PaperTransitionWrite) {
    this.transitions.push({
      tradeId: input.tradeId,
      nextState: input.next.state,
      expectedVersion: input.expectedVersion,
    });
    return true;
  }
}

function deps(provider: FakeProvider, repository: FakeRepo) {
  return {
    now: NOW,
    provider,
    repository,
    engineVersion: "engine-v1",
    policyVersion: "policy-v1",
  };
}

const PROFILE: PaperProfile = {
  userId: "user-1",
  enabled: true,
  activatedAt: "2026-08-11T07:00:00.000Z",
  symbol: "XAUUSD",
  lotSize: 0.01,
};

test("a disabled profile performs zero provider quote calls", async () => {
  const provider = new FakeProvider();
  const repo = new FakeRepo();
  const counts = await runXauusdPaperCycle(deps(provider, repo));
  assert.equal(provider.quoteCalls, 0);
  assert.equal(counts.profiles, 0);
  // Health is still recorded so activation can see a fresh row.
  assert.equal(repo.healthCalls.length, 1);
});

test("a stale quote fails every claimed scan and creates zero signals", async () => {
  const provider = new FakeProvider();
  provider.quoteValue = { ...GOOD_QUOTE, providerTime: "2026-08-11T07:41:00.000Z" };
  provider.latest = { M1: "2026-08-11T07:42:00.000Z" };
  provider.candleSets = { M1: trendCandles("M1") };
  const repo = new FakeRepo();
  repo.profiles = [PROFILE];

  const counts = await runXauusdPaperCycle(deps(provider, repo));
  assert.equal(counts.signals, 0);
  assert.equal(repo.commits, 0);
  assert.ok(repo.failCalls.length >= 1);
  assert.ok(repo.failCalls.every((f) => f.code === "stale_quote"));
});

test("the same completed candle invoked twice claims and commits only once", async () => {
  const provider = new FakeProvider();
  provider.latest = { M1: "2026-08-11T07:42:00.000Z" };
  provider.candleSets = { M1: trendCandles("M1") };
  const repo = new FakeRepo();
  repo.profiles = [PROFILE];

  const first = await runXauusdPaperCycle(deps(provider, repo));
  const second = await runXauusdPaperCycle(deps(provider, repo));
  assert.equal(first.scans, 1);
  assert.equal(first.signals, 1);
  assert.equal(repo.claims.length, 1);
  assert.equal(repo.commits, 1);
  assert.equal(second.signals, 0);
});

test("two newly completed timeframes create two independent signals and trades", async () => {
  const provider = new FakeProvider();
  provider.latest = {
    M1: "2026-08-11T07:42:00.000Z",
    M5: "2026-08-11T07:40:00.000Z",
  };
  provider.candleSets = {
    M1: trendCandles("M1"),
    M5: trendCandles("M5"),
  };
  const repo = new FakeRepo();
  repo.profiles = [PROFILE];

  const counts = await runXauusdPaperCycle(deps(provider, repo));
  assert.equal(counts.scans, 2);
  assert.equal(counts.signals, 2);
  assert.equal(repo.commits, 2);
});

test("a spread wider than 10% of the stop distance never reaches commit", async () => {
  const provider = new FakeProvider();
  provider.quoteValue = { ...GOOD_QUOTE, bid: 3400.0, ask: 3410.0 };
  provider.latest = { M1: "2026-08-11T07:42:00.000Z" };
  provider.candleSets = { M1: trendCandles("M1") };
  const repo = new FakeRepo();
  repo.profiles = [PROFILE];

  const counts = await runXauusdPaperCycle(deps(provider, repo));
  assert.equal(counts.signals, 0);
  assert.equal(repo.commits, 0);
});

test("a provider exception records degraded health and the next cycle recovers", async () => {
  const provider = new FakeProvider();
  provider.latest = { M1: "2026-08-11T07:42:00.000Z" };
  provider.candleSets = { M1: trendCandles("M1") };
  provider.throwQuote = new OandaMarketDataError("quote_unavailable", "network down");
  const repo = new FakeRepo();
  repo.profiles = [PROFILE];

  const broken = await runXauusdPaperCycle(deps(provider, repo));
  assert.equal(broken.signals, 0);
  assert.equal(repo.commits, 0);
  const lastHealth = repo.healthCalls.at(-1);
  assert.equal(lastHealth?.ok, false);
  assert.equal(lastHealth?.code, "quote_unavailable");

  provider.throwQuote = null;
  const recovered = await runXauusdPaperCycle(deps(provider, repo));
  assert.equal(recovered.signals, 1);
  assert.equal(repo.commits, 1);
});

test("live trades advance through the state machine with compare-and-swap writes", async () => {
  const provider = new FakeProvider();
  // Downtrend candles after the trade opened so the long's stop is touched.
  provider.candleSets = {
    M1: trendCandles("M1", -1, 102, Date.parse("2026-08-11T06:00:00Z"), 0.2),
  };
  provider.latest = { M1: "2026-08-11T07:41:00.000Z" };
  const repo = new FakeRepo();
  repo.profiles = [PROFILE];
  repo.liveTrades = [
    {
      id: "trade-live",
      signalId: "sig-live",
      userId: "user-1",
      symbol: "XAUUSD",
      lotSize: 0.01,
      executionPolicyVersion: "b_single_v1",
      instrumentSpecVersion: "xauusd_0_01_lot_v1",
      direction: "long",
      timeframe: "M1",
      state: "open",
      stateVersion: 0,
      plannedEntry: 3400,
      stopLoss: 3390,
      takeProfit1: 3412.5,
      takeProfit2: 3420,
      expiresAt: "2026-08-11T12:00:00.000Z",
      entryPrice: 3400,
      entryTime: "2026-08-11T07:00:00.000Z",
      exitPrice: null,
      exitTime: null,
      tp1ArmedAt: null,
      lastObservedAt: "2026-08-11T07:00:00.000Z",
      resultR: null,
      maeR: 0,
      mfeR: 0,
      barsHeld: 0,
      ambiguousIntrabar: false,
      createdAt: "2026-08-11T07:00:00.000Z",
    },
  ];

  const counts = await runXauusdPaperCycle(deps(provider, repo));
  assert.equal(counts.transitions, 1);
  assert.equal(repo.transitions.length, 1);
  assert.equal(repo.transitions[0].tradeId, "trade-live");
  assert.equal(repo.transitions[0].nextState, "closed_stop");
  assert.equal(repo.transitions[0].expectedVersion, 0);
});

test("no worker dependency exposes an order-capable interface", () => {
  const files = [
    "src/lib/xauusd-paper-worker.ts",
    "src/lib/xauusd-paper-repository.ts",
    "src/lib/oanda-xauusd-provider.ts",
    "src/lib/xauusd-paper-handler.ts",
    "src/lib/paper-scan-orchestration.ts",
    "src/lib/paper-trade-state.ts",
  ];
  const forbidden = ["mt5", "order", "broker", "trade-client", "local-cli"];
  for (const file of files) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import") && !trimmed.startsWith("export * from")) continue;
      for (const bad of forbidden) {
        assert.equal(
          line.toLowerCase().includes(bad),
          false,
          `${file}: import line contains "${bad}": ${line.trim()}`,
        );
      }
    }
  }
  // The OANDA adapter can only issue GET requests.
  const providerSource = readFileSync(
    new URL("../../src/lib/oanda-xauusd-provider.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(providerSource, /\b(POST|PUT|PATCH|DELETE)\b/);
});
