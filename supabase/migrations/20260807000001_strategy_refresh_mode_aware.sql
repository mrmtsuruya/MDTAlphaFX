-- Strategy catalog refresh for the mode-aware engine (2026-08-07).
--
-- The engine now evaluates strategies differently per trader mode (scalper
-- tuning on M1-M30, intraday tuning on H1+). This migration:
--   1. Adds 3 new engine strategies (opening_range_breakout, heiken_ashi_scalp,
--      qullamaggie_breakout).
--   2. Brings the 4 previously catalog-only strategies (ny_killzone, asian_range,
--      trendline_break, fib_retracement) into engine compatibility by matching
--      their definitions to the implemented evaluators.
--   3. Refreshes stale timeframes/descriptions on classic strategies so the
--      Strategies page matches the engine's capability table.

-- --- New engine strategies ------------------------------------------------
INSERT INTO public.strategies (id, name, category, description, default_params, timeframes) VALUES
('opening_range_breakout', 'Opening Range Breakout', 'breakout',
 'Break of the first two candles after a session open (London/NY/Asia) with range-expansion confirmation.',
 '{}', ARRAY['M1','M5','M15','M30']),
('heiken_ashi_scalp', 'Heiken Ashi Scalp', 'trend',
 'Three consecutive green/red Heiken Ashi candles above/below EMA21 with no meaningful wick.',
 '{}', ARRAY['M1','M5','M15','M30']),
('qullamaggie_breakout', 'Qullamaggie Breakout', 'breakout',
 'Qullamaggie-style: price above EMA50, ATR compression, close beyond the prior 20-bar range with volume expansion.',
 '{}', ARRAY['M5','M15','M30','H1'])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  default_params = EXCLUDED.default_params,
  timeframes = EXCLUDED.timeframes;

-- --- Previously catalog-only strategies now engine-ready --------------------
UPDATE public.strategies SET
  description = 'Bias formed inside the New York 12:00-15:00 UTC session.',
  timeframes = ARRAY['M1','M5','M15','M30','H1']
WHERE id = 'ny_killzone';

UPDATE public.strategies SET
  description = 'Break of the Asian-session range (22:00-07:00 UTC) on the London open.',
  timeframes = ARRAY['M1','M5','M15','M30','H1']
WHERE id = 'asian_range';

UPDATE public.strategies SET
  description = 'Least-squares swing trendline broken with a retest-and-hold close beyond it.',
  timeframes = ARRAY['M5','M15','M30','H1','H4']
WHERE id = 'trendline_break';

UPDATE public.strategies SET
  description = 'Pullback into the 0.5-0.618 zone of the dominant swing leg with a rejection close.',
  timeframes = ARRAY['M5','M15','M30','H1','H4']
WHERE id = 'fib_retracement';

-- --- Refresh stale classic strategies ---------------------------------------
UPDATE public.strategies SET
  description = 'Fast/slow EMA slope + price above/below the stack; scalper mode needs less separation, intraday more.',
  timeframes = ARRAY['M1','M5','M15','M30','H1','H4','D1']
WHERE id = 'ema_trend';

UPDATE public.strategies SET
  description = 'ATR-based directional flip (2x band on intraday, 3x on scalps).',
  timeframes = ARRAY['M5','M15','M30','H1','H4']
WHERE id = 'supertrend';

UPDATE public.strategies SET
  description = 'Fan of EMAs; compression + expansion trigger on swing timeframes.',
  timeframes = ARRAY['H1','H4','D1']
WHERE id = 'ma_ribbon';

UPDATE public.strategies SET
  description = 'Price relative to Kumo, Tenkan/Kijun cross, Chikou confirmation on swing timeframes.',
  timeframes = ARRAY['H1','H4','D1']
WHERE id = 'ichimoku';

UPDATE public.strategies SET
  description = 'RSI momentum with directional close confirmation.',
  timeframes = ARRAY['M1','M5','M15','M30','H1','H4','D1']
