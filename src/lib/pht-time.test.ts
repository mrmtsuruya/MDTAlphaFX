import assert from "node:assert/strict";
import test from "node:test";
import { formatPhtTimestamp, utcIsoTitle } from "./pht-time.ts";

test("formats approved PHT timestamp", () => {
  assert.equal(
    formatPhtTimestamp("2026-08-11T07:42:18.000Z"),
    "Tue, 11 Aug 2026 · 3:42:18 PM PHT",
  );
});

test("uses Manila date after UTC day boundary", () => {
  assert.equal(
    formatPhtTimestamp("2026-08-10T16:15:00.000Z"),
    "Tue, 11 Aug 2026 · 12:15:00 AM PHT",
  );
});

test("normalizes UTC tooltip and survives invalid input", () => {
  assert.equal(utcIsoTitle("2026-08-11T07:42:18Z"), "2026-08-11T07:42:18.000Z");
  assert.equal(formatPhtTimestamp("not-a-date"), "Invalid timestamp");
});
