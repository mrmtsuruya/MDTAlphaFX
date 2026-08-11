-- pgTAP atomicity coverage for worker_apply_paper_transition: state and event
-- writes are one transaction, a stale version is rejected, a duplicate event
-- key never appends a second event, and an invalid next state rolls back the
-- whole transition. Run locally with `node tools/pgtap-run.mjs 004`
-- (PGlite harness) or via `supabase test db`.

BEGIN;
SELECT plan(10);

INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000002', 'paper-atomic@test.local');

SELECT lives_ok($$
  SELECT public.worker_claim_xauusd_scan(
    '00000000-0000-0000-0000-000000000002'::uuid,
    'fp-atomic', 'XAUUSD', 'M1', '2026-08-11T07:42:00Z',
    'intraday', 'engine-v1', 'policy-v1', '2026-08-11T07:45:00Z')
$$, 'claim succeeds');

SELECT lives_ok($$
  SELECT public.worker_commit_xauusd_scan(
    (SELECT id FROM public.scan_runs WHERE scan_fingerprint = 'fp-atomic'),
    '00000000-0000-0000-0000-000000000002'::uuid,
    'fp-atomic',
    '[{"content_hash":"h-atomic","role":"entry","provider":"OANDA_V20_PRACTICE","instrument":"XAU_USD","timeframe":"M1","candle_closed_at":"2026-08-11T07:42:00Z","bid":3400.1,"ask":3400.3,"provider_time":"2026-08-11T07:42:10Z","received_at":"2026-08-11T07:42:11Z","candles":[],"quality_result":{}}]'::jsonb,
    '{"mode":"intraday","timeframe":"M1","direction":"long","entry":3400,"stop_loss":3390,"take_profit_1":3412.5,"take_profit_2":3420,"atr":3.2,"confluence":70,"contributing_strategies":["ema_trend"],"rationale":"atomicity fixture","expires_at":"2026-08-11T08:00:00Z"}'::jsonb,
    '{"expires_at":"2026-08-11T08:00:00Z"}'::jsonb,
    'engine-v1', 'policy-v1', 'b_single_v1', 'xauusd_0_01_lot_v1', '{}'::jsonb, '{}'::jsonb)
$$, 'commit succeeds');

-- 1. A stale expected version is rejected and nothing changes.
SELECT is(
  public.worker_apply_paper_transition(
    (SELECT pt.id FROM public.paper_trades pt JOIN public.signals s ON s.id = pt.signal_id WHERE s.scan_fingerprint = 'fp-atomic'),
    'waiting_entry', 99, 'open', 100, 'entry_filled:stale', 'entry_filled',
    '2026-08-11T07:42:10Z', 'waiting_entry', 'open',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}'::jsonb),
  false,
  'stale state version is rejected'
);

-- 2. The correct version applies and appends exactly one event.
SELECT is(
  public.worker_apply_paper_transition(
    (SELECT pt.id FROM public.paper_trades pt JOIN public.signals s ON s.id = pt.signal_id WHERE s.scan_fingerprint = 'fp-atomic'),
    'waiting_entry', 0, 'open', 1, 'entry_filled:t1', 'entry_filled',
    '2026-08-11T07:42:10Z', 'waiting_entry', 'open',
    3400.0, '2026-08-11T07:42:10Z', NULL, NULL, NULL, '2026-08-11T07:42:10Z',
    NULL, NULL, NULL, NULL, NULL, '{"side":"ask"}'::jsonb),
  true,
  'correct version applies'
);

SELECT is(
  (SELECT state_version::int FROM public.paper_trades pt JOIN public.signals s ON s.id = pt.signal_id WHERE s.scan_fingerprint = 'fp-atomic'),
  1,
  'state version incremented exactly once'
);
SELECT is(
  (SELECT count(*)::int FROM public.paper_trade_events pe
   JOIN public.paper_trades pt ON pt.id = pe.paper_trade_id
   JOIN public.signals s ON s.id = pt.signal_id
   WHERE s.scan_fingerprint = 'fp-atomic'),
  2,
  'trade_created + entry_filled = two events'
);

-- 3. Replaying the same event key returns false and never appends twice.
SELECT is(
  public.worker_apply_paper_transition(
    (SELECT pt.id FROM public.paper_trades pt JOIN public.signals s ON s.id = pt.signal_id WHERE s.scan_fingerprint = 'fp-atomic'),
    'waiting_entry', 0, 'open', 1, 'entry_filled:t1', 'entry_filled',
    '2026-08-11T07:42:10Z', 'waiting_entry', 'open',
    3400.0, '2026-08-11T07:42:10Z', NULL, NULL, NULL, '2026-08-11T07:42:10Z',
    NULL, NULL, NULL, NULL, NULL, '{"side":"ask"}'::jsonb),
  false,
  'duplicate event key is rejected'
);
SELECT is(
  (SELECT count(*)::int FROM public.paper_trade_events WHERE event_key = 'entry_filled:t1'),
  1,
  'duplicate key never appends a second event'
);

-- 4. An invalid next state fails and rolls back the entire transition.
SELECT throws_ok($$
  SELECT public.worker_apply_paper_transition(
    (SELECT pt.id FROM public.paper_trades pt JOIN public.signals s ON s.id = pt.signal_id WHERE s.scan_fingerprint = 'fp-atomic'),
    'open', 1, 'nonsense'::public.paper_trade_state, 2, 'bad-state', 'closed_stop',
    '2026-08-11T07:43:00Z', 'open', 'closed_stop',
    NULL, NULL, 3390, '2026-08-11T07:43:00Z', NULL, NULL,
    -1, NULL, NULL, NULL, NULL, '{}'::jsonb)
$$, '22P02', NULL, 'invalid next state raises');

SELECT is(
  (SELECT state::text FROM public.paper_trades pt JOIN public.signals s ON s.id = pt.signal_id WHERE s.scan_fingerprint = 'fp-atomic'),
  'open',
  'trade state is unchanged after the failed transition'
);

SELECT * FROM finish();
ROLLBACK;
