-- pgTAP RLS coverage for the canonical cutover (20260811020000): authenticated
-- users can read only their own signals/signal_events and can no longer write
-- either table. Impersonation is done the Supabase way: SET LOCAL ROLE
-- authenticated plus a request.jwt.claims 'sub' that auth.uid() reads.
-- Requires the PGlite/Supabase harness auth stub from run-tests.mjs.

BEGIN;
SELECT plan(12);

-- --- Fixtures (superuser): two users, one owner signal + audit event ----------
INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-0000-0000-000000000004', 'rls-owner@test.local');
INSERT INTO auth.users (id, email)
VALUES ('00000000-0000-0000-0000-000000000005', 'rls-other@test.local');

INSERT INTO public.signals
  (user_id, pair, direction, mode, timeframe, entry, stop_loss, take_profit_1,
   take_profit_2, atr, confluence, contributing_strategies, status, rationale,
   news_context, expires_at)
VALUES
  ('00000000-0000-0000-0000-000000000004', 'EURUSD', 'long', 'intraday', 'M15',
   1.1, 1.09, 1.12, 1.13, 0.01, 60, '{ema_trend}', 'fresh', 'rls fixture',
   '[]'::jsonb, now() + interval '1 hour');

INSERT INTO public.signal_events (signal_id, user_id, event, detail)
VALUES (
  (SELECT id FROM public.signals WHERE pair = 'EURUSD'),
  '00000000-0000-0000-0000-000000000004', 'created', '{}'::jsonb
);

-- --- Policies: FOR ALL gone, own-row SELECT in place -------------------------
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'signals' AND policyname = 'own signals'),
  0,
  'FOR ALL own signals policy is dropped'
);
SELECT ok(EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'signals'
    AND policyname = 'own signals select' AND cmd = 'SELECT'
), 'own signals select policy exists');
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'signal_events' AND policyname = 'own signal events'),
  0,
  'FOR ALL own signal events policy is dropped'
);
SELECT ok(EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'signal_events'
    AND policyname = 'own signal events select' AND cmd = 'SELECT'
), 'own signal events select policy exists');

-- --- Impersonate the owner ----------------------------------------------------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000004","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM public.signals WHERE pair = 'EURUSD'),
  1,
  'owner sees exactly their own signal'
);
SELECT throws_ok($$
  INSERT INTO public.signals
    (user_id, pair, direction, mode, timeframe, entry, stop_loss, take_profit_1,
     take_profit_2, atr, confluence, contributing_strategies, status, rationale,
     news_context, expires_at)
  VALUES
    ('00000000-0000-0000-0000-000000000004', 'EURUSD', 'long', 'intraday', 'M15',
     1.1, 1.09, 1.12, 1.13, 0.01, 60, '{ema_trend}', 'fresh', 'denied',
     '[]'::jsonb, now() + interval '1 hour')
$$, '42501', NULL, 'authenticated INSERT on signals is denied');
SELECT throws_ok($$
  UPDATE public.signals SET rationale = 'tampered' WHERE pair = 'EURUSD'
$$, '42501', NULL, 'authenticated UPDATE on signals is denied');
SELECT throws_ok($$
  DELETE FROM public.signals WHERE pair = 'EURUSD'
$$, '42501', NULL, 'authenticated DELETE on signals is denied');
SELECT throws_ok($$
  INSERT INTO public.signal_events (signal_id, user_id, event, detail)
  SELECT id, '00000000-0000-0000-0000-000000000004', 'tampered', '{}'::jsonb
  FROM public.signals WHERE pair = 'EURUSD'
$$, '42501', NULL, 'authenticated INSERT on signal_events is denied');
SELECT is(
  (SELECT count(*)::int FROM public.signals WHERE pair = 'EURUSD'),
  1,
  'no signal rows were created or deleted'
);
SELECT is(
  (SELECT count(*)::int FROM public.signal_events),
  1,
  'signal_events ledger is unchanged'
);

-- --- Impersonate another user ------------------------------------------------
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000005","role":"authenticated"}';

SELECT is(
  (SELECT count(*)::int FROM public.signals WHERE pair = 'EURUSD'),
  0,
  'other user sees no signals'
);

SELECT * FROM finish();
ROLLBACK;
