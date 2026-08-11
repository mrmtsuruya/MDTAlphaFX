// Executable static contract over the forward-only Supabase migrations.
//
// The local machine has no Docker or Supabase CLI, so the migrations cannot be
// executed here; this test reads the committed SQL and pins the parts the
// worker and the RLS cutover depend on, so a wrong rename or a missing table
// fails fast instead of at deploy time. pgTAP coverage of the same contracts
// lives in supabase/tests/database/ and runs where a real Postgres exists.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const EXPAND_MIGRATION = "20260811010000_xauusd_paper_expand.sql";
const CATALOG_MIGRATION = "20260811010100_xauusd_strategy_catalog_backfill.sql";
const WORKER_RPC_MIGRATION = "20260811010200_xauusd_paper_worker_rpcs.sql";
const CUTOVER_MIGRATION = "20260811020000_xauusd_canonical_rls_cutover.sql";
const CRON_MIGRATION = "20260811030000_xauusd_paper_cron.sql";

const expandSql = readFileSync(
  new URL(`../../supabase/migrations/${EXPAND_MIGRATION}`, import.meta.url),
  "utf8",
);
const catalogSql = readFileSync(
  new URL(`../../supabase/migrations/${CATALOG_MIGRATION}`, import.meta.url),
  "utf8",
);
const workerRpcSql = readFileSync(
  new URL(`../../supabase/migrations/${WORKER_RPC_MIGRATION}`, import.meta.url),
  "utf8",
);
const cutoverSql = readFileSync(
  new URL(`../../supabase/migrations/${CUTOVER_MIGRATION}`, import.meta.url),
  "utf8",
);
const cronSql = readFileSync(
  new URL(`../../supabase/migrations/${CRON_MIGRATION}`, import.meta.url),
  "utf8",
);

test("expansion migration creates all seven canonical tables", () => {
  for (const table of [
    "paper_trading_profiles",
    "paper_worker_health",
    "scan_runs",
    "market_snapshots",
    "signal_market_snapshots",
    "paper_trades",
    "paper_trade_events",
  ]) {
    assert.match(expandSql, new RegExp(`CREATE TABLE public\\.${table}`, "i"));
  }
});

test("expansion migration pins fixed symbol, lot size, and restrictive links", () => {
  assert.match(expandSql, /CHECK \(symbol = 'XAUUSD'\)/i);
  assert.match(expandSql, /CHECK \(lot_size = 0\.01\)/i);
  assert.match(expandSql, /CHECK \(timezone = 'Asia\/Manila'\)/i);
  assert.match(expandSql, /CHECK \(strategy_scope = 'all_registered'\)/i);
  assert.match(expandSql, /CHECK \(execution_policy_version = 'b_single_v1'\)/i);
  assert.match(expandSql, /CHECK \(instrument_spec_version = 'xauusd_0_01_lot_v1'\)/i);
  assert.match(expandSql, /REFERENCES public\.paper_trades\(id\) ON DELETE RESTRICT/i);
});

test("expansion migration creates the required unique indexes and active-history index", () => {
  for (const index of [
    "scan_runs_fingerprint_uidx",
    "canonical_signal_fingerprint_uidx",
    "paper_trades_signal_uidx",
    "paper_trade_event_sequence_uidx",
    "paper_trade_event_key_uidx",
    "active_signal_history_idx",
  ]) {
    assert.match(expandSql, new RegExp(index, "i"));
  }
  assert.match(
    expandSql,
    /CREATE UNIQUE INDEX scan_runs_fingerprint_uidx\s+ON public\.scan_runs \(scan_fingerprint\)/is,
  );
  assert.match(
    expandSql,
    /CREATE UNIQUE INDEX canonical_signal_fingerprint_uidx\s+ON public\.signals \(scan_fingerprint\)\s+WHERE scan_fingerprint IS NOT NULL/is,
  );
});

test("expansion migration adds archived_at and provenance to signals", () => {
  assert.match(expandSql, /ADD COLUMN archived_at timestamptz/i);
  assert.match(expandSql, /ADD COLUMN archive_reason text/i);
  assert.match(expandSql, /ADD COLUMN generated_by text NOT NULL DEFAULT 'legacy_browser'/i);
  assert.match(expandSql, /ADD COLUMN scan_fingerprint text/i);
  assert.match(expandSql, /ADD COLUMN scan_run_id uuid/i);
  assert.match(expandSql, /ADD COLUMN market_snapshot_id uuid/i);
  assert.match(expandSql, /signals_canonical_provenance_check/i);
});

