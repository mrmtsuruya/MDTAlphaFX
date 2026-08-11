#!/usr/bin/env bash
# Operator runbook for deploying the XAUUSD auto-paper worker (Tasks 6-11).
#
# Stages the deployment in the safe order from HANDOFF.md:
#   link -> migration list -> db push (--dry-run, then real) -> functions deploy
#   -> secrets set -> Vault create_secret -> configure_xauusd_paper_minute_job
#
# Safety model:
#   * The default is a DRY RUN: it checks everything and prints the staged plan
#     without touching anything, local or remote. Pass --go to execute.
#   * The first gate compares the project ref in supabase/config.toml against
#     the live ref in .env (VITE_SUPABASE_PROJECT_ID) and refuses to link
#     against a different project unless --fix-config rewrites config.toml.
#   * Secret VALUES are never printed. The Edge secrets file is only handed to
#     `supabase secrets set --env-file`. The Vault SQL is written to a 0600
#     file in the OS temp dir; only its path is printed.
#   * Local database gates (bun run test:db) run before --go deploys unless
#     --skip-gates is passed.
#
# Usage:
#   tools/deploy-xauusd-paper.sh                # dry-run staging plan
#   tools/deploy-xauusd-paper.sh --go           # execute the plan
#   tools/deploy-xauusd-paper.sh --go --fix-config
#   tools/deploy-xauusd-paper.sh --secrets-file "$HOME/paper-secrets.env"
#
# Overrides:
#   SUPABASE_CMD  e.g. "npx supabase" if the CLI is not on PATH
#   XAUUSD_SECRETS_FILE  same as --secrets-file

set -euo pipefail

GO=0
FIX_CONFIG=0
SKIP_GATES=0
SECRETS_FILE="${XAUUSD_SECRETS_FILE:-}"
SUPABASE_CMD="${SUPABASE_CMD:-supabase}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${TMPDIR:-/tmp}"

usage() {
  sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --go) GO=1 ;;
    --fix-config) FIX_CONFIG=1 ;;
    --skip-gates) SKIP_GATES=1 ;;
    --dry-run) GO=0 ;;
    --secrets-file) ;;
    --secrets-file=*) SECRETS_FILE="${arg#*=}" ;;
    --help | -h) usage ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done
if [ -z "$SECRETS_FILE" ]; then
  SECRETS_FILE="${XAUUSD_SECRETS_FILE:-$TMP/xauusd-paper-secrets.env}"
fi

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
block() { printf '  \033[31mBLOCK\033[0m %s\n' "$*"; }

