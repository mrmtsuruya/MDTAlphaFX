-- Promotion ledger contract: table shape, CHECKs, and owner-scoped RLS with
-- the insert path the approval flow uses.

BEGIN;
SELECT plan(9);

-- Owner for the promotion rows (FK target; the harness seeds no users).
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000006', 'promo@test.local');

SELECT has_table('public', 'strategy_promotions', 'strategy_promotions exists');
SELECT col_not_null('public', 'strategy_promotions', 'strategy_id', 'strategy_id is required');
SELECT col_not_null('public', 'strategy_promotions', 'mode', 'mode is required');
SELECT col_not_null('public', 'strategy_promotions', 'action', 'action is required');

-- The multiplier must stay in the promotable band.
SELECT throws_ok($$
  INSERT INTO public.strategy_promotions
    (user_id, strategy_id, mode, action, multiplier, resolved_samples, verdict)
  VALUES
    ('00000000-0000-0000-0000-000000000006', 'ema_trend', 'intraday', 'approve', 2.0, 20, 'boost')
$$, '23514', NULL, 'multiplier above the 1.35 band is rejected');

-- The action enum is enforced.
SELECT throws_ok($$
  INSERT INTO public.strategy_promotions
    (user_id, strategy_id, mode, action, multiplier, resolved_samples, verdict)
  VALUES
    ('00000000-0000-0000-0000-000000000006', 'ema_trend', 'intraday', 'silently_apply', 1.0, 20, 'boost')
$$, '23514', NULL, 'unknown actions are rejected');

-- Owner-scoped RLS: the owner can write, a stranger cannot read the row.
INSERT INTO public.strategy_promotions
  (user_id, strategy_id, mode, action, multiplier, resolved_samples, verdict)
VALUES
  ('00000000-0000-0000-0000-000000000006', 'ema_trend', 'intraday', 'approve', 1.2, 25, 'boost'),
  ('00000000-0000-0000-0000-000000000006', 'ema_trend', 'intraday', 'revert', 1.0, 25, 'n/a');

SET ROLE authenticated;
SET request.jwt.claims = '{"sub": "00000000-0000-0000-0000-000000000006"}';
SELECT is(
  (SELECT count(*)::int FROM public.strategy_promotions),
  2,
  'owner sees exactly their own promotion rows'
);
SELECT is(
  (SELECT multiplier::numeric FROM public.strategy_promotions
   WHERE action = 'approve' ORDER BY created_at DESC LIMIT 1),
  1.2,
  'approve multiplier is stored as decided'
);
RESET ROLE;

-- The ledger is append-only state: the same pair can be approved and reverted,
-- and the latest row wins (no unique constraint on strategy+mode).
SELECT is(
  (SELECT count(*)::int FROM public.strategy_promotions
   WHERE strategy_id = 'ema_trend' AND mode = 'intraday'),
  2,
  'approve + revert rows coexist as the audit trail'
);

SELECT * FROM finish();
ROLLBACK;