test("expansion migration grants no authenticated access to raw market snapshots", () => {
  // The worker-shared snapshot tables must stay worker-internal; clients only
  // ever read signal rows. Absence of a grant is the contract.
  assert.doesNotMatch(expandSql, /GRANT SELECT ON public\.market_snapshots TO authenticated/i);
  assert.doesNotMatch(
    expandSql,
    /GRANT SELECT ON public\.signal_market_snapshots TO authenticated/i,
  );
});

test("migrations are forward-only: no destructive statements", () => {
  assert.doesNotMatch(expandSql, /\bDROP TABLE\b/i);
  assert.doesNotMatch(expandSql, /DELETE FROM public\.signals/i);
  assert.doesNotMatch(expandSql, /\bDROP COLUMN\b/i);
  // New foreign keys to signals must be RESTRICT, never a new cascade that
  // could silently delete canonical signal history.
  assert.doesNotMatch(expandSql, /REFERENCES public\.signals\(id\) ON DELETE CASCADE/i);
  assert.doesNotMatch(catalogSql, /\bDROP TABLE\b/i);
  assert.doesNotMatch(catalogSql, /DELETE FROM public\.signals/i);
});

test("catalog backfill inserts all five missing engine strategies", () => {
  for (const id of [
    "rsi_divergence",
    "macd_divergence",
    "climax_exhaustion",
    "stop_run_reversal",
    "failed_breakout",
  ]) {
    assert.match(catalogSql, new RegExp(id));
  }
  assert.match(catalogSql, /ON CONFLICT \(id\) DO UPDATE/i);
  assert.match(catalogSql, /strategy_settings \(user_id, strategy_id, enabled\)/i);
  assert.match(catalogSql, /NOT EXISTS/i);
});

