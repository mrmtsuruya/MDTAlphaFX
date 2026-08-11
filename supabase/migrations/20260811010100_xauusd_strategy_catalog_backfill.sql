-- Complete the strategy catalog to match the engine's 36 implemented IDs
-- (2026-08-11). The previous catalog refresh added 3 strategies and the
-- engine grew the five reversal/exhaustion detectors below; the catalog must
-- contain every ID the auto-paper worker's `resolveEnabledPaperStrategies`
-- checks against, or the worker refuses to emit canonical signals
-- (`strategy_catalog_drift`). Metadata mirrors IMPLEMENTED_STRATEGIES in
-- src/lib/signal-engine.ts exactly.

INSERT INTO public.strategies (id, name, category, description, default_params, timeframes) VALUES
('rsi_divergence', 'RSI Divergence', 'momentum',
 'Regular RSI14 divergence against the two most recent swing extremes, fresh and with a reclaim already underway.',
 '{}', ARRAY['M5','M15','M30','H1','H4','D1']),
('macd_divergence', 'MACD Divergence', 'momentum',
 'Regular divergence between price swing extremes and the raw MACD line (not the histogram) on the far side of the zero line.',
 '{}', ARRAY['M15','M30','H1','H4','D1']),
('climax_exhaustion', 'Climax Exhaustion', 'volatility',
 'Top-decile range bar on a fresh 20-bar extreme that closes back against itself — the blow-off bar at the end of a leg.',
 '{}', ARRAY['M1','M5','M15','M30','H1','H4','D1']),
('stop_run_reversal', 'Stop Run Reversal', 'orderflow',
 'A 20-bar extreme swept, then the next bar closes back inside it on a real body — the confirmed two-bar sibling of liquidity_sweep.',
 '{}', ARRAY['M1','M5','M15','M30','H1','H4']),
('failed_breakout', 'Failed Breakout', 'mean_reversion',
 'A break of the prior 20-bar range that closes back inside within 10 bars, trapping the breakout traders.',
 '{}', ARRAY['M5','M15','M30','H1','H4','D1'])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  default_params = EXCLUDED.default_params,
  timeframes = EXCLUDED.timeframes;

-- Enable the five for every existing user only when absent; new users get
-- them by default via the "no settings row -> all strategies" fallback.
INSERT INTO public.strategy_settings (user_id, strategy_id, enabled)
SELECT u.id, s.id, true
FROM auth.users u
CROSS JOIN public.strategies s
WHERE s.id IN ('rsi_divergence', 'macd_divergence', 'climax_exhaustion', 'stop_run_reversal', 'failed_breakout')
  AND NOT EXISTS (
    SELECT 1 FROM public.strategy_settings ss
    WHERE ss.user_id = u.id AND ss.strategy_id = s.id
  );
