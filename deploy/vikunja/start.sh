#!/bin/sh
set -eu
read_value() { sed -n "s/^$1=//p" /run/antseed/runtime.env; }
export VIKUNJA_DATABASE_PASSWORD="$(read_value DATABASE_PASSWORD)"
export VIKUNJA_SERVICE_SECRET="$(read_value VIKUNJA_SERVICE_SECRET)"
username=$(read_value VIKUNJA_USERNAME)
password=$(read_value VIKUNJA_PASSWORD)
email=antseed@localhost.invalid
test -n "$VIKUNJA_DATABASE_PASSWORD"
test -n "$VIKUNJA_SERVICE_SECRET"
test -n "$password"
# CLI list failure is fatal. Recognize the exact email rather than hiding create failures.
if ! users=$(/app/vikunja/vikunja user list); then
  printf 'Vikunja account lookup failed; check database configuration.\n' >&2
  exit 1
fi
if ! printf '%s\n' "$users" | grep -F "$email" > /dev/null; then
  /app/vikunja/vikunja user create --username "$username" --email "$email" --password "$password"
fi
unset password users
exec /app/vikunja/vikunja "$@"
