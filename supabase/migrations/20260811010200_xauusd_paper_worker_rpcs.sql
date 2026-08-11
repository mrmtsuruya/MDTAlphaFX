-- Atomic worker RPCs for the XAUUSD auto-paper worker (2026-08-11).
--
-- Canonical writes go through these SECURITY DEFINER functions only; the
-- repository adapter in src/lib/xauusd-paper-repository.ts never issues a
-- direct insert/update/delete against signals or paper_trades. Every worker
-- RPC pins search_path to public, is revoked from PUBLIC/anon/authenticated,
-- and is granted only to service_role — except set_xauusd_paper_enabled,
-- which is the single authenticated entry point for the UI toggle.

-- --- Authenticated profile toggle --------------------------------------------
CREATE OR REPLACE FUNCTION public.set_xauusd_paper_enabled(p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- Enabling requires a fresh, healthy provider check; disabling always works.
  IF p_enabled AND NOT EXISTS (
    SELECT 1 FROM public.paper_worker_health
    WHERE id = 'xauusd' AND ok = true AND checked_at >= now() - interval '2 minutes'
  ) THEN
    RAISE EXCEPTION 'provider_health_required';
  END IF;

  INSERT INTO public.paper_trading_profiles
    (user_id, enabled, symbol, lot_size, timezone, strategy_scope, activated_at)
  VALUES
    (v_uid, p_enabled, 'XAUUSD', 0.01, 'Asia/Manila', 'all_registered',
     CASE WHEN p_enabled THEN now() ELSE NULL END)
  ON CONFLICT (user_id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    symbol = 'XAUUSD',
    lot_size = 0.01,
    timezone = 'Asia/Manila',
    strategy_scope = 'all_registered',
    -- activated_at is only stamped on the false -> true transition.
    activated_at = CASE
      WHEN paper_trading_profiles.enabled = false AND EXCLUDED.enabled = true THEN now()
      ELSE paper_trading_profiles.activated_at
    END,
    updated_at = now();

  IF p_enabled THEN
    -- Enable missing settings for every catalog strategy; silence never
    -- means disabled, so an explicit false row stays authoritative.
    INSERT INTO public.strategy_settings (user_id, strategy_id, enabled)
    SELECT v_uid, s.id, true
    FROM public.strategies s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.strategy_settings ss
      WHERE ss.user_id = v_uid AND ss.strategy_id = s.id
    );
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_xauusd_paper_enabled(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_xauusd_paper_enabled(boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.set_xauusd_paper_enabled(boolean) FROM service_role;
GRANT EXECUTE ON FUNCTION public.set_xauusd_paper_enabled(boolean) TO service_role;

-- --- Worker health (bounded safe fields only) --------------------------------
-- Never stores a token, account ID, response body, or request headers.
CREATE OR REPLACE FUNCTION public.worker_record_xauusd_health(
  p_ok boolean,
  p_code text,
  p_checked_at timestamptz,
  p_provider text,
  p_instrument text,
  p_quote_provider_time timestamptz,
  p_quote_age_ms integer,
  p_spread numeric,
  p_detail jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.paper_worker_health
    (id, provider, instrument, ok, code, checked_at, quote_provider_time, quote_age_ms, spread, detail)
  VALUES
    ('xauusd', p_provider, p_instrument, p_ok, p_code, p_checked_at,
     p_quote_provider_time, p_quote_age_ms, p_spread, COALESCE(p_detail, '{}'::jsonb))
  ON CONFLICT (id) DO UPDATE SET
    provider = EXCLUDED.provider,
    instrument = EXCLUDED.instrument,
    ok = EXCLUDED.ok,
    code = EXCLUDED.code,
    checked_at = EXCLUDED.checked_at,
    quote_provider_time = EXCLUDED.quote_provider_time,
    quote_age_ms = EXCLUDED.quote_age_ms,
    spread = EXCLUDED.spread,
    detail = EXCLUDED.detail;
END;
$$;
REVOKE ALL ON FUNCTION public.worker_record_xauusd_health(
  boolean, text, timestamptz, text, text, timestamptz, integer, numeric, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_record_xauusd_health(
  boolean, text, timestamptz, text, text, timestamptz, integer, numeric, jsonb
) TO service_role;

-- --- Idempotent scan claim ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.worker_claim_xauusd_scan(
  p_user_id uuid,
  p_scan_fingerprint text,
  p_symbol text,
  p_timeframe text,
  p_candle_closed_at timestamptz,
  p_scan_mode public.trader_profile,
  p_engine_version text,
  p_policy_version text,
  p_lease_expires_at timestamptz
)
RETURNS TABLE (scan_run_id uuid, claimed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- claimed must mean "this call inserted the row": a duplicate/concurrent
  -- claim on the same fingerprint returns the existing run with claimed=false
  -- so only one worker ever owns a scan.
  RETURN QUERY
  WITH ins AS (
    INSERT INTO public.scan_runs
      (user_id, scan_fingerprint, symbol, timeframe, candle_closed_at, scan_mode,
       engine_version, policy_version, status, lease_expires_at, started_at)
    VALUES
      (p_user_id, p_scan_fingerprint, p_symbol, p_timeframe, p_candle_closed_at,
       p_scan_mode, p_engine_version, p_policy_version, 'running',
       p_lease_expires_at, now())
    ON CONFLICT (scan_fingerprint) DO NOTHING
    RETURNING id
  )
  SELECT id, true FROM ins
  UNION ALL
  SELECT id, false FROM public.scan_runs
  WHERE scan_fingerprint = p_scan_fingerprint
    AND NOT EXISTS (SELECT 1 FROM ins);
END;
$$;
REVOKE ALL ON FUNCTION public.worker_claim_xauusd_scan(
  uuid, text, text, text, timestamptz, public.trader_profile, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_claim_xauusd_scan(
  uuid, text, text, text, timestamptz, public.trader_profile, text, text, timestamptz
) TO service_role;

-- --- Atomic scan commit -------------------------------------------------------
-- One function: locks the run, inserts/reuses every snapshot by content hash,
-- publishes the canonical signal, links snapshots, creates exactly one
-- 0.01-lot waiting_entry trade, appends the trade_created event, and marks
-- the run completed. Any constraint failure rolls back every step.
CREATE OR REPLACE FUNCTION public.worker_commit_xauusd_scan(
  p_scan_run_id uuid,
  p_user_id uuid,
  p_scan_fingerprint text,
  p_snapshots jsonb,
  p_signal jsonb,
  p_trade jsonb,
  p_engine_version text,
  p_policy_version text,
  p_execution_policy_version text,
  p_instrument_spec_version text,
  p_quality_result jsonb,
  p_engine_accounting jsonb
)
RETURNS TABLE (signal_id uuid, paper_trade_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot record;
  v_snapshot_id uuid;
  v_entry_snapshot uuid := NULL;
  v_links text[] := '{}';
  v_link text;
  v_signal_id uuid;
  v_trade_id uuid;
  v_mode public.trader_profile;
  v_timeframe text;
  v_direction public.signal_direction;
  v_entry numeric;
  v_stop numeric;
  v_tp1 numeric;
  v_tp2 numeric;
  v_atr numeric;
  v_confluence integer;
  v_expires_at timestamptz;
BEGIN
  PERFORM 1 FROM public.scan_runs WHERE id = p_scan_run_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scan_run_not_found';
  END IF;

  -- Idempotency: the same fingerprint must never publish a second signal.
  SELECT id INTO v_signal_id FROM public.signals
  WHERE scan_fingerprint = p_scan_fingerprint;
  IF v_signal_id IS NOT NULL THEN
    SELECT id INTO v_trade_id FROM public.paper_trades pt WHERE pt.signal_id = v_signal_id;
    RETURN QUERY SELECT v_signal_id, v_trade_id, false;
    RETURN;
  END IF;

  -- Insert/reuse every entry and MTF snapshot by content hash.
  FOR v_snapshot IN
    SELECT * FROM jsonb_to_recordset(p_snapshots) AS x(
      content_hash text,
      role text,
      provider text,
      instrument text,
      timeframe text,
      candle_closed_at timestamptz,
      bid numeric,
      ask numeric,
      provider_time timestamptz,
      received_at timestamptz,
      candles jsonb,
      quality_result jsonb
    )
  LOOP
    v_snapshot_id := NULL;
    INSERT INTO public.market_snapshots
      (provider, instrument, timeframe, candle_closed_at, bid, ask,
       provider_time, received_at, candles, content_hash, quality_result)
    VALUES
      (v_snapshot.provider, v_snapshot.instrument, v_snapshot.timeframe,
       v_snapshot.candle_closed_at, v_snapshot.bid, v_snapshot.ask,
       v_snapshot.provider_time, v_snapshot.received_at, v_snapshot.candles,
       v_snapshot.content_hash, v_snapshot.quality_result)
    ON CONFLICT (content_hash) DO NOTHING
    RETURNING id INTO v_snapshot_id;

    IF v_snapshot_id IS NULL THEN
      SELECT id INTO v_snapshot_id FROM public.market_snapshots
      WHERE content_hash = v_snapshot.content_hash;
    END IF;

    IF v_snapshot_id IS NULL THEN
      RAISE EXCEPTION 'snapshot_unavailable';
    END IF;

    IF v_snapshot.role = 'entry' AND v_entry_snapshot IS NULL THEN
      v_entry_snapshot := v_snapshot_id;
    END IF;
    v_links := array_append(v_links, v_snapshot_id || ':' || v_snapshot.role);
  END LOOP;

  IF v_entry_snapshot IS NULL THEN
    RAISE EXCEPTION 'entry_snapshot_required';
  END IF;

  v_mode := (p_signal->>'mode')::public.trader_profile;
  v_timeframe := p_signal->>'timeframe';
  v_direction := (p_signal->>'direction')::public.signal_direction;
  v_entry := (p_signal->>'entry')::numeric;
  v_stop := (p_signal->>'stop_loss')::numeric;
  v_tp1 := (p_signal->>'take_profit_1')::numeric;
  v_tp2 := (p_signal->>'take_profit_2')::numeric;
  v_atr := (p_signal->>'atr')::numeric;
  v_confluence := (p_signal->>'confluence')::integer;
  v_expires_at := (p_trade->>'expires_at')::timestamptz;

  INSERT INTO public.signals
    (user_id, pair, direction, mode, timeframe, entry, stop_loss, take_profit_1,
     take_profit_2, atr, confluence, contributing_strategies, status, rationale,
     news_context, expires_at, scan_run_id, market_snapshot_id, engine_version,
     policy_version, execution_policy_version, scan_fingerprint, generated_by)
  VALUES
    (p_user_id, 'XAUUSD', v_direction, v_mode, v_timeframe, v_entry, v_stop,
     v_tp1, v_tp2, v_atr, v_confluence,
     COALESCE(ARRAY(SELECT jsonb_array_elements_text(p_signal->'contributing_strategies')), '{}'), 'fresh',
     p_signal->>'rationale', '[]'::jsonb, v_expires_at, p_scan_run_id,
     v_entry_snapshot, p_engine_version, p_policy_version,
     p_execution_policy_version, p_scan_fingerprint, 'xauusd_paper_worker')
  RETURNING id INTO v_signal_id;

  -- Link every snapshot to the published signal by its role.
  FOREACH v_link IN ARRAY v_links LOOP
    INSERT INTO public.signal_market_snapshots (signal_id, market_snapshot_id, role)
    VALUES (
      v_signal_id,
      split_part(v_link, ':', 1)::uuid,
      split_part(v_link, ':', 2)
    )
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- Exactly one 0.01-lot waiting_entry trade per signal.
  INSERT INTO public.paper_trades
    (signal_id, user_id, symbol, lot_size, direction, timeframe, state, state_version,
     planned_entry, stop_loss, take_profit_1, take_profit_2, expires_at,
     execution_policy_version, instrument_spec_version)
  VALUES
    (v_signal_id, p_user_id, 'XAUUSD', 0.01, v_direction,
     COALESCE(p_signal->>'timeframe', ''), 'waiting_entry', 0,
     v_entry, v_stop, v_tp1, v_tp2, v_expires_at,
     p_execution_policy_version, p_instrument_spec_version)
  RETURNING id INTO v_trade_id;

  INSERT INTO public.paper_trade_events
    (paper_trade_id, user_id, sequence_no, event_key, event_type,
     before_state, after_state, evidence)
  VALUES
    (v_trade_id, p_user_id, 1, 'trade_created', 'trade_created',
     NULL, 'waiting_entry', '{}'::jsonb);

  UPDATE public.scan_runs
  SET status = 'completed', finished_at = now(),
      quality_result = COALESCE(p_quality_result, '{}'::jsonb),
      engine_accounting = COALESCE(p_engine_accounting, '{}'::jsonb),
      updated_at = now()
  WHERE id = p_scan_run_id;

  RETURN QUERY SELECT v_signal_id, v_trade_id, true;
END;
$$;
REVOKE ALL ON FUNCTION public.worker_commit_xauusd_scan(
  uuid, uuid, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_commit_xauusd_scan(
  uuid, uuid, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb, jsonb
) TO service_role;

-- --- Compare-and-swap trade transition ---------------------------------------
-- Locks the trade, requires the exact current state plus version, updates the
-- trade, and appends ONE event with the next sequence number. A duplicate
-- event_key returns applied=false and never appends a second event.
CREATE OR REPLACE FUNCTION public.worker_apply_paper_transition(
  p_trade_id uuid,
  p_expected_state public.paper_trade_state,
  p_expected_version integer,
  p_next_state public.paper_trade_state,
  p_next_version integer,
  p_event_key text,
  p_event_type text,
  p_provider_timestamp timestamptz,
  p_before_state public.paper_trade_state,
  p_after_state public.paper_trade_state,
  p_entry_price numeric,
  p_entry_time timestamptz,
  p_exit_price numeric,
  p_exit_time timestamptz,
  p_tp1_armed_at timestamptz,
  p_last_observed_at timestamptz,
  p_result_r numeric,
  p_mae_r numeric,
  p_mfe_r numeric,
  p_bars_held integer,
  p_ambiguous_intrabar boolean,
  p_evidence jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_applied boolean := false;
  v_seq integer;
  v_user_id uuid;
BEGIN
  PERFORM 1 FROM public.paper_trades WHERE id = p_trade_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Idempotent replay: the same event key must never append twice.
  IF EXISTS (
    SELECT 1 FROM public.paper_trade_events
    WHERE paper_trade_id = p_trade_id AND event_key = p_event_key
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.paper_trades
  SET state = p_next_state,
      state_version = p_next_version,
      entry_price = COALESCE(p_entry_price, entry_price),
      entry_time = COALESCE(p_entry_time, entry_time),
      exit_price = COALESCE(p_exit_price, exit_price),
      exit_time = COALESCE(p_exit_time, exit_time),
      tp1_armed_at = COALESCE(p_tp1_armed_at, tp1_armed_at),
      last_observed_at = COALESCE(p_last_observed_at, last_observed_at),
      result_r = COALESCE(p_result_r, result_r),
      mae_r = COALESCE(p_mae_r, mae_r),
      mfe_r = COALESCE(p_mfe_r, mfe_r),
      bars_held = COALESCE(p_bars_held, bars_held),
      ambiguous_intrabar = COALESCE(p_ambiguous_intrabar, ambiguous_intrabar),
      updated_at = now()
  WHERE id = p_trade_id
    AND state = p_expected_state
    AND state_version = p_expected_version;

  GET DIAGNOSTICS v_applied = ROW_COUNT;
  IF NOT v_applied THEN
    RETURN false;
  END IF;

  SELECT user_id INTO v_user_id FROM public.paper_trades WHERE id = p_trade_id;
  SELECT COALESCE(MAX(sequence_no), 0) + 1 INTO v_seq
  FROM public.paper_trade_events WHERE paper_trade_id = p_trade_id;

  BEGIN
    INSERT INTO public.paper_trade_events
      (paper_trade_id, user_id, sequence_no, event_key, event_type,
       provider_timestamp, before_state, after_state, evidence)
    VALUES
      (p_trade_id, v_user_id, v_seq, p_event_key, p_event_type,
       p_provider_timestamp, p_before_state, p_after_state,
       COALESCE(p_evidence, '{}'::jsonb));
  EXCEPTION WHEN unique_violation THEN
    RETURN false;
  END;

  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.worker_apply_paper_transition(
  uuid, public.paper_trade_state, integer, public.paper_trade_state, integer,
  text, text, timestamptz, public.paper_trade_state, public.paper_trade_state,
  numeric, timestamptz, numeric, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_apply_paper_transition(
  uuid, public.paper_trade_state, integer, public.paper_trade_state, integer,
  text, text, timestamptz, public.paper_trade_state, public.paper_trade_state,
  numeric, timestamptz, numeric, timestamptz, timestamptz, timestamptz,
  numeric, numeric, numeric, integer, boolean, jsonb
) TO service_role;

-- --- Fail / degrade a scan with safe codes only ------------------------------
CREATE OR REPLACE FUNCTION public.worker_fail_xauusd_scan(
  p_scan_run_id uuid,
  p_status public.paper_scan_status,
  p_code text,
  p_detail text,
  p_engine_accounting jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('failed', 'degraded') THEN
    RAISE EXCEPTION 'unsafe_scan_status';
  END IF;
  IF p_code NOT IN (
    'not_tradeable', 'stale_quote', 'crossed_quote', 'instrument_mismatch',
    'candles_not_ascending', 'duplicate_candle', 'incomplete_candle',
    'invalid_ohlc', 'candle_gap', 'invalid_stop_distance', 'spread_too_wide',
    'quote_unavailable', 'candles_unavailable', 'unauthorized',
    'credentials_missing', 'malformed_response', 'provider_unavailable',
    'trade_observation_gap', 'strategy_catalog_drift',
    'macro_context_unavailable', 'internal_error', 'unknown'
  ) THEN
    RAISE EXCEPTION 'unsafe_error_code';
  END IF;

  UPDATE public.scan_runs
  SET status = p_status,
      finished_at = now(),
      error_code = p_code,
      error_detail = left(COALESCE(p_detail, ''), 2000),
      engine_accounting = COALESCE(p_engine_accounting, '{}'::jsonb),
      updated_at = now()
  WHERE id = p_scan_run_id;
END;
$$;
REVOKE ALL ON FUNCTION public.worker_fail_xauusd_scan(
  uuid, public.paper_scan_status, text, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.worker_fail_xauusd_scan(
  uuid, public.paper_scan_status, text, text, jsonb
) TO service_role;

-- --- 30-day soft archive ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_xauusd_terminal_signals(p_now timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  UPDATE public.signals s
  SET archived_at = p_now,
      archive_reason = '30_day_retention',
      updated_at = now()
  WHERE s.generated_by = 'xauusd_paper_worker'
    AND s.archived_at IS NULL
    AND s.created_at <= p_now - interval '30 days'
    AND EXISTS (
      SELECT 1 FROM public.paper_trades pt
      WHERE pt.signal_id = s.id
        AND pt.state IN ('closed_tp2', 'closed_breakeven', 'closed_stop', 'expired')
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE public.paper_trades pt
  SET archived_at = p_now, updated_at = now()
  FROM public.signals s
  WHERE pt.signal_id = s.id
    AND s.generated_by = 'xauusd_paper_worker'
    AND s.archived_at = p_now;

  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.archive_xauusd_terminal_signals(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_xauusd_terminal_signals(timestamptz) TO service_role;
