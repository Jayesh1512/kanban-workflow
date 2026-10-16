# M1 platform deployment and verification

Run `docker compose up` from the repository (use `--build` when rebuilding after code changes). Backend is loopback
`http://localhost:3000/`; Vikunja is `http://localhost:3456/`. Override
`BACKEND_PORT` / `VIKUNJA_PORT` to avoid other projects. PostgreSQL is not exposed.
`AI_ENV_PATH` selects the host AI config file; its default is the private path
in PROJECT_BRIEF. It must exist for Compose to bind it; mount an empty env file
to test with no AI credentials. The mount is read-only. Direct host execution
also tolerates missing/unreadable AI files and reports their absence.

Compose runs the canonical `node dist/main.js` entrypoint, with the platform
module wired through `src/composition.ts`. `src/platform/standalone.ts` is
retained only as an isolated development/test harness.

Startup generates random upstream credentials and a stable Vikunja service
secret in `runtime_state`. Nothing is baked into images or printed. The init
service sets UID1000 ownership of the files/session directories. PostgreSQL
initializes separate `antseed` and `vikunja` databases. The shell-capable
Vikunja wrapper uses the actual pinned binary, lists users and creates the
configured service account only when absent, with public registration disabled.
Its account email is `antseed@localhost.invalid`. The real CLI's email-filtered
list exits 1 for a missing user, so the wrapper lists all users successfully
before matching that exact email. Other CLI failures remain failures.

Backend retries bounded database/board initialization in the background while
serving onboarding. Migration checksum drift pauses retry and requires restoring
the original applied file, not editing the checksum. Each SQL file and ledger
insert is transactional under a connection-scoped advisory lock. No application
transaction holds remote HTTP calls. Board/task bootstrap has its own session
locks and persistent remote markers for uncertain create recovery.

`/api/status` shows component states, configuration presence and actual stored
queue/import counts. `/health/live` is process health. `/health/ready` remains
503 in M1 because Telegram is not implemented. AI credential presence is
explicitly **not checked** access. M1 never calls Telegram, OpenAI or Jev.
The login/control HTTP routes validate requests and return `not_configured`;
chat/ingestion/control ports also fail explicitly rather than fabricate data.

Named volumes retain PostgreSQL, Vikunja files, Telegram session directory and
runtime credentials across restart and `docker compose down` / `up`. Do not
remove one dependent volume independently: deleting the credential volume while
keeping the database loses the generated service passwords. Export/back up these
volumes together. `down --volumes` is an explicit fresh-data reset, never a repair
step for an existing dataset. To open Vikunja directly, obtain its generated
service password privately from the runtime volume; do not paste it into reports.

## Isolated verification

The automated lifecycle script only acts on an explicitly named `antseed-*`
project, never removes volumes, and leaves it running for review. Use a dedicated
project, synthetic AI env file and nonconflicting loopback ports. A temporary
Compose override can publish PostgreSQL to a dedicated loopback port for the
host-run integration tests; do not publish it in ordinary deployment.

```sh
AI_ENV_PATH=/path/to/synthetic.env BACKEND_PORT=18380 VIKUNJA_PORT=18381 \
  docker compose -p antseed-m1-test -f compose.yaml -f /path/to/pg-port.yaml up --build -d
npm run check
PLATFORM_TEST_PROJECT=antseed-m1-test PLATFORM_TEST_PG_PORT=18432 \
  PLATFORM_TEST_VIKUNJA_URL=http://127.0.0.1:18381 \
  npx vitest run tests/platform/integration.test.ts
AI_ENV_PATH=/path/to/synthetic.env BACKEND_PORT=18380 VIKUNJA_PORT=18381 \
  PLATFORM_TEST_PROJECT=antseed-m1-test PLATFORM_TEST_PORTS_FILE=/path/to/pg-port.yaml \
  node tests/platform/compose-smoke.mjs
```

`pg-port.yaml` is just:

```yaml
services:
  postgres:
    ports: ["127.0.0.1:18432:5432"]
```

