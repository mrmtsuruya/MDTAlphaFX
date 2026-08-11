-- Forward-only canonical RLS cutover for the XAUUSD auto-paper flow (2026-08-11).
--
-- Browser signal generation is retired (Tasks 9-10): authenticated clients must
-- no longer be able to write canonical rows. This migration drops the legacy
-- FOR ALL policies on `signals` and `signal_events`, revokes every authenticated
-- write grant, and leaves read-only own-row SELECT policies in their place.
-- Legacy rows and event ledgers are untouched: nothing here deletes or rewrites
-- data, only privileges and policies.
--
-- The worker keeps full access through the service_role grants and the
-- SECURITY DEFINER worker RPCs from 20260811010200. Profile mutation stays
-- RPC-only via set_xauusd_paper_enabled.

-- --- signals: write path closed ----------------------------------------------
DROP POLICY IF EXISTS "own signals" ON public.signals;

REVOKE INSERT ON public.signals FROM authenticated;
REVOKE UPDATE ON public.signals FROM authenticated;
REVOKE DELETE ON public.signals FROM authenticated;
-- SELECT remains for the read-only canonical history views.

CREATE POLICY "own signals select" ON public.signals
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- --- signal_events: audit ledger is read-only for authenticated --------------
DROP POLICY IF EXISTS "own signal events" ON public.signal_events;

REVOKE INSERT ON public.signal_events FROM authenticated;
REVOKE UPDATE ON public.signal_events FROM authenticated;
REVOKE DELETE ON public.signal_events FROM authenticated;
-- SELECT remains so clients can inspect their own audit trail.

CREATE POLICY "own signal events select" ON public.signal_events
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
