# Supabase PostgreSQL

One Supabase PostgreSQL project stores the backend in `antseed` and Vikunja in
`vikunja`. Neither namespace uses Supabase's application `public` tables. Telegram's
MTProto session, Vikunja uploaded files, generated service password and JWT signing
secret stay in the current Docker volumes. No Supabase JavaScript SDK, anon key or
service-role API key is used.

Use **Connect → Session pooler → URI**, port **5432**, database **postgres**. Direct
PostgreSQL connections on port 5432 also work when the Docker network can reach
the endpoint (Supabase direct endpoints commonly use IPv6). Transaction pooling
on port 6543 is incompatible with the application's session advisory locks.
See [Supabase's connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).
The pinned Vikunja 2.7.0 supports its own PostgreSQL schema and SSL settings;
see [its exact database source](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/db/db.go).

## Private configuration

Copy `credentials.env.example` to `.local/supabase/credentials.env` and edit it
locally. This directory is ignored by Git. Do not paste credentials in a chat.
The URL can omit its password because `SUPABASE_DATABASE_PASSWORD` supplies it
separately and the configurator safely encodes special characters.

```sh
mkdir -p .local/supabase
chmod 700 .local/supabase
cp deploy/supabase/credentials.env.example .local/supabase/credentials.env
chmod 600 .local/supabase/credentials.env
# Edit the private file before running the next command.
node deploy/supabase/configure.mjs --credentials-file .local/supabase/credentials.env
node deploy/supabase/migrate.mjs preflight
```

The configurator creates `database.env` with mode 0600; it prints no values and
makes no network calls. Default TLS is `verify-full`. If the project uses a CA
not trusted by the system, download its root certificate from Supabase Database
settings and add `--ca-file /path/to/root.crt`. It is copied privately to the
configuration directory. An explicitly supplied `sslmode=require` uses encrypted
libpq-compatible TLS without certificate verification; `sslmode=disable` is
rejected. No script disables TLS implicitly.

The preflight connects, verifies PostgreSQL 17+ (the source/client are PostgreSQL
17) and proves that a held advisory lock survives across statements and excludes
a second session. It does not write app data or create target schemas. Two
connections are required for this probe. The normal backend pool uses at most 8
connections and Vikunja at most 5. A Supabase project with insufficient available
session connections needs additional capacity or a suitable direct connection.

## Migrate the existing installation

Choose the exact current Compose project; do not operate on unrelated projects.
Run from the repository root. The example uses the current personal project.
Prepare credentials and run preflight **before** stopping any services.

```sh
# A fresh backup directory for each attempt. The original local volumes survive.
backup_dir=".local/supabase/backup-$(date +%Y%m%d-%H%M%S)"
docker compose -p antseed-personal-account2 -f compose.yaml stop backend vikunja
node deploy/supabase/migrate.mjs backup --project antseed-personal-account2 --backup "$backup_dir"
node deploy/supabase/migrate.mjs stage --backup "$backup_dir"
node deploy/supabase/migrate.mjs restore --backup "$backup_dir"
node deploy/supabase/migrate.mjs verify --backup "$backup_dir"
```

Backup requires both writers stopped and PostgreSQL running. It creates private
custom-format dumps and a manifest of every table's row count and ordered row
digest, plus every sequence's last value/called state. Snapshot sessions use UTC and full round-trip floating-point formatting so Supabase display defaults cannot create false mismatches. It refuses to overwrite a
completed backup. The staging command restores into an isolated disposable,
network-disabled PostgreSQL container, renames each `public` schema using
PostgreSQL itself and dumps the renamed namespaces. It never rewrites SQL or
message text with string replacement. Only that staging container is removed.

Restore refuses nonempty target namespaces unless their data already exactly
matches this backup. Each namespace restores in one transaction, preserving IDs,
foreign keys, migration ledgers, evidence, contacts, approval/journal state and
sequence values. A successfully restored first namespace can be skipped on a
retry if the second was interrupted. Unrelated Supabase schemas are untouched.
Verification must pass **while the writers are still stopped**. After startup,
workers normally change synchronization/operational metadata, so the original
full snapshot is no longer expected to match exactly.

Start the existing app and Vikunja on Supabase:

```sh
docker compose -p antseed-personal-account2 -f compose.yaml -f compose.supabase.yaml up --build -d
```

The override removes Vikunja's local PostgreSQL dependency and profiles the local
PostgreSQL service out of normal startup. It preserves the project's original
volumes, ports, API keys, user credentials and session. Root init copies the
private database config into the runtime volume as UID1000/mode0400; app
containers see that volume read-only. Supabase credentials are never baked into
images. Keep the host configuration directory available for subsequent starts.
Docker Compose 2.24.4+ is required for the override syntax. Cloud mode defaults to 20 dialogs per discovery turn (`TELEGRAM_DISCOVERY_BATCH_SIZE`) instead of the local 500; initial saved-session startup and later discovery retain their cursors, including pinned-only pages, without waiting for hundreds of sequential remote database transactions.

Verify `/api/status` database/Vikunja readiness, existing ticket/task IDs, six
lanes, four labels, contact context, pending approvals and Telegram saved-session
resume. Verify that no duplicate managed board or service user was created. Only
after that, stop the project's local PostgreSQL container (do not remove its
volume). No migration command automatically cuts over or stops PostgreSQL.

For later **one-command startup**, set these nonsecret entries in the ignored
`.env` after successful verification:

```dotenv
COMPOSE_FILE=compose.yaml:compose.supabase.yaml
SUPABASE_CONFIG_DIR=./.local/supabase
```

Then `docker compose up -d` uses Supabase. For credential/CA rotation, regenerate
the private file and recreate `init` before restarting app services. Never edit
`runtime.env` or regenerate the existing Vikunja service secret to change the DB.

## Recovery

No tool deletes or alters the original local databases, Telegram session or
Vikunja files. If restore/verification fails before cutover, start the original
local services with explicit `-f compose.yaml` and investigate using the retained
private backups. If the cloud app has already accepted new writes, stop writers
and reconcile/copy those changes before switching back: the frozen local DBs are
then a historical snapshot. Never run both deployments as simultaneous writers
for the same Telegram account/session.

These scripts run on the host with the repository's Node dependencies and Docker.
They do not log raw database errors, URLs/passwords or contact/message data. A
failed operation leaves source data and complete backups available. Partial
outputs are retained privately; use a fresh backup directory after a failed
backup. New projects should also use the native backup/restore path rather than
pointing both applications at an uninitialized shared public schema.
