# Deployment, onboarding and operations

From the repository, start the complete local stack with:

```sh
docker compose up
```

Use `docker compose up --build` after code changes. The canonical entrypoint is
`node dist/main.js`, composed as platform plus workflow. Both modules register
before workers start; workflow owns its scheduler and MCP transports, then drains
before platform closes PostgreSQL. The standalone platform harness is only for
isolated development/tests.

| Local address | Purpose |
| --- | --- |
| [localhost:3000](http://localhost:3000/) | Telegram onboarding, chat inclusion/import, control setup and status |
| [localhost:3456](http://localhost:3456/) | Vikunja board and its native UI login |
| [localhost:3000/api/status](http://localhost:3000/api/status) | Platform, workflow, provider and durable work state |
| `http://localhost:3000/mcp` | Official SDK Streamable HTTP MCP endpoint; POST protocol, not a browser page |

`BACKEND_PORT` and `VIKUNJA_PORT` override the loopback ports; update client URLs
accordingly. PostgreSQL has no ordinary host port. Use the same Compose project
name and overrides for later commands; if started with `-p <project>`, include
that option every time. Do not operate on another project's services or volumes.

## Runtime configuration and automatic bootstrap

`AI_ENV_PATH` selects an existing host env file. Its default is the configured
private path in the [project brief](../docs/PROJECT_BRIEF.md). Compose mounts it
read-only; it does not enter the build context/image. For offline checks, point
to an existing empty or synthetic env file. Direct host execution also tolerates
an absent/unreadable AI file and reports configuration absence. Process environment
overrides file settings; blank optional Telegram fields preserve mounted values.
Restart the backend after changing the mounted file to reload configuration;
recreate services with `docker compose up -d` for changed Compose environment/ports.

Init generates persistent upstream passwords and a stable Vikunja service secret
in `runtime_state`, and prepares UID 1000 files/session directories. PostgreSQL
contains separate `antseed` and `vikunja` databases. The shell-capable wrapper runs
the pinned Vikunja binary, lists users successfully, and creates the configured
service account only if its exact email is absent. Public registration is disabled.
Repeated bootstrap reconciles the project/view, six buckets and four workstream
labels. Approved Telegram chats enter the CRM without creating Work. A concrete action
proposed from an accepted CRM relationship creates a Work ticket only after its
separate Telegram approval; that ticket starts in **To be started**. Workstream
labels are separate from lanes. See [the CRM-first workflow](../docs/CRM_OPERATIONS.md).

The ordered lanes are **To be started**, **Work in progress**, **Integrations**,
**Blocked**, **Archived**, **Completed**. Workstreams are **Buyer**, **Provider**,
**Integration**, **Others**. Bootstrap, projection and approved movement use durable
markers/session locks; remote I/O runs outside SQL transactions.

## Private local Vikunja UI access

Open the local Vikunja URL and use the generated service account. To display only
its username/password, run this yourself in a private local terminal:

```sh
docker compose exec -T backend node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  import { parse } from "dotenv";
  const values = parse(await readFile("/run/antseed/runtime.env"));
  console.log("Username: " + values.VIKUNJA_USERNAME);
  console.log("Password: " + values.VIKUNJA_PASSWORD);
'
```

This intentionally shows the password in that terminal. Keep the output out of
recordings, shared terminals, logs, reports and commits. Do not dump the whole
runtime bundle, which also contains database credentials and the service secret.
No actual credential values are included in this guide. The account persists
across restarts; its generated values remain tied to the database/runtime volumes.

## Fresh Telegram connection and control setup

The published `tdl` AppBuiltin profile is the default application configuration
(iyear/tdl v0.20.4, distinct from AppDesktop). Set
`TELEGRAM_APPLICATION_PROFILE=tdl|custom` in the runtime file/environment as needed.
A complete custom `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` pair overrides either profile;
partial pairs are invalid, and custom without a pair stays unconfigured.
This supplies application configuration, not another app's account/session.

On the local page, explicitly request a phone code, enter it, then enter 2FA if
requested. Codes/passwords are cleared from the submitted field and not returned
in status. The application stores its own session in `telegram_sessions`; an
existing session resumes automatically. Actual self identity is bound before
processing. A different account needs a separate database/session dataset.
Transient saved-session restoration retries from five seconds up to five minutes;
invalid sessions/account mismatch need correction. Native flood waits are respected.
Once phone/code/2FA authentication succeeds, transient activation or discovery
errors use that same saved-session recovery without requesting another code.
Discovery processes at most 500 dialogs per pass; subsequent passes continue
from the last stored dialog, including after a rate limit, so a large chat list
does not block the connected session behind a full rescan. Pagination offsets
are process-local; after a restart, discovery safely starts another bounded sweep.

Login starts archived/cloud dialog discovery, bounded history import and eligible
workflow analysis. New chats wait outside business ingestion. Only a fresh incoming message in a new chat triggers an intake request in the configured approvals group. Reply **approve to that message** to admit it to CRM and begin bounded import/analysis; reply **reject**, or leave it unanswered, to keep it out. This creates no Work ticket. Work creation, CRM data changes, sales-stage changes and Work lane changes require their own Telegram approvals. Discovery sends no requests by itself and does not store waiting-chat message bodies. Requests are paced at one per 30 seconds with at most five awaiting replies.

Historical chats are handled manually: find the chat on the setup page and choose **Request approval / prioritize**, then approve its request in the control group. Existing tracked cards retain their stage and settings. Previously auto-included historical entries without a card are paused for manual selection; stored data is retained. Rediscovery preserves exclusions. HTTP/MCP include commands also request approval instead of bypassing it.

For approved group cards, explicit titles such as `AntSeed <> Phala` and `Fere AI <> Antseed` identify the external company from either side of the separator. This links or creates the company record and upgrades the same card; its lane, stage version and remote task ID are preserved. The exact title is recorded in mapping history as metadata, without fabricated message evidence. Ambiguous multi-company titles, duplicate directory matches and explicit operator mapping choices are retained for review. A company title never proves a contact's employment or a workflow stage.

Use stable chat IDs on the page to include/exclude or request more bounded import.
Exclusion fences in-flight results, cancels older analysis, stales unapplied
proposals and suspends tracking. The operational control group is excluded from
business analysis while its replies remain eligible for operational processing.

`TELEGRAM_HISTORY_BATCH_SIZE` (1..100, default 20) and
`TELEGRAM_HISTORY_MAX_BATCHES` (1..10000, default 10) bound descending backfill.
Budgets/cursors persist. Independent live coverage starts with one current-head
window, then replays forward in bounded pages until an empty probe. Recent-message
readback checks edits/deletes within that window. Per-chat access errors retain
coverage/error/retry state without starving healthy chats; global auth/network/
flood/database failures use global backoff. mtcute session writes are not atomic
with PostgreSQL: replay reduces the gap, but cannot prove arbitrary older missed
deletes were recovered. Scoped and common-mailbox tombstones prevent resurrection.

Configure an existing operational group, or explicitly create a private supergroup,
on the page. Keep the operation key (also saved in local browser storage). Unknown
creation outcomes are journaled before the remote call; reconcile that key instead
of submitting another create. Only operational messages go to the configured group.
Missing setup leaves proposals pending with visible `control_chat_missing`; after
setup, current proposals are rechecked and queued for delivery.

## Proposals, decisions and actual application

Outbound enquiries can appear before the recipient's company is known. A sourced
AI classification of business outreach creates a contact prospect such as
“Harsh — company unknown” in To be started. The company stays null; no placeholder
company is created. Personal messages, forwarded pitches and uncertain outreach
do not qualify. Source changes and exclusions still fence analysis and proposals.
When the company is confirmed later, the same ticket and Vikunja task are updated;
their lane/stage and manual actions are preserved. Contact prospects use the same
explicit human approval flow as company tickets.

A reserved live analysis slot handles fresh outbound conversations and their
replies; it never falls back to historical jobs. A separate general slot retains
durable fair queue ordering. Projection/control work runs independently of either
provider request, so a slow historical extraction cannot block new card processing
or approved movement. Stop aborts and drains both slots before closing the database.

AI and Hermes recommendations create pending proposals; they do not move a ticket.
Inspect proposal decision and apply state through the HTTP/MCP proposal operations.
Reply to the actual proposal message in the control group with `approve`, `reject`,
or `correct Work in progress | reason` (using any exact lane name). A correction
creates a separate pending replacement that needs its own approval. Repeated
commands are idempotent; stale/conflicting evidence or source versions do not apply.

Approval queues durable apply work. A queued/applying/reconciling proposal is not
yet an applied lane change. The worker preflights, writes the intended remote lane,
reads it back and commits the local stage/version once. Unknown remote outcomes
remain reconciling; third-state conflicts are surfaced instead of overwritten.
New task projection only sets the initial lane. Direct human board edits can cause
conflicts that require a fresh reviewed proposal.

The inbox survives handler failures; replies arriving before an uncertain delivery
receipt is linked remain replayable. Outbox retries retain their signed 64-bit
MTProto random ID and read back own-message receipts. Ten failed sends stop
automatic resend with `control_delivery_failed`; unresolved rows remain available
for receipt/operator investigation. No synthetic receipt or lane success is invented.

## Provider pause, status and restoration

OpenAI extracts evidence. Native **GPT-6 Luna Decisions** can handle company,
workstream, lane and urgency judgments using the same private `OPENAI_API_KEY`.
The personal deployment selects it with these nonsecret `.env` settings:

```dotenv
MOVEMENT_PROVIDER=openai
JEV_ENDPOINT=https://api.openai.com/v1/decisions
JEV_MODEL=gpt-6-luna
```

`JEV_*` names and the API's `components.jev` key are retained for compatibility;
they now configure the selected decision layer. The UI calls it Decision model.
Recreate only the backend with `docker compose up --build -d --no-deps backend`.
No OpenRouter or Vercel key is needed for this selection. Typed native probabilities,
raw native diagnostics and OpenAI provenance are retained. New automatic proposals
have origin `openai`; they remain pending until an explicit operator decision.
Refusals, malformed distributions and unexpected models never become lane writes.

Extraction requests can include a sizeable captured history. For the personal
deployment, `.env` can override `OPENAI_TIMEOUT_MS=90000` and
`OPENAI_MAX_OUTPUT_TOKENS=8192` without editing the shared private AI file. Blank
Compose overrides preserve that file's settings. GPT-6.1 Sol extraction uses low
reasoning effort; evidence, date and identity validation remains required. A
timeout returns work to the durable queue. Incomplete output is rejected rather
than used to create facts or decisions. These limits are finite and do not
guarantee that every model response will pass validation.

Existing deployments may continue selecting `MOVEMENT_PROVIDER=vercel` with its
original endpoint/model. The recorded real Gateway 403 paid-credit restriction seeds a
durable Jev pause across jobs/processes/restarts. Extraction already saved for a
current input can be reused; messages and pending analysis remain stored. New jobs
do not repeatedly probe a known entitlement failure. Key presence or a green local
container does not establish successful live Jev inference.

After fixing the selected provider credit/access, explicitly use `POST /api/analysis/replay` or
the `replay_analysis` MCP tool with an idempotency key (optionally scoped to a chat).
This can resume paid provider calls. Credential-file edits/remounts or restarting
alone do not clear the pause. Deliberately selecting the OpenAI Decisions endpoint
and model changes the provider revision, so the historical Vercel restriction does
not carry over. Any new credential/credit failure still pauses the selected provider. If access still fails, the selected decision provider pauses again; no implicit
provider or substitute-model fallback is used.

`/health/live` is process health. `/health/ready` aggregates actual module state and
can return 503 while onboarding is reachable, including missing Telegram or paused
providers. `/api/status` stays reachable and includes real platform, workflow,
extraction/Jev states plus import/replay/analysis/proposal counts and errors. Status
reads do not invoke a provider. Configured keys are configuration presence only.

Every guarded business HTTP/MCP call checks the current exact migration ledger
against checksums cached from the deployed migration files. Missing/pending rows,
unknown rows, checksum drift or DB outage return sanitized 503 without business or
request-triggered ledger writes. Root, liveness, status and GET login remain
reachable. Ordinary connection checks cannot clear drift. Restore the matching
immutable deployment artifacts and a coherent known-good database/ledger backup;
do not rewrite checksums to bless changed migrations. A valid restored ledger
recovers request readiness; if startup halted on drift, restart after restoration.
Database/upstream outage recovery retains durable queues, cursors and mutation
journals instead of requiring a volume reset.

## HTTP, MCP and Nous Hermes

The composed backend registers platform's six chat HTTP routes, workflow's other
22 domain HTTP operations, and all 27 catalogued MCP tools through the same services.
The authoritative inventory is [shared API operations](../src/shared/api.ts).
Use the current [HTTP/MCP and Hermes guide](../src/hermes/README.md) for exact tool
behavior and isolated Hermes profile configuration. `/mcp` supports SDK POST
initialize/list/call; GET/DELETE return 405. Hermes movement tools create proposals;
proposal decisions stay operator HTTP/control-reply operations.

See the [independent M4 acceptance report](../docs/QA_M4_REPORT.md),
[M4 owner handoff](../docs/M4_HANDOFF.md),
[delivery status](../docs/DELIVERY_STATUS.md) and
[demo plan](../docs/DEMO_PLAN.md) for evidence and remaining acceptance work.
Independent QA established actual installed-Hermes discovery and pending-proposal
creation against synthetic records backed by real SQL/Vikunja, with no lane move.
That closes the owner handoff's earlier outstanding proposal-client check. It does
not establish authenticated Telegram, successful live Gateway Jev or the final
integrated UI demo. Synthetic transport/provider fixtures remain separately labeled.

## Persistence, backup and isolated lifecycle work

Four named volumes persist PostgreSQL, Vikunja files, Telegram sessions and runtime
credentials across restart and `docker compose down`/`up`. Back up/restore them as
one coherent dataset. For a filesystem/volume backup, cleanly stop the exact stack
before taking consistent copies; alternatively use supported PostgreSQL backups
with coordinated files/session/runtime backups. Protect the runtime/session copies
as private credentials. Restore a matching set with compatible images/migrations.
Deleting only `runtime_state` while retaining databases loses generated passwords.
`down --volumes` is an explicit fresh-data reset for a disposable dataset, never an
existing-dataset repair.

Use a distinct `antseed-*` Compose project, synthetic env file, fresh session and
nonconflicting loopback ports for lifecycle tests. Keep PostgreSQL unexposed in
ordinary deployment; an isolated override may publish a dedicated loopback test
port. The historical script below restarts/down-ups its supplied project, retains
its volumes and leaves it running. Do not point it at an existing personal stack.

## Historical M1 platform verification

The M1 recipe below established platform/board/native/lifecycle evidence at that
milestone; see the [M1 QA report](../docs/QA_M1_REPORT.md). It is not a claim of
current release acceptance or live Telegram/Jev/Hermes success. Current images
compose both modules, while this script still checks its original platform slice.
Use synthetic configuration and a fresh unauthenticated session for this recipe.

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

These particular real platform tests require `PLATFORM_TEST_PROJECT`; other
upstream suites have their own explicit opt-in variables. Skips do not pass those
integration gates. All historical commands above must target the same test project,
configuration and overrides.
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

For M2 implementation/evidence limits see [M2 handoff](M2_HANDOFF.md) and the
[independent M2 QA report](../docs/QA_M2_REPORT.md). The user-designated existing
Telegram integration contact is thread `66cc9b30-4836-4f8d-8c6c-b0831923b62c`.
Documentation does not itself log in, send messages, create groups or pass live gates.

### Automatic intake by conversation start

The durable `telegram:automatic-since` setting can select conversations whose earliest accessible Telegram message is on or after a UTC cutoff. The current requested cutoff, **5 October 2026 at midnight IST**, is `2026-10-04T18:30:00.000Z`. The policy has `enabled`, a unique `revision`, `cutoff`, and `initialPlacement: true`. It is disabled when no setting exists. Discovery preserves last-message metadata only; a resumable, rate-limited scanner probes oldest history. Known pre-cutoff messages or last activity exclude older conversations without extra RPCs. Recent activity alone never qualifies an older chat. Hidden earlier history, uncertain migrations and inaccessible boundaries are retained as unknown/retry, not guessed new. Deleted private history cannot be reconstructed.

Qualifying chats bypass intake approval and get a card plus bounded import. The first supported AI lane recommendation is approved with `automation` provenance and applied through the same mutation journal/readback path; no initial approval message is sent. Initial no-change or uncertain assessments do not invent movement. Leftover historical windows from that initial snapshot do not produce approval spam; later recommendations based on newer messages or edits require the normal Telegram/operator approval. Explicit exclusions and the control group remain outside automatic intake. `/api/status` exposes `automaticIntake` counts and progress; scans and native flood waits survive worker restarts.

For new groups, optional `groupApprovalFrom` is the inclusive UTC conversation-start boundary requiring human approval of the first AI lane recommendation as well as every later lane change. It applies to groups/supergroups, not private conversations. The existing cutoff import for groups started before that boundary keeps automatic initial placement, even if discovered later. Future groups first receive an intake request in the control group; no business messages are imported and no card is created until approve. Intake approval adds a prospect card in To be started and starts bounded analysis. The first recommended lane change is then sent to the configured control group and remains pending until its correlated approve reply. Unknown conversation dates remain deferred. This field does not authorize automatic later movements.

## Supabase instead of local PostgreSQL

[Supabase migration and deployment](supabase/README.md) moves both existing databases
into separate schemas in one Supabase project, with encrypted direct/session
connections, private configuration, coherent backups, row/sequence verification,
and retained local volumes. Telegram sessions, Vikunja files and generated login/JWT
credentials stay in the existing volumes. Use the Supabase Compose override only
after restoring and verifying existing data; the default Compose file still uses
local PostgreSQL.
