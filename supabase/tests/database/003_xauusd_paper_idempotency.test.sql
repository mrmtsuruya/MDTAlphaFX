-- pgTAP idempotency coverage for the worker RPCs: a repeated claim or commit
-- must never produce a second scan run, signal, trade, or event.
-- Run locally with `node tools/pgtap-run.mjs 003` (PGlite harness) or via
-- `supabase test db` (static contracts live in src/lib/paper-schema-contract.test.ts).

BEGIN;
SELECT plan(7);

-- Fixtures: one auth user and one claimed scan run.
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'paper-idem@test.local');

SELECT lives_ok($$
  SELECT public.worker_claim_xauusd_scan(
    '00000000-0000-0000-0000-000000000001'::uuid,
    'fp-idem', 'XAUUSD', 'M1', '2026-08-11T07:42:00Z',
    'intraday', 'engine-v1', 'policy-v1', '2026-08-11T07:45:00Z')
$$, 'first claim of a fresh fingerprint succeeds');

SELECT results_eq($$
  SELECT claimed FROM public.worker_claim_xauusd_scan(
    '00000000-0000-0000-0000-000000000001'::uuid,
    'fp-idem', 'XAUUSD', 'M1', '2026-08-11T07:42:00Z',
    'intraday', 'engine-v1', 'policy-v1', '2026-08-11T07:45:00Z')
$$, ARRAY[false::boolean], 'second claim of the same fingerprint is not claimed');

SELECT is(
  (SELECT count(*)::int FROM public.scan_runs WHERE scan_fingerprint = 'fp-idem'),
  1,
  'exactly one scan run per fingerprint'
);

-- Commit the same fingerprint twice: the second must be a no-op.
SELECT lives_ok($$
  SELECT public.worker_commit_xauusd_scan(
    (SELECT id FROM public.scan_runs WHERE scan_fingerprint = 'fp-idem'),
    '00000000-0000-0000-0000-000000000001'::uuid,
    'fp-idem',
    '[{"content_hash":"h-idem","role":"entry","provider":"OANDA_V20_PRACTICE","instrument":"XAU_USD","timeframe":"M1","candle_closed_at":"2026-08-11T07:42:00Z","bid":3400.1,"ask":3400.3,"provider_time":"2026-08-11T07:42:10Z","received_at":"2026-08-11T07:42:11Z","candles":[],"quality_result":{}}]'::jsonb,
    '{"mode":"intraday","timeframe":"M1","direction":"long","entry":3400,"stop_loss":3390,"take_profit_1":3412.5,"take_profit_2":3420,"atr":3.2,"confluence":70,"contributing_strategies":["ema_trend"],"rationale":"idempotency fixture","expires_at":"2026-08-11T08:00:00Z"}'::jsonb,
    '{"expires_at":"2026-08-11T08:00:00Z"}'::jsonb,
    'engine-v1', 'policy-v1', 'b_single_v1', 'xauusd_0_01_lot_v1', '{}'::jsonb, '{}'::jsonb)
$$, 'first commit of a fingerprint succeeds');

SELECT results_eq($$
  SELECT created FROM public.worker_commit_xauusd_scan(
    (SELECT id FROM public.scan_runs WHERE scan_fingerprint = 'fp-idem'),
    '00000000-0000-0000-0000-000000000001'::uuid,
    'fp-idem',
    '[{"content_hash":"h-idem","role":"entry","provider":"OANDA_V20_PRACTICE","instrument":"XAU_USD","timeframe":"M1","candle_closed_at":"2026-08-11T07:42:00Z","bid":3400.1,"ask":3400.3,"provider_time":"2026-08-11T07:42:10Z","received_at":"2026-08-11T07:42:11Z","candles":[],"quality_result":{}}]'::jsonb,
    '{"mode":"intraday","timeframe":"M1","direction":"long","entry":3400,"stop_loss":3390,"take_profit_1":3412.5,"take_profit_2":3420,"atr":3.2,"confluence":70,"contributing_strategies":["ema_trend"],"rationale":"idempotency fixture","expires_at":"2026-08-11T08:00:00Z"}'::jsonb,
    '{"expires_at":"2026-08-11T08:00:00Z"}'::jsonb,
    'engine-v1', 'policy-v1', 'b_single_v1', 'xauusd_0_01_lot_v1', '{}'::jsonb, '{}'::jsonb)
$$, ARRAY[false::boolean], 'duplicate commit is not re-created');

SELECT is(
  (SELECT count(*)::int FROM public.signals WHERE scan_fingerprint = 'fp-idem'),
  1,
  'exactly one signal per fingerprint'
);

SELECT is(
  (SELECT count(*)::int
   FROM public.paper_trade_events pe
   JOIN public.paper_trades pt ON pt.id = pe.paper_trade_id
   JOIN public.signals s ON s.id = pt.signal_id
   WHERE s.scan_fingerprint = 'fp-idem'),
  1,
  'exactly one trade_created event per trade'
);

SELECT * FROM finish();
ROLLBACK;
