#!/usr/bin/env bash
# Operator runbook for deploying the weekly strategy-audit job.
#
# Stages the deployment in the safe order used by the paper worker:
#   link -> migration list -> db push -> functions deploy -> configure the
#   weekly pg_cron job (reuses the existing Vault secrets — no new secrets).
#
# Safety model (mirrors tools/deploy-xauusd-paper.sh):
#   * Default is a DRY RUN: checks everything and prints the staged plan
#     without touching anything. Pass --go to execute.
#   * The project ref in supabase/config.toml must match the live ref in
#     .env (VITE_SUPABASE_PROJECT_ID) unless --fix-config rewrites config.toml.
#   * Local database gates (bun run test:db) run before --go deploys unless
#     --skip-gates is passed.
#
# Usage:
#   tools/deploy-strategy-audit.sh              # dry-run staging plan
#   tools/deploy-strategy-audit.sh --go         # execute the plan
#   tools/deploy-strategy-audit.sh --go --fix-config
#
# Overrides:
#   SUPABASE_CMD  e.g. "npx supabase" if the CLI is not on PATH

set -euo pipefail

GO=0
FIX_CONFIG=0
SKIP_GATES=0
SUPABASE_CMD="${SUPABASE_CMD:-supabase}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --go) GO=1 ;;
    --fix-config) FIX_CONFIG=1 ;;
    --skip-gates) SKIP_GATES=1 ;;
    --dry-run) GO=0 ;;
    --help | -h) usage ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
block() { printf '  \033[31mBLOCK\033[0m %s\n' "$*"; }

env_get() { grep -E "^$1=" "$REPO_ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true; }

REF_RE='^[a-z0-9]{20}$'
LIVE_REF="$(env_get VITE_SUPABASE_PROJECT_ID)"
TOML_REF="$(grep -E '^project_id[[:space:]]*=' "$REPO_ROOT/supabase/config.toml" 2>/dev/null | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)"

echo "Strategy-audit deployment runbook"
echo "Mode: $([ "$GO" = 1 ] && echo EXECUTE || echo DRY-RUN)   Supabase CLI: $SUPABASE_CMD"
echo "--------------------------------------------------------------"

# --- 0. Local preflight (read-only) -----------------------------------------
step "Preflight: tooling, project ref, sources"
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

[ -f "$REPO_ROOT/supabase/migrations/20260814000000_strategy_audit.sql" ] \
  && ok "audit migration present" || block "20260814000000_strategy_audit.sql missing"
[ -f "$REPO_ROOT/supabase/functions/xauusd-strategy-audit/index.ts" ] \
  && ok "audit edge function present" || block "supabase/functions/xauusd-strategy-audit missing"

HARD_BLOCK=0
if [ -z "$LIVE_REF" ] || ! command -v "$SUPABASE_BIN" >/dev/null 2>&1; then
  HARD_BLOCK=1
fi

# --- 1. Local gates ----------------------------------------------------------
step "Local gates"
if [ "$SKIP_GATES" = 1 ]; then
  warn "skipping local gates (--skip-gates)"
elif command -v bun >/dev/null 2>&1 || [ -x "$REPO_ROOT/node_modules/.bin/vite" ]; then
  ok "pgTAP suite: bun tools/pgtap-run.mjs 008"
  if [ "$GO" = 1 ]; then
    (cd "$REPO_ROOT" && bun tools/pgtap-run.mjs 008) || { block "pgTAP 008 failed"; HARD_BLOCK=1; }
  fi
else
  warn "bun not found — run 'bun tools/pgtap-run.mjs 008' manually before --go"
fi

# --- 2. Staged plan ----------------------------------------------------------
step "Staged deployment plan"
cat <<'PLAN'
  1. supabase link --project-ref <live ref>       (fixes config.toml with --fix-config)
  2. supabase migration list                      (confirm pending migrations)
  3. supabase db push --dry-run                   (preview: strategy_audit_runs + weekly RPC)
  4. supabase db push                             (apply the audit migration)
  5. supabase functions deploy xauusd-strategy-audit
  6. select configure_strategy_audit_weekly_job(); (service-role; fails closed without
                                                     project_url/publishable_key/
                                                     xauusd_worker_cron_secret in Vault —
                                                     reuses the paper worker's secrets)
  7. Verify: 'xauusd-strategy-audit' in cron.job; invoke the function once manually
     (curl -X POST .../functions/v1/xauusd-strategy-audit -H 'x-worker-secret: ...') and
     check strategy_audit_runs rows in the dashboard
PLAN

if [ "$GO" = 1 ] && [ "$HARD_BLOCK" = 1 ]; then
  echo >&2
  echo "Refusing to execute with failing preflight checks." >&2
  exit 1
fi
if [ "$GO" = 0 ]; then
  echo
  echo "Dry run complete — nothing was touched. Re-run with --go to execute."
  exit 0
fi

# --- 3. Execute --------------------------------------------------------------
step "1/4 link"
if [ "$FIX_CONFIG" = 1 ]; then
  "$SUPABASE_CMD" link --project-ref "$LIVE_REF" --fix-config
else
  "$SUPABASE_CMD" link --project-ref "$LIVE_REF"
fi
ok "linked to $LIVE_REF"

step "2/4 migration list"
"$SUPABASE_CMD" migration list || true

step "3/4 push migrations"
"$SUPABASE_CMD" db push --dry-run
"$SUPABASE_CMD" db push
ok "migrations applied (20260814000000_strategy_audit)"

step "4/4 deploy the audit function"
"$SUPABASE_CMD" functions deploy xauusd-strategy-audit
ok "deployed"

cat <<'DONE'

Deployed. Final operator steps (SQL editor, service role):
  select public.configure_strategy_audit_weekly_job();
  -- expect 'scheduled:<jobid>'; re-run is idempotent.

The weekly job fires every Monday 04:00 server-local. To run an audit
immediately (instead of waiting), POST to the function with the secret:
  curl -X POST \
    https://<project>.supabase.co/functions/v1/xauusd-strategy-audit \
    -H 'x-worker-secret: <XAUUSD_WORKER_CRON_SECRET>'
Rows land in public.strategy_audit_runs (owner-scoped; the Strategies page
shows them under the PAPER LEDGER HEALTH section).
DONE
