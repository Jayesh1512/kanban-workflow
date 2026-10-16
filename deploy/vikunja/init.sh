#!/bin/sh
set -eu
umask 077
mkdir -p /run/antseed /vikunja-files /telegram
# An atomic generated credential bundle is kept in its own named volume, never in images.
# Only generated hex/static values enter this file. AI configuration is never sourced here.
if [ ! -s /run/antseed/runtime.env ]; then
  random_hex() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }
  database_password=$(random_hex)
  vikunja_password=$(random_hex)
  service_secret=$(random_hex)
  {
    printf 'DATABASE_PASSWORD=%s\n' "$database_password"
    printf 'DATABASE_URL=postgresql://antseed:%s@postgres:5432/antseed\n' "$database_password"
    printf 'VIKUNJA_USERNAME=antseed\nVIKUNJA_PASSWORD=%s\n' "$vikunja_password"
    printf 'VIKUNJA_SERVICE_SECRET=%s\n' "$service_secret"
  } > /run/antseed/runtime.env.tmp
  mv /run/antseed/runtime.env.tmp /run/antseed/runtime.env
fi
# Regenerate the derived password file after an interrupted init; preserve the bundle.
sed -n 's/^DATABASE_PASSWORD=//p' /run/antseed/runtime.env > /run/antseed/pg-password.tmp
test -s /run/antseed/pg-password.tmp
mv /run/antseed/pg-password.tmp /run/antseed/pg-password
chown 1000:1000 /run/antseed /run/antseed/runtime.env /run/antseed/pg-password /vikunja-files /telegram
chmod 700 /run/antseed /vikunja-files /telegram
chmod 400 /run/antseed/runtime.env /run/antseed/pg-password
printf 'Persistent service credentials and writable data directories ready.\n'
