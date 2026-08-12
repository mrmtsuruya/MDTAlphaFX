// Static contract over the migration-required copy: the auto-paper panel's
// blocked-toggle reason and the dashboard / Signal Center empty states must
// all render THE SAME sentence, so the pre-deploy messaging can never drift
// between surfaces again (it already did once: the panel used to say "Schema
// migration required — run the paper-trading migrations before enabling."
// while the routes said "…before paper signals can appear."). Read the three
// sources and pin the exact canonical string; any intentional copy change
// must update this file too.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const PANEL = readFileSync(
  new URL("../components/xauusd-auto-paper-panel.tsx", import.meta.url),
  "utf8",
);
const DASHBOARD = readFileSync(
  new URL("../routes/_authenticated/dashboard.tsx", import.meta.url),
  "utf8",
);
const SIGNALS = readFileSync(
  new URL("../routes/_authenticated/signals.tsx", import.meta.url),
  "utf8",
);

const CANONICAL_MIGRATION_COPY =
  "The Auto-Paper schema is not deployed yet — run the paper-trading migrations before paper signals can appear.";

// Old phrasings that must never return: the panel's former toggle reason and
// the Signal Center's former "signals" (vs "paper signals") ending.
const RETIRED_VARIANTS = [
  "Schema migration required — run the paper-trading migrations before enabling.",
  "before signals can appear",
  "The auto-paper schema is not deployed yet",
];

test("all three surfaces render the identical migration-required sentence", () => {
  const surfaces = [
    ["panel toggle reason", PANEL],
    ["dashboard empty state", DASHBOARD],
    ["signals empty state", SIGNALS],
  ] as const;
  for (const [label, source] of surfaces) {
    assert.ok(
      source.includes(CANONICAL_MIGRATION_COPY),
      `${label} must contain the canonical migration-required copy`,
    );
  }
});

test("no retired migration phrasing reappears in any of the three surfaces", () => {
  for (const [label, source] of [
    ["panel", PANEL],
    ["dashboard", DASHBOARD],
    ["signals", SIGNALS],
  ] as const) {
    for (const variant of RETIRED_VARIANTS) {
      assert.ok(
        !source.includes(variant),
        `${label} must not reintroduce retired copy: ${JSON.stringify(variant)}`,
      );
    }
  }
});
