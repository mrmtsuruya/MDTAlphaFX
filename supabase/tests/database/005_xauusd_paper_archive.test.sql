-- pgTAP coverage for archive_xauusd_terminal_signals: only canonical terminal
-- signals older than 30 days gain archived_at, the matching trade is archived
-- too, both event ledgers are untouched, and a re-run is a no-op. Fixtures are
-- canonical worker rows (full provenance) with backdated created_at.
-- Run locally with `node tools/pgtap-run.mjs 005` (PGlite harness).

BEGIN;
SELECT plan(8);

INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-0000-0000-000000000006', 'archive@test.local');

-- --- Fixtures: two completed scan runs, two snapshots ------------------------
INSERT INTO public.scan_runs
  (user_id, scan_fingerprint, symbol, timeframe, candle_closed_at, scan_mode,
   engine_version, policy_version, status)
VALUES
  ('00000000-0000-0000-0000-000000000006', 'fp-arch-29', 'XAUUSD', 'M1',
   '2026-07-13T07:00:00Z', 'intraday', 'engine-v1', 'policy-v1', 'completed');
INSERT INTO public.scan_runs
  (user_id, scan_fingerprint, symbol, timeframe, candle_closed_at, scan_mode,
   engine_version, policy_version, status)
VALUES
  ('00000000-0000-0000-0000-000000000006', 'fp-arch-31', 'XAUUSD', 'M1',
   '2026-07-11T07:00:00Z', 'intraday', 'engine-v1', 'policy-v1', 'completed');

INSERT INTO public.market_snapshots
  (provider, instrument, timeframe, candle_closed_at, bid, ask, provider_time,
   received_at, candles, content_hash, quality_result)
VALUES
  ('OANDA_V20_PRACTICE', 'XAU_USD', 'M1', '2026-07-13T07:00:00Z',
   3400.1, 3400.3, '2026-07-13T07:00:10Z', '2026-07-13T07:00:11Z',
   '[]'::jsonb, 'h-arch-29', '{}'::jsonb);
INSERT INTO public.market_snapshots
  (provider, instrument, timeframe, candle_closed_at, bid, ask, provider_time,
   received_at, candles, content_hash, quality_result)
VALUES
  ('OANDA_V20_PRACTICE', 'XAU_USD', 'M1', '2026-07-11T07:00:00Z',
   3400.1, 3400.3, '2026-07-11T07:00:10Z', '2026-07-11T07:00:11Z',
   '[]'::jsonb, 'h-arch-31', '{}'::jsonb);

-- --- Two canonical signals: 29 and 31 days before the fixed p_now ------------
INSERT INTO public.signals
  (user_id, pair, direction, mode, timeframe, entry, stop_loss, take_profit_1,
   take_profit_2, atr, confluence, contributing_strategies, status, rationale,
   news_context, expires_at, scan_run_id, market_snapshot_id, engine_version,
   policy_version, execution_policy_version, scan_fingerprint, generated_by,
   created_at)
SELECT
  '00000000-0000-0000-0000-000000000006', 'XAUUSD', 'long', 'intraday', 'M1',
  3400, 3390, 3412.5, 3420, 3.2, 70, '{ema_trend}', 'fresh', '29-day fixture',
  '[]'::jsonb, '2026-08-11T08:00:00Z', sr.id, ms.id,
  'engine-v1', 'policy-v1', 'b_single_v1', 'fp-arch-29', 'xauusd_paper_worker',
  '2026-07-13T07:00:00Z'
FROM public.scan_runs sr
JOIN public.market_snapshots ms ON ms.content_hash = 'h-arch-29'
WHERE sr.scan_fingerprint = 'fp-arch-29';

INSERT INTO public.signals
  (user_id, pair, direction, mode, timeframe, entry, stop_loss, take_profit_1,
   take_profit_2, atr, confluence, contributing_strategies, status, rationale,
   news_context, expires_at, scan_run_id, market_snapshot_id, engine_version,
   policy_version, execution_policy_version, scan_fingerprint, generated_by,
   created_at)
SELECT
  '00000000-0000-0000-0000-000000000006', 'XAUUSD', 'long', 'intraday', 'M1',
  3400, 3390, 3412.5, 3420, 3.2, 70, '{ema_trend}', 'fresh', '31-day fixture',
  '[]'::jsonb, '2026-08-11T08:00:00Z', sr.id, ms.id,
  'engine-v1', 'policy-v1', 'b_single_v1', 'fp-arch-31', 'xauusd_paper_worker',
  '2026-07-11T07:00:00Z'
