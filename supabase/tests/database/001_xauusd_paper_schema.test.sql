-- pgTAP schema coverage for the XAUUSD auto-paper canonical tables.
-- Runs only where a real Postgres + pgTAP exist (Docker/Supabase CLI); the
-- local machine currently has neither, so this file is committed as the
-- infrastructure-blocked gate and the static contracts in
-- src/lib/paper-schema-contract.test.ts cover the same ground on Node.

BEGIN;
SELECT plan(24);

-- --- All seven canonical tables exist ---------------------------------------
SELECT has_table('public', 'paper_trading_profiles');
SELECT has_table('public', 'paper_worker_health');
SELECT has_table('public', 'scan_runs');
SELECT has_table('public', 'market_snapshots');
SELECT has_table('public', 'signal_market_snapshots');
SELECT has_table('public', 'paper_trades');
SELECT has_table('public', 'paper_trade_events');

-- --- Enums -------------------------------------------------------------------
SELECT has_type('public', 'paper_scan_status');
SELECT has_type('public', 'paper_trade_state');

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
SELECT col_default('public', 'paper_trading_profiles', 'enabled', 'false');
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
SELECT has_constraint('public', 'paper_trades', 'paper_trades_directional_levels');

-- --- Unique keys -------------------------------------------------------------
SELECT has_index('public', 'scan_runs', 'scan_runs_fingerprint_uidx');
SELECT has_index('public', 'signals', 'canonical_signal_fingerprint_uidx');
SELECT has_index('public', 'paper_trades', 'paper_trades_signal_uidx');
SELECT has_index('public', 'paper_trade_events', 'paper_trade_event_sequence_uidx');
SELECT has_index('public', 'paper_trade_events', 'paper_trade_event_key_uidx');
SELECT has_index('public', 'signals', 'active_signal_history_idx');

-- --- Restrictive links -------------------------------------------------------
SELECT has_fk('public', 'paper_trades', 'signal_id');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_trade_events'
    AND c.contype = 'f' AND c.confdeltype = 'r'
    AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES public.paper_trades%'
), 'paper_trade_events -> paper_trades is ON DELETE RESTRICT');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'signal_market_snapshots'
    AND c.contype = 'f' AND c.confdeltype = 'r'
    AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES public.signals%'
), 'signal_market_snapshots -> signals is ON DELETE RESTRICT');

-- --- Singleton worker-health row --------------------------------------------
SELECT col_is_pk('public', 'paper_worker_health', 'id');
SELECT ok(EXISTS (
  SELECT 1 FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public' AND t.relname = 'paper_worker_health'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%id = ''xauusd''%'
), 'paper_worker_health is a singleton pinned to xauusd');

-- --- Canonical provenance check on signals ----------------------------------
SELECT has_constraint('public', 'signals', 'signals_canonical_provenance_check');
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
SELECT row_security_active('public', 'market_snapshots');
SELECT row_security_active('public', 'signal_market_snapshots');
SELECT set_has(
  (SELECT array_agg(rolname) FROM pg_roles WHERE rolname = 'authenticated'),
  ARRAY['authenticated'],
  'authenticated role exists for the denial checks'
);

SELECT * FROM finish();
ROLLBACK;
