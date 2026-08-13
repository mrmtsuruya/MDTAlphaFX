-- Strategy multiplier promotion ledger (2026-08-15).
--
-- Replaces the "candidates for review — nothing is applied to live weights"
-- disclaimer with a real pipeline: an approved candidate's trust multiplier
-- is recorded here and applied to the walk-forward weights the live worker
-- scans with (paper-scan-orchestration.ts multiplies by the active
-- multiplier, clamped to 0.15..1.35).
--
-- The ledger IS the state: the latest row per (user, strategy, mode) wins —
-- action 'approve' activates its multiplier, 'revert' clears it back to 1.
-- No separate applied flag to drift. Approval gates are enforced server-side
-- in the promote_strategy_multiplier path (minimum samples, verdict, and
-- walk-forward validation) — the table itself records what was decided.

CREATE TABLE public.strategy_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id text NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('intraday', 'scalper')),
  action text NOT NULL CHECK (action IN ('approve', 'revert')),
  multiplier numeric(5,2) NOT NULL CHECK (multiplier BETWEEN 0.15 AND 1.35),
  resolved_samples integer NOT NULL CHECK (resolved_samples >= 0),
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  total_r numeric(10,4) NOT NULL DEFAULT 0,
  verdict text NOT NULL CHECK (verdict IN ('boost', 'cool', 'hold', 'insufficient', 'n/a')),
  walk_weight numeric(5,2),
  walk_accuracy numeric(5,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE INDEX strategy_promotions_lookup_idx
  ON public.strategy_promotions (user_id, strategy_id, mode, created_at DESC);
GRANT SELECT, INSERT ON public.strategy_promotions TO authenticated;
GRANT ALL ON public.strategy_promotions TO service_role;
ALTER TABLE public.strategy_promotions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own promotions" ON public.strategy_promotions
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
