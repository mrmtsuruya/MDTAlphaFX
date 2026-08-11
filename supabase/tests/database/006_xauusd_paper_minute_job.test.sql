-- pgTAP coverage for configure_xauusd_paper_minute_job: it fails closed with
-- worker_secrets_missing unless ALL three Vault secrets exist, and once they
-- do it upserts the xauusd-paper-minute cron job whose command posts the
-- worker edge-function URL with the publishable key as apikey, the
-- x-worker-secret header, and an empty JSON body. Re-running is idempotent
-- and the archive job is never clobbered. The function is service-only.
-- Run locally with `node tools/pgtap-run.mjs 006` (PGlite harness).

BEGIN;
SELECT plan(14);

-- --- Empty Vault: fail closed ------------------------------------------------
SELECT throws_ok($$
  SELECT public.configure_xauusd_paper_minute_job()
$$, 'P0001', 'worker_secrets_missing',
   'refuses to schedule while no Vault secrets exist');

-- --- All three Vault secrets present -----------------------------------------
INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES
  ('project_url', 'https://mggqzhcacqthwoygmrhg.supabase.co'),
  ('publishable_key', 'pk_test_123'),
  ('xauusd_worker_cron_secret', 'secret-value-456');

SELECT matches(
  public.configure_xauusd_paper_minute_job(),
  '^scheduled:[0-9]+$',
  'returns scheduled:<jobid>'
);

-- --- The minute cron job is created exactly once -----------------------------
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  1,
  'xauusd-paper-minute job exists in cron.job'
);
SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  '* * * * *',
  'minute job runs every minute'
);
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  'functions/v1/xauusd-paper-worker',
  'command targets the worker edge function'
);
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  'x-worker-secret',
  'command carries the x-worker-secret header'
);
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  'apikey',
  'command carries the apikey header'
);
SELECT matches(
  (SELECT command FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  '''{}''::jsonb',
  'command posts an empty JSON body'
);

-- --- Idempotent re-run; archive job untouched --------------------------------
SELECT is(
  public.configure_xauusd_paper_minute_job(),
  'scheduled:' || (SELECT jobid::text FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  're-running returns the same job id'
);
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  1,
  're-running never duplicates the minute job'
);
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'xauusd-paper-archive'),
  1,
  'archive job remains scheduled'
);
SELECT is(
  (SELECT schedule FROM cron.job WHERE jobname = 'xauusd-paper-archive'),
  '5 16 * * *',
  'archive job schedule is intact'
);

-- --- Partial secrets still fail closed ---------------------------------------
DELETE FROM vault.decrypted_secrets WHERE name = 'xauusd_worker_cron_secret';
SELECT throws_ok($$
  SELECT public.configure_xauusd_paper_minute_job()
$$, 'P0001', 'worker_secrets_missing',
   'a missing one of the three secrets still refuses');

-- --- Service-only: authenticated cannot configure ----------------------------
SET LOCAL ROLE authenticated;
SELECT throws_ok($$
  SELECT public.configure_xauusd_paper_minute_job()
$$, '42501', NULL,
   'authenticated cannot configure the minute job');

SELECT * FROM finish();
ROLLBACK;