Ordinary tests skip real integration unless `PLATFORM_TEST_PROJECT` is supplied.
The real tests read generated credentials into process memory and use only that
isolated stack. They verify PG locking/rollback/drift, exact buckets/labels,
lost binding recovery, duplicate task prevention, managed-view lane/done flags,
and detail/label preservation. `compose-smoke.mjs` verifies offline native session
storage, read-only config mount, service restart, persistent down/up, one service
user, stable board/task IDs/credentials, and upstream outage/recovery. A prepared
empty Telegram session is **not** an authenticated Telegram synchronization test.

Vikunja 2.7.0 flat task responses (including `/views/{v}/tasks`) can expose
`bucket_id=0`. `getTask` therefore reads `/views/{v}/buckets/tasks?filter=id = t`,
whose unpaginated grouped response carries actual per-view membership. Project,
label and ordinary task collections still use standard v2 pagination.

## Telegram onboarding and M2 operations

Set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in the read-only runtime file or
process environment. Blank optional Compose values preserve mounted credentials.
Use the local page to request a code, enter it, and enter 2FA when requested.
The page clears the submitted field; status never returns codes/passwords/hash or
session contents. An existing session resumes automatically. The actual self ID
is bound before discovery or updates. A different account requires separate
PostgreSQL/session volumes; changing credentials does not mix datasets.

Discovery includes archived cloud dialogs and explicitly inserts `included`.
Rediscovery preserves exclusions. The page provides stable chat IDs, include/
exclude and bounded import. Platform owns the six canonical `/api/chats` HTTP
routes; workflow owns chat MCP bindings without registering those HTTP routes a
second time. Manual mapping uses the shared `ChatService.correctMapping` contract.

`TELEGRAM_HISTORY_BATCH_SIZE` (1..100, default 100) and
`TELEGRAM_HISTORY_MAX_BATCHES` (1..10000, default 10) bound initial descending
backfill. A request's remaining budget and cursor persist. The live coverage
checkpoint is independent: first connection starts with one current-head window
of batch size; older messages follow the backfill budget. Forward replay continues
one page per turn until an empty probe. A nonempty short page never proves catch-up.
Recent persisted messages are reread for edits/missing-message tombstones within
the same configurable window. Restart/reconnect/TooLong/queue overflow marks replay
required. mtcute update/session writes and PostgreSQL are not one transaction;
replay reduces this gap but cannot prove Telegram retained arbitrary older missed
deletions. No claim of complete historical delete recovery is made.

Exclusion fences in-flight history/replay, cancels old analysis claims, invalidates
unapplied proposals and suspends tickets. Tombstones can precede chat discovery;
null-scope common-mailbox deletion cannot delete channel/supergroup messages.
Message, evidence invalidation, job and versioned job-message snapshots commit
atomically. Forward origin and sender/peer snapshots remain separate from body text.

Configure an existing group or explicitly create a private supergroup on the page.
The operation key is kept in local browser storage (no login secrets). Unknown
creation is journaled before the remote request; repeat that key/reconcile it.
Another create is blocked while an earlier outcome is unknown. Reconciliation
reads the stored marker and never blindly creates a second group. Group/title/key
are the only request data persisted in the setup journal.

Control replies, including outgoing replies from another user-account client,
enter a durable inbox before business exclusion. No subscriber leaves them pending;
handlers are awaited. Success (including ignored/invalid/stale decisions handled
by workflow) acknowledges the immutable claim; transient failures replay after
bounded delay. Proposal outbox rows retain signed64-bit MTProto random IDs and
markers; retries read recent own-message receipts before resending that same ID.
Only the actual configured group is sendable. Stale source policies/versions/
evidence suppress queued proposal delivery. A transport worker never moves lanes.
Ten failed sends stop automatic resend and expose `control_delivery_failed` for
receipt/operator investigation; unresolved remote outcomes remain stored.

`/api/status` distinguishes Telegram login, synchronization and control states,
import cursor/error, replay/analysis/proposal counts, and missing control group.
It is not a provider entitlement probe. Jev remains Vercel-only; the separately
observed403 paid-credit restriction is not a successful live Jev test.

For actual Telegram integration questions the user designated existing T3 thread
`66cc9b30-4836-4f8d-8c6c-b0831923b62c`. A targeted prerequisite request was sent;
no authenticated Telegram call/send/group creation was performed during M2 tests.
See [M2 handoff](M2_HANDOFF.md) for evidence and remaining live gate.
