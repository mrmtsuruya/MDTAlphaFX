-- Strategy audit runs: weekly walk-forward scorecards for the strategy
-- health view (2026-08-14).
--
-- The edge function `xauusd-strategy-audit` runs the repo's real-data
-- walk-forward backtest on the live keyless feed (XAUUSD M15 + H1) and
-- writes every strategy's resolved/win/scratch/loss/R per segment here, so
-- the strategy league can watch the trend cluster and the mean-reversion
-- flip in real time instead of relying on one-off script runs.
--
-- Scheduling mirrors the minute worker: an operator-run, vault-gated
-- configure_* RPC wires a weekly pg_cron job that POSTs to the deployed
-- function with the x-worker-secret. Nothing here schedules anything by
-- itself.

-- --- Table: one row per (run, timeframe, strategy, segment) ------------------
CREATE TABLE public.strategy_audit_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pair text NOT NULL CHECK (pair = 'XAUUSD'),
  timeframe text NOT NULL,
  strategy_id text NOT NULL,
  segment text NOT NULL CHECK (segment IN ('in_sample', 'out_of_sample')),
  resolved integer NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  scratches integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  open integer NOT NULL DEFAULT 0,
  win_rate numeric(5,2),
  total_r numeric(10,4) NOT NULL DEFAULT 0,
  expectancy_r numeric(10,4),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  notes jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE UNIQUE INDEX strategy_audit_run_uidx
  ON public.strategy_audit_runs (run_id, user_id, timeframe, strategy_id, segment);
CREATE INDEX strategy_audit_runs_lookup_idx
  ON public.strategy_audit_runs (user_id, timeframe, generated_at DESC);
GRANT SELECT ON public.strategy_audit_runs TO authenticated;
GRANT ALL ON public.strategy_audit_runs TO service_role;
ALTER TABLE public.strategy_audit_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own audit runs select" ON public.strategy_audit_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- --- Weekly audit gate (service-only, vault-gated) ---------------------------
-- Fires a pg_net HTTP POST to /functions/v1/xauusd-strategy-audit with the
-- x-worker-secret header (the same secret the paper worker uses), every
-- Monday 04:00 server-local. Reuses project_url + xauusd_worker_cron_secret
-- from Vault — no new secrets to manage.
CREATE OR REPLACE FUNCTION public.configure_strategy_audit_weekly_job()
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

  -- Fail closed: no scheduling without every credential the function needs.
  IF v_project_url IS NULL OR v_publishable_key IS NULL OR v_worker_secret IS NULL THEN
    RAISE EXCEPTION 'worker_secrets_missing';
  END IF;

  v_command := 'select net.http_post('
    || 'url := ' || quote_literal(rtrim(v_project_url, '/') || '/functions/v1/xauusd-strategy-audit') || ', '
    || 'headers := jsonb_build_object(''apikey'', ' || quote_literal(v_publishable_key)
    || ', ''Content-Type'', ''application/json'''
    || ', ''x-worker-secret'', ' || quote_literal(v_worker_secret) || '), '
    || 'body := ''{}''::jsonb)';

  -- cron.schedule upserts by job name, so re-running is idempotent.
  SELECT cron.schedule('xauusd-strategy-audit', '0 4 * * 1', v_command)
  INTO v_job_id;

  RETURN 'scheduled:' || v_job_id;
END;
$$;
REVOKE ALL ON FUNCTION public.configure_strategy_audit_weekly_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_strategy_audit_weekly_job() TO service_role;