WHERE id = 'rsi_momo';

UPDATE public.strategies SET
  description = 'MACD 12/26/9 histogram sign with continued expansion.',
  timeframes = ARRAY['M1','M5','M15','M30','H1','H4','D1']
WHERE id = 'macd_hist';

UPDATE public.strategies SET
  description = 'Stochastic RSI OB/OS exit (20/80 scalp, 15/85 intraday).',
  timeframes = ARRAY['M1','M5','M15','M30']
WHERE id = 'stoch_rsi';

UPDATE public.strategies SET
  description = 'Fade CCI20 extremes with re-entry through the +/-100 level.',
  timeframes = ARRAY['M15','M30','H1','H4']
WHERE id = 'cci_extreme';

UPDATE public.strategies SET
  description = 'Squeeze release with ATR expansion (1.25 ATR scalp / 1 ATR intraday).',
  timeframes = ARRAY['M1','M5','M15','M30','H1']
WHERE id = 'bollinger_squeeze';

UPDATE public.strategies SET
  description = 'ATR-channel break with momentum confirm.',
  timeframes = ARRAY['M5','M15','M30','H1','H4']
WHERE id = 'keltner_break';

UPDATE public.strategies SET
  description = 'Classic 20-period high/low break.',
  timeframes = ARRAY['M1','M5','M15','M30','H1','H4','D1']
WHERE id = 'donchian_break';

UPDATE public.strategies SET
  description = 'Directional impulse on ATR ratio expansion (1.5 ATR scalp / 1.25 intraday).',
  timeframes = ARRAY['M1','M5','M15','M30','H1','H4','D1']
WHERE id = 'atr_expansion';

UPDATE public.strategies SET
  description = 'Distance from session VWAP > 1.2 ATR (scalp) / 1.5 ATR (intraday), fading back.',
  timeframes = ARRAY['M1','M5','M15','M30']
WHERE id = 'vwap_mean_rev';

UPDATE public.strategies SET
  description = 'Bullish/bearish ICT order block retest with imbalance fill.',
  timeframes = ARRAY['M5','M15','M30','H1','H4']
WHERE id = 'order_block';

UPDATE public.strategies SET
  description = 'Imbalance zone retest.',
  timeframes = ARRAY['M1','M5','M15','M30','H1']
WHERE id = 'fvg';

UPDATE public.strategies SET
  description = 'Sweep of prior swing high/low then reversal.',
  timeframes = ARRAY['M1','M5','M15','M30','H1']
WHERE id = 'liquidity_sweep';

UPDATE public.strategies SET
  description = 'Break of structure / change of character detection.',
  timeframes = ARRAY['M1','M5','M15','M30','H1']
WHERE id = 'bos_choch';

UPDATE public.strategies SET
  description = 'Multi-touch horizontal levels with tolerance.',
  timeframes = ARRAY['H1','H4','D1']
WHERE id = 'sr_confluence';

UPDATE public.strategies SET
  description = 'Bias formed inside the London 07:00-10:00 UTC session.',
  timeframes = ARRAY['M1','M5','M15','M30','H1']
WHERE id = 'london_killzone';

-- --- Per-user settings for the new engine strategies ------------------------
-- Strategy settings are per-user; inserting for existing users so the new
-- strategies are enabled out of the box. New users get them by default via the
-- "no settings row -> all strategies" fallback.
INSERT INTO public.strategy_settings (user_id, strategy_id, enabled)
SELECT u.id, s.id, true
FROM auth.users u
CROSS JOIN public.strategies s
WHERE s.id IN ('opening_range_breakout', 'heiken_ashi_scalp', 'qullamaggie_breakout')
  AND NOT EXISTS (
    SELECT 1 FROM public.strategy_settings ss
    WHERE ss.user_id = u.id AND ss.strategy_id = s.id
  );
