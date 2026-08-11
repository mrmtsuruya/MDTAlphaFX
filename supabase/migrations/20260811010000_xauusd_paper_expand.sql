-- XAUUSD Auto-Paper canonical schema (2026-08-11).
--
-- Adds the forward-only tables the unattended worker writes to: paper
-- profiles (fixed XAUUSD / 0.01 lot / Asia/Manila), a singleton worker-health
-- row, idempotent scan runs, shared market snapshots, canonical signals,
-- paper trades and an append-only event ledger. Also adds nullable provenance
-- columns to `signals` so canonical worker rows are distinguishable from
-- legacy browser rows without touching the legacy rows themselves.
--
-- Authenticated users get own-row SELECT on profile/run/trade/event tables
-- and read-only SELECT on the bounded singleton health row. There is no
-- authenticated grant on `market_snapshots` or `signal_market_snapshots`.
-- Legacy signal writes are intentionally NOT revoked here — that is the
-- forward-only cutover migration (20260811020000). Profiles default disabled.
-- Nothing here auto-enables any user.

-- --- Enums ------------------------------------------------------------------
CREATE TYPE public.paper_scan_status AS ENUM ('running', 'completed', 'degraded', 'failed');
CREATE TYPE public.paper_trade_state AS ENUM (
  'waiting_entry',
  'open',
  'tp1_protected',
  'closed_tp2',
  'closed_breakeven',
  'closed_stop',
  'expired'
);

-- --- Canonical signal provenance (nullable; legacy rows unaffected) ----------
ALTER TABLE public.signals
  ADD COLUMN scan_run_id uuid,
  ADD COLUMN market_snapshot_id uuid,
  ADD COLUMN engine_version text,
  ADD COLUMN policy_version text,
  ADD COLUMN execution_policy_version text,
  ADD COLUMN scan_fingerprint text,
  ADD COLUMN generated_by text NOT NULL DEFAULT 'legacy_browser',
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archive_reason text;

-- --- paper_trading_profiles --------------------------------------------------
CREATE TABLE public.paper_trading_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  symbol text NOT NULL DEFAULT 'XAUUSD' CHECK (symbol = 'XAUUSD'),
  lot_size numeric(4,2) NOT NULL DEFAULT 0.01 CHECK (lot_size = 0.01),
  timezone text NOT NULL DEFAULT 'Asia/Manila' CHECK (timezone = 'Asia/Manila'),
  strategy_scope text NOT NULL DEFAULT 'all_registered' CHECK (strategy_scope = 'all_registered'),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_paper_profiles_updated BEFORE UPDATE ON public.paper_trading_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.paper_trading_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.paper_trading_profiles TO authenticated;
GRANT ALL ON public.paper_trading_profiles TO service_role;
CREATE POLICY "own paper profile select" ON public.paper_trading_profiles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- --- paper_worker_health (singleton, bounded non-secret fields) --------------
CREATE TABLE public.paper_worker_health (
  id text PRIMARY KEY DEFAULT 'xauusd' CHECK (id = 'xauusd'),
  provider text NOT NULL,
  instrument text NOT NULL,
  ok boolean NOT NULL,
  code text NOT NULL,
  checked_at timestamptz NOT NULL,
  quote_provider_time timestamptz,
  quote_age_ms integer,
  spread numeric(18,6),
  detail jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE public.paper_worker_health ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.paper_worker_health TO authenticated;
GRANT ALL ON public.paper_worker_health TO service_role;
CREATE POLICY "worker health read" ON public.paper_worker_health
  FOR SELECT TO authenticated USING (true);

-- --- scan_runs ---------------------------------------------------------------
CREATE TABLE public.scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scan_fingerprint text NOT NULL,
  symbol text NOT NULL CHECK (symbol = 'XAUUSD'),
  timeframe text NOT NULL,
  candle_closed_at timestamptz NOT NULL,
  scan_mode public.trader_profile NOT NULL,
  engine_version text NOT NULL,
  policy_version text NOT NULL,
  status public.paper_scan_status NOT NULL,
  lease_expires_at timestamptz,
  quality_result jsonb NOT NULL DEFAULT '{}',
  engine_accounting jsonb NOT NULL DEFAULT '{}',
  error_code text,
  error_detail text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scan_runs_fingerprint_uidx ON public.scan_runs (scan_fingerprint);
CREATE TRIGGER trg_scan_runs_updated BEFORE UPDATE ON public.scan_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.scan_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.scan_runs TO authenticated;
GRANT ALL ON public.scan_runs TO service_role;
CREATE POLICY "own scan runs select" ON public.scan_runs
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- --- market_snapshots (worker-shared; clients cannot read raw snapshots) -----
CREATE TABLE public.market_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider = 'OANDA_V20_PRACTICE'),
  instrument text NOT NULL CHECK (instrument = 'XAU_USD'),
  timeframe text NOT NULL,
  candle_closed_at timestamptz NOT NULL,
  bid numeric(18,6),
  ask numeric(18,6),
  provider_time timestamptz,
  received_at timestamptz,
  candles jsonb NOT NULL,
  content_hash text NOT NULL UNIQUE,
  quality_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.market_snapshots ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.market_snapshots TO service_role;
