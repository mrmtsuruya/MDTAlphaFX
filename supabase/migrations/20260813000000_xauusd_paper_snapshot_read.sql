-- XAUUSD auto-paper: let the authenticated Signal Center read its own
-- signals' market snapshots (2026-08-13).
--
-- The canonical Task 9 read API (listXauusdPaperSignals) embeds the signal's
-- own market snapshot (provider/instrument/provider_time) so the mapper can
-- fail closed on provenance. The original schema deliberately gave
-- authenticated users no SELECT on `market_snapshots` (shared, content-hash
-- deduped rows), which made the embed resolve to NULL under RLS the moment
-- real paper signals existed: every canonical row then failed the mapper's
-- "no provider snapshot" check and the Signal Center history 500'd.
--
-- This grants read access ONLY to snapshots referenced by the requesting
-- user's own signals (via the canonical signals.market_snapshot_id FK).
-- Worker-owned snapshots not attached to a user's signal remain invisible to
-- that user, and the many-to-many signal_market_snapshots table stays
-- unreadable to authenticated (the entry snapshot is the FK one).

GRANT SELECT ON public.market_snapshots TO authenticated;

CREATE POLICY "own signal snapshots select" ON public.market_snapshots
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.signals s
      WHERE s.market_snapshot_id = market_snapshots.id
        AND s.user_id = auth.uid()
    )
  );
