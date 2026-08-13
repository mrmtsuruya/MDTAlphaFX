-- End-to-end audit scheduler test: the weekly strategy-audit job fires the
-- same way the paper minute job does — Vault secrets -> configure RPC ->
-- stored pg_cron command -> net.http_post to the deployed function with the
-- x-worker-secret the handler requires. Also pins the table contract: RLS is
-- owner-scoped and the upsert key prevents duplicate runs.

BEGIN;
SELECT plan(13);

-- --- 1. Table contract -------------------------------------------------------
SELECT has_table('public', 'strategy_audit_runs', 'strategy_audit_runs exists');
SELECT col_not_null('public', 'strategy_audit_runs', 'run_id', 'run_id is required');
SELECT col_not_null('public', 'strategy_audit_runs', 'strategy_id', 'strategy_id is required');
SELECT is(
  (SELECT count(*)::int FROM pg_policies
   WHERE tablename = 'strategy_audit_runs' AND policyname = 'own audit runs select'),
  1,
  'owner-scoped RLS policy exists'
);

-- --- 2. Fail closed without Vault secrets ------------------------------------
SELECT throws_ok(
  'SELECT public.configure_strategy_audit_weekly_job()',
  'worker_secrets_missing',
  'configure refuses to schedule without the Vault secrets'
);

-- --- 3. With secrets, configure schedules the weekly job ---------------------
INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES
  ('project_url', 'https://mggqzhcacqthwoygmrhg.supabase.co'),
  ('publishable_key', 'pk_audit_e2e_456'),
  ('xauusd_worker_cron_secret', 'e2e-audit-secret-abc');

SELECT matches(
  public.configure_strategy_audit_weekly_job(),
  '^scheduled:[0-9]+$',
  'configure schedules the weekly audit job'
);

-- --- 4. Fire the stored cron command as pg_cron would ------------------------
DO $$
DECLARE v_command text;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'xauusd-strategy-audit';
  EXECUTE v_command;
END $$;

SELECT is(
  (SELECT count(*)::int FROM net.http_request),
  1,
  'firing the stored command records exactly one http_post'
);
SELECT is(
  (SELECT url FROM net.http_request),
  'https://mggqzhcacqthwoygmrhg.supabase.co/functions/v1/xauusd-strategy-audit',
  'url targets the deployed strategy-audit edge function'
);
SELECT is(
  (SELECT headers->>'x-worker-secret' FROM net.http_request),
  'e2e-audit-secret-abc',
  'x-worker-secret equals the secret the deployed function must hold'
);
SELECT is(
  (SELECT headers->>'apikey' FROM net.http_request),
  'pk_audit_e2e_456',
  'apikey matches the vault publishable key'
);

-- --- 5. Configure is idempotent, the upsert key is unique --------------------
SELECT is(
  public.configure_strategy_audit_weekly_job(),
  'scheduled:' || (SELECT jobid::text FROM cron.job WHERE jobname = 'xauusd-strategy-audit'),
  're-configuring returns the same job id'
);
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'xauusd-strategy-audit'),
  1,
  're-configuring never duplicates the weekly job'
);
-- The composite upsert key must reject a duplicate (run, user, tf, strategy, segment).
SELECT throws_ok(
  $sql$
    INSERT INTO public.strategy_audit_runs
      (run_id, user_id, pair, timeframe, strategy_id, segment, window_start, window_end)
    VALUES
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
       'XAUUSD', 'M15', 'ema_trend', 'in_sample',
       '2026-08-01T00:00:00Z', '2026-08-14T00:00:00Z'),
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
       'XAUUSD', 'M15', 'ema_trend', 'in_sample',
       '2026-08-01T00:00:00Z', '2026-08-14T00:00:00Z')
  $sql$,
  '23505',
  NULL,
  'duplicate audit rows are rejected by the composite key'
);

SELECT * FROM finish();
ROLLBACK;
