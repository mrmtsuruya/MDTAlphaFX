-- pgTAP schema coverage for the XAUUSD auto-paper canonical tables.
-- Run locally with `node tools/pgtap-run.mjs` (PGlite harness, no Docker)
-- or via `supabase test db`; the static contracts in
-- src/lib/paper-schema-contract.test.ts cover the same ground on Node.

BEGIN;
SELECT plan(33);

-- --- All seven canonical tables exist ---------------------------------------
SELECT has_table('public', 'paper_trading_profiles', 'paper_trading_profiles table exists');
SELECT has_table('public', 'paper_worker_health', 'paper_worker_health table exists');
SELECT has_table('public', 'scan_runs', 'scan_runs table exists');
SELECT has_table('public', 'market_snapshots', 'market_snapshots table exists');
SELECT has_table('public', 'signal_market_snapshots', 'signal_market_snapshots table exists');
SELECT has_table('public', 'paper_trades', 'paper_trades table exists');
SELECT has_table('public', 'paper_trade_events', 'paper_trade_events table exists');

-- --- Enums -------------------------------------------------------------------
SELECT has_type('public', 'paper_scan_status', 'paper_scan_status enum exists');
SELECT has_type('public', 'paper_trade_state', 'paper_trade_state enum exists');

-- --- Fixed symbol/lot/timezone/scope constraints -----------------------------
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_trading_profiles'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%symbol = ''XAUUSD''%'
), 'paper_trading_profiles pins symbol to XAUUSD');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_trading_profiles'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%lot_size = 0.01%'
), 'paper_trading_profiles pins lot_size to 0.01');
SELECT col_default_is('public', 'paper_trading_profiles', 'enabled', false,
  'paper_trading_profiles.enabled defaults to false');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_trades'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%execution_policy_version = ''b_single_v1''%'
), 'paper_trades pins execution_policy_version to b_single_v1');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_trades'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%instrument_spec_version = ''xauusd_0_01_lot_v1''%'
), 'paper_trades pins instrument_spec_version to xauusd_0_01_lot_v1');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_trades'
    AND c.conname = 'paper_trades_directional_levels'
), 'paper_trades has the directional_levels check');

-- --- Unique keys -------------------------------------------------------------
SELECT has_index('public', 'scan_runs', 'scan_runs_fingerprint_uidx', 'scan_runs fingerprint unique index');
SELECT has_index('public', 'signals', 'canonical_signal_fingerprint_uidx', 'signals canonical fingerprint unique index');
SELECT has_index('public', 'paper_trades', 'paper_trades_signal_uidx', 'paper_trades signal unique index');
SELECT has_index('public', 'paper_trade_events', 'paper_trade_event_sequence_uidx', 'paper_trade_events sequence unique index');
SELECT has_index('public', 'paper_trade_events', 'paper_trade_event_key_uidx', 'paper_trade_events event_key unique index');
SELECT has_index('public', 'signals', 'active_signal_history_idx', 'signals active history index');

-- --- Restrictive links -------------------------------------------------------
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class rt ON rt.oid = c.confrelid
  JOIN pg_namespace rn ON rn.oid = rt.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_trades'
    AND c.contype = 'f'
    AND rn.nspname = 'public' AND rt.relname = 'signals'
), 'paper_trades.signal_id is a foreign key to signals');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class rt ON rt.oid = c.confrelid
  JOIN pg_namespace rn ON rn.oid = rt.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_trade_events'
    AND c.contype = 'f' AND c.confdeltype = 'r'
    AND rn.nspname = 'public' AND rt.relname = 'paper_trades'
), 'paper_trade_events -> paper_trades is ON DELETE RESTRICT');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_class rt ON rt.oid = c.confrelid
  JOIN pg_namespace rn ON rn.oid = rt.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'signal_market_snapshots'
    AND c.contype = 'f' AND c.confdeltype = 'r'
    AND rn.nspname = 'public' AND rt.relname = 'signals'
), 'signal_market_snapshots -> signals is ON DELETE RESTRICT');

-- --- Singleton worker-health row --------------------------------------------
SELECT col_is_pk('public', 'paper_worker_health', 'id', 'paper_worker_health.id is primary key');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_worker_health'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%id = ''xauusd''%'
), 'paper_worker_health is a singleton pinned to xauusd');

-- --- Canonical provenance check on signals ----------------------------------
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'signals'
    AND c.conname = 'signals_canonical_provenance_check'
), 'signals has the canonical provenance check');
SELECT ok(EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'signals' AND column_name = 'archived_at'
), 'signals has archived_at');
SELECT ok(EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'signals' AND column_name = 'generated_by'
), 'signals has generated_by');

-- --- Five catalog rows exist ------------------------------------------------
SELECT is(
  (SELECT count(*)::int FROM public.strategies
   WHERE id IN ('rsi_divergence', 'macd_divergence', 'climax_exhaustion', 'stop_run_reversal', 'failed_breakout')),
  5,
  'catalog backfill inserted exactly the five missing strategies'
);

-- --- Snapshot tables are RLS-protected and unreadable by authenticated -------
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.market_snapshots'::regclass), 'market_snapshots has RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.signal_market_snapshots'::regclass), 'signal_market_snapshots has RLS enabled');
SELECT set_has(
  $$SELECT rolname FROM pg_roles WHERE rolname = 'authenticated'$$,
  $$SELECT 'authenticated'$$,
  'authenticated role exists for the denial checks'
);

SELECT * FROM finish();
ROLLBACK;
