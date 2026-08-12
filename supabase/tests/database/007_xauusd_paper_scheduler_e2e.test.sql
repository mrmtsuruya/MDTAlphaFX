-- End-to-end scheduler test: from Vault secrets to a request the worker
-- handler accepts.
--
--  1. Insert the three Vault secrets (project_url, publishable_key,
--     xauusd_worker_cron_secret) — the operator step from HANDOFF.md.
--  2. configure_xauusd_paper_minute_job() schedules the minute job.
--  3. EXECUTE the stored cron.job command exactly as pg_cron would fire it;
--     the net.http_post stub records the call into net.http_request.
--  4. Assert the recorded request satisfies every check createWorkerHandler
--     makes (src/lib/xauusd-paper-handler.ts): the method is POST by
--     construction (net.http_post), the x-worker-secret header equals the
--     secret the deployed function holds (digest-equal against
--     XAUUSD_WORKER_CRON_SECRET), and the body is the empty JSON object.
--     The Node side (xauusd-paper-handler.test.ts) proves the handler
--     returns 200 for exactly that shape.
--
-- Run locally with `node tools/pgtap-run.mjs 007` (PGlite harness).

BEGIN;
SELECT plan(10);

-- --- 1. Insert the three Vault secrets ---------------------------------------
INSERT INTO vault.decrypted_secrets (name, decrypted_secret) VALUES
  ('project_url', 'https://mggqzhcacqthwoygmrhg.supabase.co'),
  ('publishable_key', 'pk_e2e_test_789'),
  ('xauusd_worker_cron_secret', 'e2e-worker-secret-xyz');

-- --- 2. Configure: schedule the minute job -----------------------------------
SELECT matches(
  public.configure_xauusd_paper_minute_job(),
  '^scheduled:[0-9]+$',
  'configure schedules the minute job'
);

-- --- 3. Fire the stored cron command as pg_cron would ------------------------
DO $$
DECLARE v_command text;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'xauusd-paper-minute';
  EXECUTE v_command;
END $$;

SELECT is(
  (SELECT count(*)::int FROM net.http_request),
  1,
  'firing the stored command records exactly one http_post'
);

-- --- 4. The recorded request satisfies the worker handler's contract ---------
SELECT is(
  (SELECT url FROM net.http_request),
  'https://mggqzhcacqthwoygmrhg.supabase.co/functions/v1/xauusd-paper-worker',
  'url targets the deployed worker edge function'
);
SELECT is(
  (SELECT headers->>'x-worker-secret' FROM net.http_request),
  'e2e-worker-secret-xyz',
  'x-worker-secret equals the secret the deployed function must hold'
);
SELECT is(
  (SELECT headers->>'apikey' FROM net.http_request),
  'pk_e2e_test_789',
  'apikey matches the vault publishable key'
);
SELECT is(
  (SELECT headers->>'Content-Type' FROM net.http_request),
  'application/json',
  'content-type is application/json'
);
SELECT is(
  (SELECT body FROM net.http_request),
  '{}'::jsonb,
  'body is the empty JSON object the handler accepts'
);

-- --- The command is re-fireable every minute, configure stays idempotent -----
DO $$
DECLARE v_command text;
BEGIN
  SELECT command INTO v_command FROM cron.job WHERE jobname = 'xauusd-paper-minute';
  EXECUTE v_command;
END $$;

SELECT is(
  (SELECT count(*)::int FROM net.http_request),
  2,
  're-firing the stored command records another request'
);
SELECT is(
  public.configure_xauusd_paper_minute_job(),
  'scheduled:' || (SELECT jobid::text FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  're-configuring returns the same job id'
);
SELECT is(
  (SELECT count(*)::int FROM cron.job WHERE jobname = 'xauusd-paper-minute'),
  1,
  're-configuring never duplicates the minute job'
);

SELECT * FROM finish();
ROLLBACK;
