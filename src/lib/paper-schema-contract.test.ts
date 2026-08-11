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
    assert.match(
      fn,
      /SECURITY DEFINER/i,
      `${name} must be SECURITY DEFINER`,
    );
    assert.match(
      fn,
      /SET search_path = public/i,
      `${name} must pin search_path to public`,
    );
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
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated`, "is"),
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
  const authenticatedGrants = workerRpcSql.match(/GRANT EXECUTE ON FUNCTION [^;]*TO authenticated/gi) ?? [];
  assert.equal(authenticatedGrants.length, 1);
});

test("archive RPC soft-archives only and contains no DELETE", () => {
  const archive = workerRpcSql.split(/CREATE OR REPLACE FUNCTION public\.archive_xauusd_terminal_signals/)[1];
  assert.ok(archive);
  assert.doesNotMatch(archive, /\bDELETE\b/i);
  assert.match(archive, /interval '30 days'/i);
  assert.match(archive, /archived_at = p_now/i);
  assert.match(archive, /RETURNS integer/i);
});
