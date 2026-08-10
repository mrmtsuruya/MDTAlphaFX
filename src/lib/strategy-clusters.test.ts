import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLUSTERS,
  clusterByAgreement,
  clusterDepthBonus,
  clusterOf,
  rollupByCluster,
  type AgreementMatrix,
  type ClusteredVote,
} from "./strategy-clusters.ts";
import { ALL_ENGINE_STRATEGY_IDS } from "./strategy-weights.ts";

const vote = (strategyId: string, strength: number, direction: "long" | "short" = "long") =>
  ({ strategyId, direction, strength }) as ClusteredVote;

/** Confluence as scanCandlesForSignal computes it, isolated for comparison. */
function confluenceOf(votes: ClusteredVote[], map: Record<string, string>) {
  const rollups = rollupByCluster(votes, map);
  const strength = rollups.reduce((sum, r) => sum + r.strength, 0) / rollups.length;
  return Math.round(
    Math.min(95, strength * 0.55 + 25 + rollups.length * 5 + clusterDepthBonus(rollups)),
  );
}

const identityMap = (votes: ClusteredVote[]) =>
  Object.fromEntries(votes.map((v) => [v.strategyId, v.strategyId]));

// --- the map ----------------------------------------------------------------

test("every engine strategy has a cluster assigned", () => {
  const unmapped = ALL_ENGINE_STRATEGY_IDS.filter((id) => !(id in DEFAULT_CLUSTERS));
  assert.deepEqual(unmapped, [], "a new strategy must be placed in a cluster deliberately");
});

test("an unmapped strategy becomes its own cluster rather than being pooled", () => {
  assert.equal(clusterOf("something_new"), "solo:something_new");
});

test("the moving-average family is one cluster", () => {
  const family = [
    "ema_trend",
    "ma_ribbon",
    "ichimoku",
    "supertrend",
    "heiken_ashi_scalp",
    "qullamaggie_breakout",
  ];
  const clusters = new Set(family.map((id) => clusterOf(id)));
  assert.equal(clusters.size, 1, `expected one cluster, got ${[...clusters].join(",")}`);
});

test("genuinely different reads stay in different clusters", () => {
  const distinct = ["ema_trend", "rsi_momo", "liquidity_sweep", "sr_confluence", "news_reactive"];
  const clusters = new Set(distinct.map((id) => clusterOf(id)));
  assert.equal(clusters.size, distinct.length);
});

// --- rollup -----------------------------------------------------------------

test("a cluster contributes its STRONGEST member, not an average", () => {
  const rollups = rollupByCluster([vote("ema_trend", 60), vote("ichimoku", 88)]);
  assert.equal(rollups.length, 1);
  assert.equal(rollups[0].strength, 88);
  assert.equal(rollups[0].members.length, 2);
});

test("rollups are ordered strongest first", () => {
  const rollups = rollupByCluster([vote("ema_trend", 60), vote("rsi_momo", 90)]);
  assert.equal(rollups[0].strength, 90);
});

test("depth bonus saturates so breadth cannot substitute for independence", () => {
  const two = clusterDepthBonus(rollupByCluster([vote("ema_trend", 70), vote("ichimoku", 70)]));
  const six = clusterDepthBonus(
    rollupByCluster(
      [
        "ema_trend",
        "ichimoku",
        "ma_ribbon",
        "supertrend",
        "heiken_ashi_scalp",
        "qullamaggie_breakout",
      ].map((id) => vote(id, 70)),
    ),
  );
  assert.ok(six > two, "a second member should count for something");
  assert.ok(six <= 4.5, `depth bonus must be capped, got ${six}`);
  assert.equal(
    six,
    clusterDepthBonus(
      rollupByCluster([vote("ema_trend", 70), vote("ichimoku", 70), vote("ma_ribbon", 70)]),
    ),
  );
});

// --- the actual defect being fixed ------------------------------------------

test("six correlated moving averages no longer score like six independent votes", () => {
  const votes = [
    "ema_trend",
    "ma_ribbon",
    "ichimoku",
    "supertrend",
    "heiken_ashi_scalp",
    "qullamaggie_breakout",
  ].map((id, i) => vote(id, 70 + i));

  const before = confluenceOf(votes, identityMap(votes));
  const after = confluenceOf(votes, DEFAULT_CLUSTERS);

  assert.equal(before, 95, "the old scheme saturated on one idea held six ways");
  assert.ok(after < before - 15, `expected a material drop, got ${before} -> ${after}`);
});

test("genuinely independent agreement is NOT penalised", () => {
  const votes = [
    vote("ema_trend", 72),
    vote("rsi_momo", 70),
    vote("liquidity_sweep", 74),
    vote("sr_confluence", 71),
  ];
  assert.equal(
    confluenceOf(votes, DEFAULT_CLUSTERS),
    confluenceOf(votes, identityMap(votes)),
    "four distinct reads must score the same either way — only duplication is discounted",
  );
});

// --- measuring a map from real votes ----------------------------------------

test("clusterByAgreement merges a highly-agreeing pair", () => {
  const matrix: AgreementMatrix = {
    strategyIds: ["a", "b", "c"],
    agreement: [
      [1, 0.95, 0.2],
      [0.95, 1, 0.25],
      [0.2, 0.25, 1],
    ],
    coVotes: [
      [0, 200, 200],
      [200, 0, 200],
      [200, 200, 0],
    ],
  };
  const map = clusterByAgreement(matrix, 0.8, 50);
  assert.equal(map.a, map.b, "a and b agree 95% of the time — one signal");
  assert.notEqual(map.a, map.c);
});

test("clusterByAgreement ignores high agreement on too few shared bars", () => {
  const matrix: AgreementMatrix = {
    strategyIds: ["a", "b"],
    agreement: [
      [1, 1],
      [1, 1],
    ],
    coVotes: [
      [0, 4],
      [4, 0],
    ],
  };
  const map = clusterByAgreement(matrix, 0.8, 50);
  assert.notEqual(map.a, map.b, "100% over 4 bars is noise, not evidence of duplication");
});

test("clusterByAgreement is transitive through single linkage", () => {
  // a~b and b~c, but a and c look unrelated directly. Conservative call: one cluster.
  const matrix: AgreementMatrix = {
    strategyIds: ["a", "b", "c"],
    agreement: [
      [1, 0.9, 0.5],
      [0.9, 1, 0.9],
      [0.5, 0.9, 1],
    ],
    coVotes: [
      [0, 100, 100],
      [100, 0, 100],
      [100, 100, 0],
    ],
  };
  const map = clusterByAgreement(matrix, 0.8, 50);
  assert.equal(map.a, map.c);
});

test("clusterByAgreement leaves everything separate when nothing correlates", () => {
  const matrix: AgreementMatrix = {
    strategyIds: ["a", "b", "c"],
    agreement: [
      [1, 0.4, 0.5],
      [0.4, 1, 0.45],
      [0.5, 0.45, 1],
    ],
    coVotes: [
      [0, 100, 100],
      [100, 0, 100],
      [100, 100, 0],
    ],
  };
  const map = clusterByAgreement(matrix, 0.8, 50);
  assert.equal(new Set(Object.values(map)).size, 3);
});
