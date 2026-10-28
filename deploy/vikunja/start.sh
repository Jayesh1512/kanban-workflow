#!/bin/sh
set -eu
read_value() { sed -n "s/^$1=//p" /run/antseed/runtime.env; }
# Optional external database configuration is data, never shell-sourced. The
# generated credentials/JWT secret remain in their existing persistent volume.
if [ -n "${DATABASE_ENV_PATH:-}" ]; then
  test -r "$DATABASE_ENV_PATH"
  read_database_value() { sed -n "s/^$1=//p" "$DATABASE_ENV_PATH"; }
  for name in HOST USER DATABASE SCHEMA SSLMODE SSLROOTCERT MAXOPENCONNECTIONS MAXIDLECONNECTIONS; do
    value=$(read_database_value "VIKUNJA_DATABASE_$name")
    if [ -n "$value" ]; then export "VIKUNJA_DATABASE_$name=$value"; fi
  done
  encoded=$(read_database_value VIKUNJA_DATABASE_PASSWORD_B64)
  test -n "$encoded"
  export VIKUNJA_DATABASE_PASSWORD="$(printf '%s' "$encoded" | base64 -d)"
  unset encoded value
else
  export VIKUNJA_DATABASE_PASSWORD="${VIKUNJA_DATABASE_PASSWORD:-$(read_value DATABASE_PASSWORD)}"
fi
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

# Keep Vikunja's API and embedded frontend private to the container. The local
# nginx listener preserves the canonical port while adding the AntSeed KPI
# dashboard shell to HTML responses. API traffic remains a transparent proxy.
export VIKUNJA_SERVICE_INTERFACE=127.0.0.1:3457
/app/vikunja/vikunja "$@" &
vikunja_pid=$!
mkdir -p /tmp/nginx/logs
nginx -p /tmp/nginx/ -g 'daemon off;' &
nginx_pid=$!

stop_services() {
  trap - TERM INT
  kill -TERM "$nginx_pid" "$vikunja_pid" 2>/dev/null || true
  wait "$nginx_pid" 2>/dev/null || true
  wait "$vikunja_pid" 2>/dev/null || true
}
trap 'stop_services; exit 0' TERM INT

while kill -0 "$nginx_pid" 2>/dev/null && kill -0 "$vikunja_pid" 2>/dev/null; do
  sleep 1
done
status=1
if ! kill -0 "$vikunja_pid" 2>/dev/null; then
  wait "$vikunja_pid" || status=$?
else
  wait "$nginx_pid" || status=$?
fi
stop_services
exit "$status"
