// Detects Supabase/PostgREST errors that mean "the paper schema is missing",
// so the authenticated UI can show the MIGRATION_REQUIRED state instead of
// crashing.
//
// supabase-js surfaces PostgREST failures as plain objects
// ({ code, message, details, hint }) — NOT Error instances — and the stable
// discriminator lives in `code`, not `message`: a PGRST205 response's message
// is "Could not find the table 'public.X' in the schema cache", which never
// contains the code. Verified against the live pre-deploy project on
// 2026-08-12: paper_trading_profiles, scan_runs and paper_worker_health all
// return exactly that shape (HTTP 404).
//
// The code family covers every way the schema cache can predate the paper
// migrations:
//   - PGRST205  table missing from the schema cache
//   - PGRST204  column missing (e.g. signals.contributing_strategies)
//   - PGRST200  relationship missing (embedded paper_trades/scan_runs/...)
//   - PGRST202  function missing (e.g. set_xauusd_paper_enabled)
//   - 42P01     Postgres "relation does not exist"
// The message-substring checks remain as a defensive fallback for exotic
// re-wraps (an Error whose message embeds the code).

const MIGRATION_ARTIFACT_CODES = new Set(["42P01", "PGRST205", "PGRST204", "PGRST200", "PGRST202"]);

export function isMissingSchemaError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && MIGRATION_ARTIFACT_CODES.has(code)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  for (const code of MIGRATION_ARTIFACT_CODES) {
    if (message.includes(code)) return true;
  }
  return false;
}
