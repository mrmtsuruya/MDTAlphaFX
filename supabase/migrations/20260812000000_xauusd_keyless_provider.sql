-- XAUUSD auto-paper: allow the keyless TradingView/OANDA feed provider (2026-08-12).
--
-- The worker no longer requires an OANDA practice account: prices come from the
-- same free TradingView scanner feed the dashboard quote strip uses (OANDA's
-- retail XAUUSD feed, no API key), with two-sided candles synthesized from
-- Yahoo OHLC plus the live spread. The OANDA value stays valid for any rows
-- written before this cutover.

ALTER TABLE public.market_snapshots
  DROP CONSTRAINT IF EXISTS market_snapshots_provider_check;

ALTER TABLE public.market_snapshots
  ADD CONSTRAINT market_snapshots_provider_check
  CHECK (provider IN ('OANDA_V20_PRACTICE', 'TV_OANDA_FEED'));
