// Static contract over src/lib/xauusd-paper.functions.ts: every authenticated
// server function must route missing-schema errors (PGRST205/PGRST200/PGRST204/
// PGRST202/42P01) through isMissingSchemaError — returning a disabled profile,
// a `migration_required` health, or a "migration_required" error — BEFORE any
// raw PostgREST message can be thrown. This pins the wiring that makes the
// pre-deploy panel show MIGRATION_REQUIRED instead of crashing or leaking
// PostgREST text ("Could not find the table 'public.X' in the schema cache").

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("./xauusd-paper.functions.ts", import.meta.url), "utf8");

// Every authenticated server function in the file. Adding a new one without
// updating this list fails the count cross-check in "contract list covers all".
const AUTHENTICATED_FUNCTIONS = [
  "getXauusdPaperProfile",
  "setXauusdPaperEnabled",
  "getXauusdPaperHealth",
  "listXauusdPaperSignals",
  "getXauusdPaperSignalDetail",
  "getXauusdPaperPerformance",
  "getXauusdShadowLearning",
  "getXauusdPaperAccount",
];

function functionBlock(name: string): string {
  const start = SOURCE.indexOf(`export const ${name} = createServerFn`);
  assert.notEqual(start, -1, `${name} must be an exported server function`);
  const next = SOURCE.indexOf("\nexport ", start + 1);
  return SOURCE.slice(start, next === -1 ? SOURCE.length : next);
}

test("every exported server function is authenticated", () => {
  for (const name of AUTHENTICATED_FUNCTIONS) {
    const block = functionBlock(name);
    assert.match(
      block,
      /\.middleware\(\[requireSupabaseAuth\]\)/,
      `${name} must require the user's bearer token`,
    );
  }
});

test("every authenticated server function routes missing-schema errors through isMissingSchemaError", () => {
  for (const name of AUTHENTICATED_FUNCTIONS) {
    const block = functionBlock(name);
    const guard = block.indexOf("isMissingSchemaError(");
    const rawIndexes = [
      block.indexOf("throw new Error(error.message)"),
      block.indexOf("throw new Error(result.message)"),
    ].filter((index) => index !== -1);
    const rawThrow = rawIndexes.length ? Math.min(...rawIndexes) : -1;

    assert.ok(guard !== -1, `${name} must guard schema errors with isMissingSchemaError`);
    assert.ok(
      rawThrow === -1 || guard < rawThrow,
      `${name} must not throw raw PostgREST text before the schema guard`,
    );
  }
});

test("contract list covers every authenticated server function in the file", () => {
  const middlewareCount = (SOURCE.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? []).length;
  const guardCount = (SOURCE.match(/isMissingSchemaError\(/g) ?? []).length;
  assert.equal(
    middlewareCount,
    AUTHENTICATED_FUNCTIONS.length,
    "a new authenticated server function exists that is not in AUTHENTICATED_FUNCTIONS",
  );
  assert.equal(
    guardCount,
    AUTHENTICATED_FUNCTIONS.length,
    "every authenticated server function needs exactly one isMissingSchemaError guard",
  );
});

test("schema-missing branches never surface raw PostgREST text", () => {
  // Profile: the schema-missing branch returns the disabled profile.
  assert.match(
    functionBlock("getXauusdPaperProfile"),
    /isMissingSchemaError\(error\)[\s\S]*?return DISABLED_PROFILE/,
    "profile must return the disabled profile on a missing schema",
  );
  // Health: the schema-missing branch returns the migration_required status.
  assert.match(
    functionBlock("getXauusdPaperHealth"),
    /status:\s*"migration_required"/,
    "health must return migration_required on a missing schema",
  );
  // The remaining functions throw the canonical "migration_required" marker.
  for (const name of [
    "setXauusdPaperEnabled",
    "listXauusdPaperSignals",
    "getXauusdPaperPerformance",
    "getXauusdShadowLearning",
    "getXauusdPaperAccount",
  ]) {
    assert.match(
      functionBlock(name),
      /isMissingSchemaError\(error\)[\s\S]*?throw new Error\("migration_required"\)/,
      `${name} must throw the canonical "migration_required" marker on a missing schema`,
    );
  }
});