-- Deliberately no authenticated grant: clients only ever see signal rows.

-- --- signal_market_snapshots -------------------------------------------------
CREATE TABLE public.signal_market_snapshots (
  signal_id uuid NOT NULL REFERENCES public.signals(id) ON DELETE RESTRICT,
  market_snapshot_id uuid NOT NULL REFERENCES public.market_snapshots(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('entry', 'mtf_direction')),
  PRIMARY KEY (signal_id, market_snapshot_id, role)
);
ALTER TABLE public.signal_market_snapshots ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.signal_market_snapshots TO service_role;
-- No authenticated grant: this link table is worker-internal.

-- --- paper_trades ------------------------------------------------------------
CREATE TABLE public.paper_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id uuid NOT NULL REFERENCES public.signals(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL CHECK (symbol = 'XAUUSD'),
  lot_size numeric(4,2) NOT NULL CHECK (lot_size = 0.01),
  direction public.signal_direction NOT NULL,
  timeframe text NOT NULL,
  state public.paper_trade_state NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  planned_entry numeric(18,6) NOT NULL,
  stop_loss numeric(18,6) NOT NULL,
  take_profit_1 numeric(18,6) NOT NULL,
  take_profit_2 numeric(18,6) NOT NULL,
  expires_at timestamptz NOT NULL,
  entry_price numeric(18,6),
  exit_price numeric(18,6),
  entry_time timestamptz,
  exit_time timestamptz,
  tp1_armed_at timestamptz,
  last_observed_at timestamptz,
  result_r numeric,
  mae_r numeric,
  mfe_r numeric,
  bars_held integer NOT NULL DEFAULT 0,
  ambiguous_intrabar boolean NOT NULL DEFAULT false,
  execution_policy_version text NOT NULL CHECK (execution_policy_version = 'b_single_v1'),
  instrument_spec_version text NOT NULL CHECK (instrument_spec_version = 'xauusd_0_01_lot_v1'),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paper_trades_directional_levels CHECK (
    (direction = 'long'
      AND stop_loss < planned_entry AND planned_entry < take_profit_1 AND take_profit_1 < take_profit_2)
    OR
    (direction = 'short'
      AND stop_loss > planned_entry AND planned_entry > take_profit_1 AND take_profit_1 > take_profit_2)
  )
);
CREATE UNIQUE INDEX paper_trades_signal_uidx ON public.paper_trades (signal_id);
CREATE TRIGGER trg_paper_trades_updated BEFORE UPDATE ON public.paper_trades
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.paper_trades TO authenticated;
GRANT ALL ON public.paper_trades TO service_role;
CREATE POLICY "own paper trades select" ON public.paper_trades
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- --- paper_trade_events (append-only ledger) ---------------------------------
CREATE TABLE public.paper_trade_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_trade_id uuid NOT NULL REFERENCES public.paper_trades(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  event_key text NOT NULL,
  event_type text NOT NULL,
  provider_timestamp timestamptz,
  worker_timestamp timestamptz NOT NULL DEFAULT now(),
  before_state public.paper_trade_state,
  after_state public.paper_trade_state,
  evidence jsonb NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX paper_trade_event_sequence_uidx
  ON public.paper_trade_events (paper_trade_id, sequence_no);
CREATE UNIQUE INDEX paper_trade_event_key_uidx
  ON public.paper_trade_events (paper_trade_id, event_key);
ALTER TABLE public.paper_trade_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.paper_trade_events TO authenticated;
GRANT ALL ON public.paper_trade_events TO service_role;
CREATE POLICY "own paper events select" ON public.paper_trade_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- --- signals provenance links and canonical constraint -----------------------
ALTER TABLE public.signals
  ADD CONSTRAINT signals_scan_run_id_fkey
    FOREIGN KEY (scan_run_id) REFERENCES public.scan_runs(id) ON DELETE RESTRICT,
  ADD CONSTRAINT signals_market_snapshot_id_fkey
    FOREIGN KEY (market_snapshot_id) REFERENCES public.market_snapshots(id) ON DELETE RESTRICT;

-- A canonical worker signal must carry full provenance, the fixed symbol, and
-- a unique fingerprint; anything else is a forged or truncated row.
ALTER TABLE public.signals ADD CONSTRAINT signals_canonical_provenance_check CHECK (
  generated_by <> 'xauusd_paper_worker'
  OR (
    scan_run_id IS NOT NULL
    AND market_snapshot_id IS NOT NULL
    AND engine_version IS NOT NULL
    AND policy_version IS NOT NULL
    AND execution_policy_version IS NOT NULL
    AND scan_fingerprint IS NOT NULL
    AND pair = 'XAUUSD'
  )
);
CREATE UNIQUE INDEX canonical_signal_fingerprint_uidx
  ON public.signals (scan_fingerprint) WHERE scan_fingerprint IS NOT NULL;
CREATE INDEX active_signal_history_idx
  ON public.signals (user_id, created_at DESC) WHERE archived_at IS NULL;
