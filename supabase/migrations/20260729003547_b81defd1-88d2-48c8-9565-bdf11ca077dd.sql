
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
-- Keep authenticated EXECUTE on has_role so RLS policies can call it via auth.uid()
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