FROM public.scan_runs sr
JOIN public.market_snapshots ms ON ms.content_hash = 'h-arch-31'
WHERE sr.scan_fingerprint = 'fp-arch-31';

-- --- Terminal paper trades for both signals ----------------------------------
INSERT INTO public.paper_trades
  (signal_id, user_id, symbol, lot_size, direction, timeframe, state,
   state_version, planned_entry, stop_loss, take_profit_1, take_profit_2,
   expires_at, execution_policy_version, instrument_spec_version)
SELECT s.id, '00000000-0000-0000-0000-000000000006', 'XAUUSD', 0.01, 'long',
       'M1', 'closed_stop', 1, 3400, 3390, 3412.5, 3420,
       '2026-08-11T08:00:00Z', 'b_single_v1', 'xauusd_0_01_lot_v1'
FROM public.signals s WHERE s.scan_fingerprint = 'fp-arch-29';
INSERT INTO public.paper_trades
  (signal_id, user_id, symbol, lot_size, direction, timeframe, state,
   state_version, planned_entry, stop_loss, take_profit_1, take_profit_2,
   expires_at, execution_policy_version, instrument_spec_version)
SELECT s.id, '00000000-0000-0000-0000-000000000006', 'XAUUSD', 0.01, 'long',
       'M1', 'closed_stop', 1, 3400, 3390, 3412.5, 3420,
       '2026-08-11T08:00:00Z', 'b_single_v1', 'xauusd_0_01_lot_v1'
FROM public.signals s WHERE s.scan_fingerprint = 'fp-arch-31';

-- --- One audit row per ledger, to prove the archive never touches them ------
INSERT INTO public.paper_trade_events
  (paper_trade_id, user_id, sequence_no, event_key, event_type, before_state,
   after_state)
SELECT pt.id, '00000000-0000-0000-0000-000000000006', 1,
       'trade_created', 'trade_created', NULL, 'closed_stop'
FROM public.paper_trades pt
JOIN public.signals s ON s.id = pt.signal_id
WHERE s.scan_fingerprint = 'fp-arch-31';
INSERT INTO public.signal_events (signal_id, user_id, event, detail)
SELECT id, '00000000-0000-0000-0000-000000000006', 'created', '{}'::jsonb
FROM public.signals WHERE scan_fingerprint = 'fp-arch-31';

-- --- Run the archive at a fixed p_now ----------------------------------------
SELECT is(
  public.archive_xauusd_terminal_signals('2026-08-11T00:00:00Z'::timestamptz),
  1,
  'exactly one terminal signal older than 30 days is archived'
);
SELECT is(
  (SELECT count(*)::int FROM public.signals
   WHERE scan_fingerprint = 'fp-arch-31' AND archived_at IS NOT NULL),
  1,
  '31-day signal gained archived_at'
);
SELECT is(
  (SELECT count(*)::int FROM public.signals
   WHERE scan_fingerprint = 'fp-arch-29' AND archived_at IS NULL),
  1,
  '29-day signal keeps archived_at NULL'
);
SELECT is(
  (SELECT archived_at::date::text FROM public.signals
   WHERE scan_fingerprint = 'fp-arch-31'),
  '2026-08-11',
  'archived_at equals the fixed p_now'
);
SELECT is(
  (SELECT count(*)::int FROM public.paper_trades pt
   JOIN public.signals s ON s.id = pt.signal_id
   WHERE s.scan_fingerprint = 'fp-arch-31' AND pt.archived_at IS NOT NULL),
  1,
  'terminal trade of the archived signal is archived too'
);
SELECT is(
  (SELECT count(*)::int FROM public.paper_trade_events),
  1,
  'paper_trade_events ledger is unchanged'
);
SELECT is(
  (SELECT count(*)::int FROM public.signal_events),
  1,
  'signal_events ledger is unchanged'
);
SELECT is(
  public.archive_xauusd_terminal_signals('2026-08-11T00:00:00Z'::timestamptz),
  0,
  're-running the archive is a no-op'
);

SELECT * FROM finish();
ROLLBACK;