test("worker RPC migration defines every required RPC", () => {
  for (const name of [
    "set_xauusd_paper_enabled",
    "worker_record_xauusd_health",
    "worker_claim_xauusd_scan",
    "worker_commit_xauusd_scan",
    "worker_fail_xauusd_scan",
    "worker_apply_paper_transition",
    "archive_xauusd_terminal_signals",
  ]) {
    assert.match(workerRpcSql, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`, "i"));
  }
});

test("every worker RPC is SECURITY DEFINER with a pinned search_path", () => {
  const functions = workerRpcSql.split(/CREATE OR REPLACE FUNCTION/).slice(1);
  assert.ok(functions.length >= 7, `expected >= 7 functions, got ${functions.length}`);
  for (const fn of functions) {
    const name = fn.match(/public\.(\w+)\(/)?.[1];
    assert.ok(name, "every function has a name");
    assert.match(fn, /SECURITY DEFINER/i, `${name} must be SECURITY DEFINER`);
    assert.match(fn, /SET search_path = public/i, `${name} must pin search_path to public`);
  }
});

test("worker RPCs are revoked from PUBLIC/anon/authenticated", () => {
  const workerOnly = [
    "worker_record_xauusd_health",
    "worker_claim_xauusd_scan",
    "worker_commit_xauusd_scan",
    "worker_fail_xauusd_scan",
    "worker_apply_paper_transition",
    "archive_xauusd_terminal_signals",
  ];
  for (const name of workerOnly) {
    assert.match(
      workerRpcSql,
      new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated`,
        "is",
      ),
      `${name} must be revoked from PUBLIC, anon and authenticated`,
    );
    // And granted to service_role only.
    assert.match(
      workerRpcSql,
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role`, "is"),
      `${name} must be granted to service_role`,
    );
  }
});

test("only the profile toggle is granted to authenticated", () => {
  assert.match(
    workerRpcSql,
    /GRANT EXECUTE ON FUNCTION public\.set_xauusd_paper_enabled\(boolean\) TO authenticated/i,
  );
  // No other authenticated grant may exist in the RPC migration.
  const authenticatedGrants =
    workerRpcSql.match(/GRANT EXECUTE ON FUNCTION [^;]*TO authenticated/gi) ?? [];
  assert.equal(authenticatedGrants.length, 1);
});

test("cutover revokes every authenticated write on signals", () => {
  for (const op of ["INSERT", "UPDATE", "DELETE"]) {
    assert.match(
      cutoverSql,
      new RegExp(`REVOKE ${op} ON public\\.signals FROM authenticated`, "is"),
      `cutover must revoke authenticated ${op} on signals`,
    );
  }
  // SELECT must survive for the read-only UI (never revoked by the cutover).
  assert.doesNotMatch(cutoverSql, /REVOKE SELECT ON public\.signals FROM authenticated/i);
});

test("cutover revokes authenticated INSERT on signal_events", () => {
  assert.match(cutoverSql, /REVOKE INSERT ON public\.signal_events FROM authenticated/i);
  assert.doesNotMatch(cutoverSql, /REVOKE SELECT ON public\.signal_events FROM authenticated/i);
});

test("cutover replaces FOR ALL policies with own-row SELECT policies", () => {
  assert.match(cutoverSql, /DROP POLICY IF EXISTS "own signals" ON public\.signals/i);
  assert.match(cutoverSql, /DROP POLICY IF EXISTS "own signal events" ON public\.signal_events/i);
  assert.match(
    cutoverSql,
    /CREATE POLICY "own signals select" ON public\.signals\s+FOR SELECT TO authenticated USING \(auth\.uid\(\) = user_id\)/is,
  );
  assert.match(
    cutoverSql,
    /CREATE POLICY "own signal events select" ON public\.signal_events\s+FOR SELECT TO authenticated USING \(auth\.uid\(\) = user_id\)/is,
  );
});

test("cutover is forward-only: no hard deletes of legacy rows", () => {
  assert.doesNotMatch(cutoverSql, /\bDROP TABLE\b/i);
  assert.doesNotMatch(cutoverSql, /DELETE FROM public\.signals/i);
  assert.doesNotMatch(cutoverSql, /DELETE FROM public\.signal_events/i);
  assert.doesNotMatch(cutoverSql, /\bDROP COLUMN\b/i);
});

test("cron migration schedules archive and minute worker with exact names", () => {
  assert.match(cronSql, /cron\.schedule\s*\(\s*'xauusd-paper-archive'\s*,\s*'5 16 \* \* \*'/is);
  assert.match(cronSql, /cron\.schedule\s*\(\s*'xauusd-paper-minute'\s*,\s*'\* \* \* \* \*'/is);
  assert.match(cronSql, /archive_xauusd_terminal_signals\(now\(\)\)/i);
});

test("configure_xauusd_paper_minute_job is a service-only SECURITY DEFINER gate", () => {
  assert.match(cronSql, /CREATE OR REPLACE FUNCTION public\.configure_xauusd_paper_minute_job\(/i);
  assert.match(cronSql, /SECURITY DEFINER/i);
  assert.match(cronSql, /SET search_path = public/i);
  assert.match(
    cronSql,
    /REVOKE ALL ON FUNCTION public\.configure_xauusd_paper_minute_job\([^)]*\) FROM PUBLIC, anon, authenticated/is,
  );
  assert.match(
    cronSql,
    /GRANT EXECUTE ON FUNCTION public\.configure_xauusd_paper_minute_job\([^)]*\) TO service_role/is,
  );
});

test("minute job refuses to schedule unless all three Vault secrets exist", () => {
  assert.match(cronSql, /vault\.decrypted_secrets/i);
  for (const secret of ["project_url", "publishable_key", "xauusd_worker_cron_secret"]) {
    assert.match(cronSql, new RegExp(secret));
  }
  // The pg_net POST must carry the worker secret plus apikey, and an empty body.
  assert.match(cronSql, /net\.http_post/i);
  assert.match(cronSql, /x-worker-secret/i);
  assert.match(cronSql, /apikey/i);
  assert.match(cronSql, /''\{\}''::jsonb/i);
});

test("cron migration never auto-enables a profile or calls the configurator", () => {
  assert.doesNotMatch(cronSql, /set_xauusd_paper_enabled/i);
  // The migration defines the gate but must not invoke it (activation is a
  // deliberate post-deploy step), and it must not touch profiles.
  assert.doesNotMatch(cronSql, /paper_trading_profiles\s*\(/i);
  assert.doesNotMatch(
    cronSql,
    /(?:perform|select)\s+public\.configure_xauusd_paper_minute_job\s*\(/i,
  );
});

test("archive RPC soft-archives only and contains no DELETE", () => {
  const archive = workerRpcSql.split(
    /CREATE OR REPLACE FUNCTION public\.archive_xauusd_terminal_signals/,
  )[1];
  assert.ok(archive);
  assert.doesNotMatch(archive, /\bDELETE\b/i);
  assert.match(archive, /interval '30 days'/i);
  assert.match(archive, /archived_at = p_now/i);
  assert.match(archive, /RETURNS integer/i);
});
