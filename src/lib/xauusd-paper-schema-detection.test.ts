import assert from "node:assert/strict";
import test from "node:test";
import { PostgrestError } from "@supabase/supabase-js";
import { isMissingSchemaError } from "./xauusd-paper-schema-detection.ts";

// The exact response the live pre-deploy project returns (verified 2026-08-12
// with a REST probe): HTTP 404 with this body for paper_trading_profiles,
// scan_runs and paper_worker_health.
const LIVE_PGRST205 = {
  code: "PGRST205",
  details: null,
  hint: null,
  message: "Could not find the table 'public.paper_trading_profiles' in the schema cache",
};

test("detects the live PGRST205 shape (plain object, code not in message)", () => {
  assert.equal(isMissingSchemaError(LIVE_PGRST205), true);
});

test("detects a PostgrestError instance as supabase-js constructs it", () => {
  const error = new PostgrestError({
    message: "Could not find the table 'public.scan_runs' in the schema cache",
    details: "",
    hint: "",
    code: "PGRST205",
  });
  assert.equal(isMissingSchemaError(error), true);
});

test("detects every migration-artifact code", () => {
  for (const code of ["42P01", "PGRST205", "PGRST204", "PGRST200", "PGRST202"]) {
    assert.equal(
      isMissingSchemaError({ code, message: `schema cache miss (${code})` }),
      true,
      `${code} should be treated as a missing schema`,
    );
  }
});

test("message-only fallback catches the codes when re-wrapped in an Error", () => {
  assert.equal(isMissingSchemaError(new Error("42P01 relation does not exist")), true);
  assert.equal(isMissingSchemaError(new Error('PGRST205 "Could not find the table"')), true);
});

test("ignores non-schema errors", () => {
  assert.equal(isMissingSchemaError({ code: "42501", message: "RLS denied" }), false);
  assert.equal(isMissingSchemaError({ code: "PGRST116", message: "JSON object requested" }), false);
  assert.equal(isMissingSchemaError(new TypeError("fetch failed")), false);
  assert.equal(isMissingSchemaError(null), false);
  assert.equal(isMissingSchemaError(undefined), false);
  assert.equal(isMissingSchemaError("some string"), false);
});