env_get() { grep -E "^$1=" "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true; }

REF_RE='^[a-z0-9]{20}$'
LIVE_REF="$(env_get VITE_SUPABASE_PROJECT_ID)"
LIVE_URL="$(env_get VITE_SUPABASE_URL)"
PUBLISHABLE="$(env_get VITE_SUPABASE_PUBLISHABLE_KEY)"
TOML_REF="$(grep -E '^project_id[[:space:]]*=' "$REPO_ROOT/supabase/config.toml" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)"

echo "XAUUSD Auto-Paper deployment runbook"
echo "Mode: $([ "$GO" = 1 ] && echo EXECUTE || echo DRY-RUN)   Supabase CLI: $SUPABASE_CMD"
echo "--------------------------------------------------------------"

# --- 0. Local preflight (read-only) -----------------------------------------
step "Preflight: tooling, project ref, credentials"
[ -f "$REPO_ROOT/.env" ] && ok ".env present" || block ".env missing at $REPO_ROOT/.env"
[ -f "$REPO_ROOT/supabase/config.toml" ] && ok "config.toml present" || block "config.toml missing"

SUPABASE_BIN="${SUPABASE_CMD%% *}"
if ! command -v "$SUPABASE_BIN" >/dev/null 2>&1; then
  block "Supabase CLI not found ('$SUPABASE_BIN'). Install it or set SUPABASE_CMD='npx supabase'."
else
  ok "Supabase CLI found ($SUPABASE_CMD)"
fi

if [ -z "$LIVE_REF" ] || ! [[ "$LIVE_REF" =~ $REF_RE ]]; then
  block "no valid VITE_SUPABASE_PROJECT_ID in .env (got '${LIVE_REF:-<empty>}')"
  LIVE_REF=""
elif [ -z "$TOML_REF" ]; then
  block "no project_id in supabase/config.toml"
elif [ "$TOML_REF" != "$LIVE_REF" ]; then
  block "project ref mismatch: config.toml=$TOML_REF vs .env=$LIVE_REF"
  warn  "the live project (.env) is authoritative; re-run with --fix-config (--go) to rewrite config.toml"
else
  ok "project refs agree: $LIVE_REF"
fi

[ -n "${SUPABASE_ACCESS_TOKEN:-}" ] && ok "SUPABASE_ACCESS_TOKEN set" \
  || warn "SUPABASE_ACCESS_TOKEN not set (needed for link; run 'supabase login' or export it)"

MISSING_SECRETS=""
for name in OANDA_ACCOUNT_ID OANDA_API_TOKEN XAUUSD_WORKER_CRON_SECRET; do
  grep -qE "^$name=.+" "$SECRETS_FILE" 2>/dev/null || MISSING_SECRETS="$MISSING_SECRETS $name"
done
if [ -f "$SECRETS_FILE" ]; then
  ok "secrets file present: $SECRETS_FILE"
  [ -n "$MISSING_SECRETS" ] && block "secrets file missing entries:$MISSING_SECRETS"
else
  block "secrets file not found: $SECRETS_FILE (create it with OANDA_ACCOUNT_ID, OANDA_API_TOKEN, XAUUSD_WORKER_CRON_SECRET; keep it outside the repo)"
fi

[ -d "$REPO_ROOT/supabase/functions/xauusd-paper-worker" ] \
  && ok "worker edge function present" || block "supabase/functions/xauusd-paper-worker missing"

HARD_BLOCK=0
if [ -z "$LIVE_REF" ] || ! command -v "$SUPABASE_BIN" >/dev/null 2>&1 \
   || [ ! -f "$SECRETS_FILE" ] || [ -n "$MISSING_SECRETS" ]; then
  HARD_BLOCK=1
fi

# --- 1. Staged plan ----------------------------------------------------------
step "Staged deployment plan (safe order, HANDOFF.md)"
cat <<'PLAN'
  1. supabase link --project-ref <live ref>        (fixes config.toml with --fix-config)
  2. supabase migration list                        (confirm pending migrations)
  3. supabase db push --dry-run                     (preview: Tasks 6, 7, 11 cutover + cron)
  4. supabase db push                               (apply migrations)
  5. supabase functions deploy xauusd-paper-worker  (deploy the Deno worker)
  6. supabase secrets set --env-file <secrets file> (OANDA_ACCOUNT_ID, OANDA_API_TOKEN, XAUUSD_WORKER_CRON_SECRET)
  7. Vault: vault.create_secret for project_url, publishable_key, xauusd_worker_cron_secret
  8. select configure_xauusd_paper_minute_job();    (service-role; fails closed without Vault secrets)
  9. Verify: worker health row, minute job in cron.job, enable profile in the UI
PLAN

if [ "$GO" = 1 ] && [ "$HARD_BLOCK" = 1 ]; then
  echo >&2
  echo "BLOCKED: resolve the preflight failures above, then re-run with --go." >&2
  exit 1
fi
if [ "$GO" = 0 ]; then
  echo
  echo "Dry run complete — nothing was changed. Re-run with --go to execute the plan."
  exit 0
fi

# --- 2. Execute --------------------------------------------------------------
if [ "$FIX_CONFIG" = 1 ] && [ -n "$LIVE_REF" ] && [ "$TOML_REF" != "$LIVE_REF" ]; then
  step "Fixing project ref in supabase/config.toml"
  sed -i -E "s/^project_id[[:space:]]*=.*/project_id = \"$LIVE_REF\"/" "$REPO_ROOT/supabase/config.toml"
  ok "project_id now $LIVE_REF"
fi

if [ "$SKIP_GATES" = 0 ] && command -v bun >/dev/null 2>&1; then
  step "Local database gates"
  (cd "$REPO_ROOT" && bun run test:db)
  ok "bun run test:db passed"
fi

step "1. Link"
"$SUPABASE_CMD" link --project-ref "$LIVE_REF"

step "2. Migration list"
"$SUPABASE_CMD" migration list

step "3. db push --dry-run"
"$SUPABASE_CMD" db push --dry-run

step "4. db push"
"$SUPABASE_CMD" db push

step "5. Deploy worker edge function"
"$SUPABASE_CMD" functions deploy xauusd-paper-worker

step "6. Set Edge secrets"
"$SUPABASE_CMD" secrets set --env-file "$SECRETS_FILE"

step "7. Stage Vault secrets (SQL written to a 0600 file — paste into the SQL editor)"
VAULT_SQL="$TMP/xauusd-paper-vault.sql"
WORKER_SECRET="$(grep -E '^XAUUSD_WORKER_CRON_SECRET=.+' "$SECRETS_FILE" | head -1 | cut -d= -f2-)"
{
  echo "-- XAUUSD auto-paper Vault secrets (generated by tools/deploy-xauusd-paper.sh)"
  echo "select vault.create_secret('$LIVE_URL', 'project_url', 'XAUUSD worker project URL');"
  echo "select vault.create_secret('$PUBLISHABLE', 'publishable_key', 'XAUUSD worker apikey header');"
  echo "select vault.create_secret('$WORKER_SECRET', 'xauusd_worker_cron_secret', 'XAUUSD worker cron auth');"
} > "$VAULT_SQL"
chmod 600 "$VAULT_SQL"
ok "Vault SQL staged at $VAULT_SQL (values NOT printed here; delete the file after use)"

cat <<'POST'
  Then, in the SQL editor (or as service role), run:
    select public.configure_xauusd_paper_minute_job();
  It returns scheduled:<jobid>; it raises worker_secrets_missing until all
  three Vault secrets exist. The xauusd-paper-minute cron job then posts to
  the worker every minute. The daily archive job (5 16 * * *) was already
  scheduled by the 20260811030000 migration.
POST

step "9. Post-deploy verification"
cat <<'POST'
  - Worker health: open the Dashboard -> XAUUSD Auto-Paper panel; WORKER_STANDBY
    clears once a run reports (worker_record_xauusd_health).
  - Minute job:  select jobid, jobname, schedule, active from cron.job;
  - Signals: after the next closed M1 candle, RECENT_PAPER_SIGNALS and the
    Signal Center show canonical rows, or the scan shows evaluated/abstained
    accounting without a fabricated trade.
  - Enable the profile: flip the panel toggle (set_xauusd_paper_enabled, the
    single authenticated RPC; requires a healthy provider check).
POST

echo
echo "Deployment staged and executed. Final activation state: see HANDOFF.md —"
echo "it is NOT LIVE until migration + worker + cron config + provider health"
echo "and profile enablement have all succeeded."
