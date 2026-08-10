-- Complete the strategy catalog: every catalog entry now has an engine
-- evaluator (2026-08-07).
--
-- The 5 previously "CATALOG_ONLY" strategies now have real evaluators in
-- src/lib/signal-engine.ts:
--   - gartley / bat_pattern / butterfly_pattern: XABCD harmonic detection
--     (swing zigzag + canonical Fibonacci ratio validation).
--   - news_reactive: directional momentum vote while a high-impact release for
--     one of the pair's currencies is imminent (calendar overlay).
--   - ai_confluence: CFTC COT positioning overlay, boosted by an imminent
--     high-impact catalyst.
-- This migration refreshes their catalog definitions to match the evaluators
-- and enables them (default) for existing users.

-- --- Harmonize the 5 now-implemented strategies -----------------------------
UPDATE public.strategies SET
  description = 'Ratio-validated Gartley (D at 0.786 of XA): pullback to the potential reversal zone with a rejection close.',
  timeframes = ARRAY['H1','H4']
WHERE id = 'gartley';

UPDATE public.strategies SET
  description = 'Ratio-validated Bat (D at 0.886 of XA): deep pullback to the potential reversal zone with a rejection close.',
  timeframes = ARRAY['H1','H4']
WHERE id = 'bat_pattern';

UPDATE public.strategies SET
  description = 'Ratio-validated Butterfly (D at 1.27 of XA, beyond X): extended sweep into the potential reversal zone.',
  timeframes = ARRAY['H1','H4']
WHERE id = 'butterfly_pattern';

UPDATE public.strategies SET
  description = 'Bias from directional momentum only while a high-impact release for one of the pair''s currencies is imminent.',
  timeframes = ARRAY['M15','H1','H4']
WHERE id = 'news_reactive';

UPDATE public.strategies SET
  description = 'Positioning overlay: votes with CFTC COT net positioning when strongly tilted, boosted by an imminent catalyst.',
  timeframes = ARRAY['M15','H1','H4']
WHERE id = 'ai_confluence';

-- --- Enable the newly implemented strategies for existing users --------------
-- New users get them by default via the "no settings row -> all strategies"
-- fallback.
INSERT INTO public.strategy_settings (user_id, strategy_id, enabled)
SELECT u.id, s.id, true
FROM auth.users u
CROSS JOIN public.strategies s
WHERE s.id IN ('gartley', 'bat_pattern', 'butterfly_pattern', 'news_reactive', 'ai_confluence')
  AND NOT EXISTS (
    SELECT 1 FROM public.strategy_settings ss
    WHERE ss.user_id = u.id AND ss.strategy_id = s.id
  );
