-- XAUUSD auto-paper scheduling: archive job + minute worker gate (2026-08-11).
--
-- Two scheduled jobs exist once this migration applies:
--   1. xauusd-paper-archive  every day 16:05 server-local
--        -> archive_xauusd_terminal_signals(now())  (30-day soft archive)
--   2. xauusd-paper-minute   every minute, but only AFTER the operator calls
--        configure_xauusd_paper_minute_job() with all three Vault secrets in
--        place (project_url, publishable_key, xauusd_worker_cron_secret).
--
-- The minute job fires a pg_net HTTP POST to the deployed
-- /functions/v1/xauusd-paper-worker with an empty JSON body and the
-- x-worker-secret header the worker's handler requires. Nothing here enables
-- any profile or starts the worker by itself — activation is a deliberate,
-- operator-run step (see HANDOFF.md).

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- --- Daily 30-day soft archive ----------------------------------------------
-- Runs at 16:05 server-local every day; safe to re-run (job upserts by name).
SELECT cron.schedule(
  'xauusd-paper-archive',
  '5 16 * * *',
  $$SELECT public.archive_xauusd_terminal_signals(now())$$
);

-- --- Minute worker gate (service-only, vault-gated) --------------------------
CREATE OR REPLACE FUNCTION public.configure_xauusd_paper_minute_job()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_url text;
  v_publishable_key text;
  v_worker_secret text;
  v_command text;
  v_job_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_project_url
  FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_publishable_key
  FROM vault.decrypted_secrets WHERE name = 'publishable_key';
  SELECT decrypted_secret INTO v_worker_secret
  FROM vault.decrypted_secrets WHERE name = 'xauusd_worker_cron_secret';

  -- Fail closed: no scheduling without every credential the worker needs.
  IF v_project_url IS NULL OR v_publishable_key IS NULL OR v_worker_secret IS NULL THEN
    RAISE EXCEPTION 'worker_secrets_missing';
  END IF;

  -- The worker's handler accepts exactly POST + x-worker-secret + empty body.
  v_command := 'select net.http_post('
    || 'url := ' || quote_literal(rtrim(v_project_url, '/') || '/functions/v1/xauusd-paper-worker') || ', '
    || 'headers := jsonb_build_object(''apikey'', ' || quote_literal(v_publishable_key)
    || ', ''Content-Type'', ''application/json'''
    || ', ''x-worker-secret'', ' || quote_literal(v_worker_secret) || '), '
    || 'body := ''{}''::jsonb)';

  -- cron.schedule upserts by job name, so re-running is idempotent.
  SELECT cron.schedule('xauusd-paper-minute', '* * * * *', v_command)
  INTO v_job_id;

  RETURN 'scheduled:' || v_job_id;
END;
$$;
REVOKE ALL ON FUNCTION public.configure_xauusd_paper_minute_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_xauusd_paper_minute_job() TO service_role;
