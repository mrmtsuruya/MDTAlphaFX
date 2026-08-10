import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeBidAsk,
  monthChunks,
  normaliseTicks,
  rebuildManifestEntry,
} from "./fetch-history.mjs";

// monthChunks -----------------------------------------------------------

test("monthChunks: splits a range across a year boundary with partial first/last months", () => {
  const chunks = monthChunks("2025-11-15", "2026-02-03");

  assert.equal(chunks.length, 4);

  assert.equal(chunks[0].key, "2025-11");
  assert.equal(chunks[0].from.toISOString(), "2025-11-15T00:00:00.000Z");
  assert.equal(chunks[0].to.toISOString(), "2025-12-01T00:00:00.000Z");

  assert.equal(chunks[1].key, "2025-12");
  assert.equal(chunks[1].from.toISOString(), "2025-12-01T00:00:00.000Z");
  assert.equal(chunks[1].to.toISOString(), "2026-01-01T00:00:00.000Z");

  assert.equal(chunks[2].key, "2026-01");
  assert.equal(chunks[2].from.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(chunks[2].to.toISOString(), "2026-02-01T00:00:00.000Z");

  assert.equal(chunks[3].key, "2026-02");
  assert.equal(chunks[3].from.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(chunks[3].to.toISOString(), "2026-02-03T00:00:00.000Z");
});

test("monthChunks: a range inside a single month produces one partial chunk", () => {
  const chunks = monthChunks("2026-03-10", "2026-03-20");

  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], {
    key: "2026-03",
    from: new Date("2026-03-10T00:00:00.000Z"),
    to: new Date("2026-03-20T00:00:00.000Z"),
  });
});

test("monthChunks: a range that is exactly one calendar month produces one full chunk", () => {
  const chunks = monthChunks("2026-07-01", "2026-08-01");

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].key, "2026-07");
  assert.equal(chunks[0].from.toISOString(), "2026-07-01T00:00:00.000Z");
  assert.equal(chunks[0].to.toISOString(), "2026-08-01T00:00:00.000Z");
});

test("monthChunks: an empty or inverted range produces no chunks", () => {
  assert.deepEqual(monthChunks("2026-01-01", "2026-01-01"), []);
  assert.deepEqual(monthChunks("2026-02-01", "2026-01-01"), []);
});

// mergeBidAsk -------------------------------------------------------------

test("mergeBidAsk: aligned timestamps merge into one row with both sides", () => {
  const bidRows = [
    { timestamp: 1000, open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 10 },
    { timestamp: 2000, open: 1.1, high: 1.3, low: 1.0, close: 1.2, volume: 12 },
  ];
  const askRows = [
    { timestamp: 1000, open: 1.01, high: 1.21, low: 0.91, close: 1.11, volume: 11 },
    { timestamp: 2000, open: 1.11, high: 1.31, low: 1.01, close: 1.21, volume: 13 },
  ];

  const { rows, unmatched } = mergeBidAsk(bidRows, askRows);

  assert.equal(unmatched, 0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    timestamp: 1000,
    bid: { open: 1, high: 1.2, low: 0.9, close: 1.1 },
    ask: { open: 1.01, high: 1.21, low: 0.91, close: 1.11 },
    volume: 10,
  });
  assert.deepEqual(rows[1], {
    timestamp: 2000,
    bid: { open: 1.1, high: 1.3, low: 1.0, close: 1.2 },
    ask: { open: 1.11, high: 1.31, low: 1.01, close: 1.21 },
    volume: 12,
  });
});

test("mergeBidAsk: timestamps unique to one side are kept with null on the other, and counted", () => {
  const bidRows = [
    { timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 5 },
    { timestamp: 2000, open: 2, high: 2, low: 2, close: 2, volume: 5 }, // bid-only
  ];
  const askRows = [
    { timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 6 },
    { timestamp: 3000, open: 3, high: 3, low: 3, close: 3, volume: 6 }, // ask-only
  ];

  const { rows, unmatched } = mergeBidAsk(bidRows, askRows);

  assert.equal(unmatched, 2);
  assert.equal(rows.length, 3);

  const byTimestamp = new Map(rows.map((row) => [row.timestamp, row]));
  assert.notEqual(byTimestamp.get(2000).bid, null);
  assert.equal(byTimestamp.get(2000).ask, null);
  assert.equal(byTimestamp.get(3000).bid, null);
  assert.notEqual(byTimestamp.get(3000).ask, null);
});

test("mergeBidAsk: output is sorted ascending by timestamp regardless of input order", () => {
  const bidRows = [
    { timestamp: 3000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  ];
  const askRows = [
    { timestamp: 2000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { timestamp: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  ];

  const { rows } = mergeBidAsk(bidRows, askRows);

  assert.deepEqual(
    rows.map((row) => row.timestamp),
    [1000, 2000, 3000],
  );
});

// normaliseTicks ------------------------------------------------------------

test("normaliseTicks: renames package fields to bid/ask and sorts ascending", () => {
  const rows = [
    { timestamp: 2000, askPrice: 1.21, bidPrice: 1.2, askVolume: 3, bidVolume: 4 },
    { timestamp: 1000, askPrice: 1.11, bidPrice: 1.1, askVolume: 1, bidVolume: 2 },
  ];

  const normalised = normaliseTicks(rows);

  assert.deepEqual(normalised, [
    { timestamp: 1000, bid: 1.1, ask: 1.11, bidVolume: 2, askVolume: 1 },
    { timestamp: 2000, bid: 1.2, ask: 1.21, bidVolume: 4, askVolume: 3 },
  ]);
});

test("normaliseTicks: missing volumes become null rather than undefined", () => {
  const rows = [{ timestamp: 1000, askPrice: 1.11, bidPrice: 1.1 }];
  assert.deepEqual(normaliseTicks(rows), [
    { timestamp: 1000, bid: 1.1, ask: 1.11, bidVolume: null, askVolume: null },
  ]);
});

// rebuildManifestEntry --------------------------------------------------

test("rebuildManifestEntry: a hole between two present months is reported as missing", () => {
  const months = {
    "2026-01": { status: "ok", rows: 100 },
    "2026-03": { status: "ok", rows: 90 },
  };

  const result = rebuildManifestEntry(months);

  assert.deepEqual(result.coverage, { from: "2026-01", to: "2026-03" });
  assert.deepEqual(result.missingMonths, ["2026-02"]);
  assert.deepEqual(result.failedMonths, []);
});

test("rebuildManifestEntry: a failed month is reported in failedMonths, not missingMonths", () => {
  const months = {
    "2026-01": { status: "ok" },
    "2026-02": { status: "failed", error: "boom" },
    "2026-03": { status: "ok" },
  };

  const result = rebuildManifestEntry(months);

  assert.deepEqual(result.failedMonths, ["2026-02"]);
  assert.deepEqual(result.missingMonths, []);
});

test("rebuildManifestEntry: an empty months map does not throw", () => {
  assert.doesNotThrow(() => rebuildManifestEntry({}));

  const result = rebuildManifestEntry({});
  assert.deepEqual(result.coverage, { from: null, to: null });
  assert.deepEqual(result.missingMonths, []);
  assert.deepEqual(result.failedMonths, []);
});
