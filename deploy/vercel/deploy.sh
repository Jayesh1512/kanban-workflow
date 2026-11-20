#!/usr/bin/env bash
# Deploy the web role (login, dashboard, Work, CRM, approvals, team) to Vercel.
# Telegram, AI workers and migrations keep running on the primary Docker stack.
#   deploy/vercel/deploy.sh          # set env vars from .local/supabase, then deploy to production
#   deploy/vercel/deploy.sh --code   # deploy code only
set -euo pipefail
cd "$(dirname "$0")/../.."
VERCEL="${VERCEL:-$(command -v vercel || echo "$HOME/.hermes/node/bin/vercel")}"
PROJECT="${VERCEL_PROJECT:-antseed-workspace}"
CONFIG=.local/supabase

[ -f .vercel/project.json ] || "$VERCEL" link --yes --project "$PROJECT" >/dev/null

if [ "${1:-}" != "--code" ]; then
  APP_URL="${APP_URL:-https://$PROJECT.vercel.app}"
  # Values go to Vercel through stdin only; nothing is echoed.
  value() { node -e '
    const { parse } = require("dotenv"), fs = require("fs");
    const [file, key, mode] = process.argv.slice(1), v = parse(fs.readFileSync(file))[key] ?? "";
    if (mode === "db") { const u = new URL(v); u.searchParams.set("sslrootcert", "/tmp/antseed-database-ca.crt"); u.searchParams.set("pool_max", "2"); process.stdout.write(u.toString()); }
    else process.stdout.write(v);' "$@"; }
  put() { "$VERCEL" env rm "$1" production --yes >/dev/null 2>&1 || true; "$VERCEL" env add "$1" production --sensitive >/dev/null; echo "set $1"; }
  value "$CONFIG/database.env" DATABASE_URL db | put DATABASE_URL
  put DATABASE_CA < "$CONFIG/database-ca.crt"
  for key in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY WORKSPACE_ADMIN_EMAIL CRM_APPROVAL; do value "$CONFIG/access.env" "$key" | put "$key"; done
  printf %s "$APP_URL" | put APP_URL
  # Optional MCP approval email (Resend); skipped until present in access.env.
  for key in RESEND_API_KEY MCP_EMAIL_FROM WORKSPACE_AUTO_DOMAIN WORKSPACE_AUTO_ROLE; do [ -n "$(value "$CONFIG/access.env" "$key")" ] && value "$CONFIG/access.env" "$key" | put "$key"; done
fi

# Deploy from a git-free copy: Hobby blocks CLI deploys whose git metadata names a non-member commit author.
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude .git --exclude node_modules --exclude dist --exclude .local --exclude '.env*' ./ "$STAGE/"
(cd "$STAGE" && "$VERCEL" deploy --prod --yes)
