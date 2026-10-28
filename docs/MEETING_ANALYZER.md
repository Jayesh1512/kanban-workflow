# Meeting Analyzer

Meeting Analyzer adds a customer meeting archive to this application at `/meetings`. Fathom supplies recordings, summaries, transcripts and action items; PostgreSQL retains their source history alongside the existing customers. Hermes reads the same archive through the existing `/mcp` endpoint.

**Confirmed behavior:** eligible action items create tasks automatically in the existing Vikunja project. There is no approval step. The original [implementation proposal](MEETING_ANALYZER_PLAN.md) retains its review-first assumptions as historical context; the user's subsequent automatic-task decision takes precedence.

## Try the isolated demo

Use Node 22.23.3 or newer. Node 22 is preferred on this workstation because the existing SQLite native dependency was built for it.

```sh
npm ci
npm run meetings:demo
```

Open [the synthetic meeting archive](http://127.0.0.1:19480/meetings). The demo contains six clearly labeled synthetic recordings, including simultaneous meetings, several customers, an unresolved customer and a completed action. Its archive persists in `.local/meeting-demo/`; restarting preserves changes. `MEETINGS_DEMO_PORT` can select another local port.

The demo loads no production environment files or external provider credentials. It runs neither the Fathom worker nor the task publisher. Queued action states demonstrate the archive behavior; they do not represent real Vikunja tasks. The entry point is [scripts/meetings-demo.ts](../scripts/meetings-demo.ts).

## Connect the normal application

Use the existing application deployment, PostgreSQL database and Vikunja credentials. Normal entry points remain `npm run dev`, or `npm run build` followed by `npm start`; Compose deployment instructions remain in [deploy/README.md](../deploy/README.md).

On 26 October 2026 the user supplied a Fathom key and authorized activation. The personal deployment now serves the live archive at [localhost:19280/meetings](http://localhost:19280/meetings), with its existing Vikunja project at port 19281. The initial 30-day scan imported three real recordings, all 1,047 transcript segments and 14 incomplete action items. Full transcript readback matched Fathom, and the four meeting tools were verified through the live MCP endpoint. All 14 actions were automatically published to existing project 2 and independently read back from Vikunja with exactly one matching action marker and the recorded task ID. The separate port-19480 demo remains synthetic.

The key is stored only in ignored private configuration under `.local/meeting-fathom-live/`, loaded by the final Compose override in `.env`'s `COMPOSE_FILE` chain. Preserve that complete chain when operating this deployment. The deployed image is `antseed-personal-account2-backend:meetings-fathom-20261026`. Its manifest includes all three applied meeting migrations; reverting to a pre-meeting image would fail migration readiness. Webhook registration remains optional and is not configured.

After the first import, database, Vikunja, Telegram, workflow, extraction, decision and outreach status all reported ready; the existing CRM refresh queue resumed progress. Existing ticket/company/contact counts remained 29/12/67 across activation. The three imported meetings currently have unresolved customer associations; their source invitees did not identify a unique customer in the existing directory. Use the audited customer correction control to associate them explicitly.

Place the following values in the private environment file selected by `RUNTIME_ENV_PATH` or `AI_ENV_PATH`, using the real key only in that private file:

```dotenv
FATHOM_ENABLED=true
FATHOM_API_KEY=replace-with-your-api-key
# Optional, only after a Fathom webhook has been created:
# FATHOM_WEBHOOK_SECRET=whsec_replace-with-signing-secret
# Exclude your own domains from customer matching:
MEETINGS_INTERNAL_DOMAINS=yourcompany.example
```

Restart the backend after changing configuration. For these meeting settings, nonblank process environment values take precedence over `AI_ENV_PATH`, which takes precedence over `RUNTIME_ENV_PATH`. Blank optional Compose values preserve mounted settings. A repository `.env` is used for Compose interpolation; direct `npm run dev` / `npm start` does not automatically load it. Existing nonblank overrides such as `FATHOM_ENABLED=false` still win over a mounted file.

| Setting | Default | Meaning |
|---|---|---|
| `FATHOM_ENABLED` | `false` | Enable automatic Fathom polling; accepts `true` or `false`. |
| `FATHOM_API_KEY` | Absent | Server-side API key; never returned by status or MCP. |
| `FATHOM_WEBHOOK_SECRET` | Absent | Optional `whsec_` signing secret; webhook ingress fails closed without it. |
| `FATHOM_POLL_INTERVAL_MS` | `300000` | Scan scheduling interval, positive integer up to `86400000`. |
| `FATHOM_TIMEOUT_MS` | `30000` | Abortable REST timeout, positive integer up to `120000`. |
| `MEETINGS_INTERNAL_DOMAINS` | Empty | Comma-separated exact domains excluded from customer matching. |
| `MEETINGS_VIKUNJA_PROJECT_ID` | Existing board binding | Optional positive ID of an existing Vikunja project. |

The dedicated task adapter reuses `VIKUNJA_API_TOKEN`, or the existing `VIKUNJA_USERNAME` / `VIKUNJA_PASSWORD`, plus `VIKUNJA_URL`. `VIKUNJA_PUBLIC_URL` supplies browser task links when configured. If no meeting-specific project is selected, the adapter reads the existing managed board's project binding. Missing credentials, a missing binding or an inaccessible project leave work queued or waiting for destination preparation; the adapter does not create a project.

`FATHOM_ENABLED` controls upstream ingestion, not a general task-publication switch. Importing Fathom JSON into the normal application also queues eligible actions and can create real tasks using configured Vikunja credentials. Use the isolated demo for synthetic data.

Open `/meetings` and its **Fathom connection & history import** panel, or read `GET /api/meetings/status`. Status includes configuration booleans, source state, the last successful scan window, durable run progress, retry/error information, pending webhook count and task-state counts. Missing Fathom credentials produce a disabled or unconfigured source; they do not prevent existing application screens from starting.

All production meeting operations and workers share the existing migration readiness gate. Startup applies the additive meeting migrations `202610260003_meetings.sql`, `202610260004_meeting_ingestion.sql` and `202610260005_meeting_tasks.sql`. The complete application's migration ledger must match file checksums before business operations proceed. Do not edit an applied migration to repair drift.

## Import scope and recovery

The server calls `GET https://api.fathom.ai/external/v1/meetings` using `X-Api-Key`, requesting transcript, summary, action-item and CRM-match inclusion. It follows the returned `next_cursor`; it does not invent a page-size parameter or fetch recordings through an undocumented individual-meeting endpoint. The API-key path is intentional: the documented meeting-list transcript and summary inclusions are unavailable for OAuth-connected apps. See Fathom's [list-meetings contract](https://developers.fathom.ai/api-reference/meetings/list-meetings.md).

Enabling a configured connection starts a fixed 30-day creation-time scan. Subsequent scheduled scans overlap the previous polling checkpoint by one day. Each worker tick fetches at most one page. A historical import continues across ticks and process restarts until its cursor is exhausted. Page ingestion and cursor advancement commit in one transaction; connection leases and fencing prevent a late abandoned worker from replacing a newer committed observation. HTTP runs outside database transactions.

**Creation time is different from recording time.** Fathom's `created_after` / `created_before` filter `created_at`; the meeting list's `from` / `to` filter recording start, falling back to scheduled start. Status describes the last completed scan window, not proof that every older recording has been imported or refreshed. One-day overlap cannot discover arbitrary edits to older recordings. Reimport a chosen older creation window when reconciling such changes. Source visibility is limited to what the configured key can access; organization-wide or simultaneous-recording availability has not been verified for a live account.

Use the history panel or `POST /api/meetings/sync` for a chosen creation window. Both bounds accept timestamps with an offset. Omitted bounds default to a 30-day window ending now, or ending at the supplied `createdBefore`. Each requested window must be valid and at most 366 days. Use multiple chosen windows for older history.

```sh
curl --fail-with-body http://127.0.0.1:3000/api/meetings/status

curl --fail-with-body http://127.0.0.1:3000/api/meetings/sync \
  -H 'Content-Type: application/json' \
  --data '{"idempotencyKey":"history-2026-09","createdAfter":"2026-09-01T00:00:00Z","createdBefore":"2026-10-01T00:00:00Z"}'
```

The response identifies the durable import run and its status. Retrying the same idempotency key and bounds returns that run; changed bounds with the same key return a conflict. Retry backoff is persisted and valid `Retry-After` values are honored. Authentication failures pause the connection until an explicit import retry or a configuration change. An explicit retry of a completed run returns its existing result; use a new key to request another scan.

`POST /api/meetings/import` accepts `{ "meetings": [...] }` containing 1–200 validated Fathom list-meeting objects, with a 20 MiB request limit. This is a manual archive import, not the application's normalized JSON download format. It preserves source facts and participates in automatic task queuing.

## Optional signed webhook

The ingress route is `POST /api/integrations/fathom/webhook`. Creating the route does not register it with Fathom. Configure the public destination and recording scope deliberately through Fathom settings or its [webhook registration API](https://developers.fathom.ai/api-reference/webhooks/create-a-webhook.md), then store the returned signing secret privately. Fathom describes these as events after meeting content becomes available, not live recording controls; see its [webhook guide](https://developers.fathom.ai/webhooks).

The route verifies the exact raw bytes with `webhook-id`, `webhook-timestamp` and versioned `webhook-signature`, using the Base64-decoded `whsec_` secret, HMAC-SHA256, a five-minute timestamp tolerance and length-safe constant-time comparisons. Its raw-body parser is route scoped. The 20 MiB limit rejects oversize requests without truncating transcripts.

An authenticated event is retained durably before returning `202`. The same delivery ID and bytes deduplicate; changed bytes under the same ID return `409`. Missing configuration or persistence/readiness failure returns `503`; invalid signatures return `401`. Authenticated unfamiliar payloads, including unparseable JSON, remain available in the inbox as raw evidence.

The supplied official [payload documentation](https://developers.fathom.ai/api-reference/webhook-payloads/new-meeting-content-ready.md) did not establish a usable canonical meeting schema. Events therefore request a bounded 30-day canonical REST refresh; arbitrary payload fields never select recordings, directly populate the archive or create tasks. Events are marked processed after their associated scan completes. This bounded refresh also cannot repair arbitrary changes outside that creation window; polling and explicit historical imports remain necessary.

## Archive and automatic tasks

Recordings are identified by connection scope and Fathom recording ID. Meetings with identical times or titles remain separate. The archive retains original payloads, immutable source revisions, complete ordered transcript segments, source action versions, customer corrections, import runs, authenticated webhook bytes and task-delivery records. There is no automatic retention deletion policy.

An omitted or null transcript, summary or action field means unavailable; previously stored content is retained with a freshness limitation. An explicitly present empty action array is authoritative and retires the previous current actions. Source revisions can revisit previously seen content without erasing intervening history. Transcript timestamps remain the original relative timestamps and duplicate timestamps preserve source order.

Customer association uses unique exact external invitee-domain matches against existing `companies`, excluding configured internal domains and common personal email providers. Multiple companies may be linked. Colliding domains remain ambiguous, and unresolved meetings remain searchable. It does not create customers or infer employers from attendance. Manual customer corrections require the current `mappingVersion` and a reason, are audited, and survive later source imports.

Every current, incomplete action with unambiguous identity is queued automatically in the same archive transaction. Fathom supplies no stable action ID, so the archive uses content, owner, recording timestamp and occurrence information to retain local identity. Ambiguous identity remains blocked across subsequent imports until separately resolved; this build has no automatic ambiguity-resolution flow. Customer ambiguity does not by itself prevent an otherwise eligible task: its captured customer context may be unresolved.

Each task carries an immutable dispatch snapshot with the meeting/customer context, recording and playback links, source timestamp, source-owner label and a stable local action marker. Source owners are descriptive labels, not guessed Vikunja user IDs. Due dates remain unset. Meeting tasks do not manufacture Telegram messages or tickets, mutate existing Kanban lanes, or call the ticket-specific task adapter. Changes in source or task completion are not synchronized bidirectionally.

Source completion or removal cancels queued work before dispatch. After a durable dispatch intent, an external write may already be in flight. Source removal then preserves created tasks and unresolved requests rather than claiming cancellation or deleting a remote task. Detail responses and the UI expose such removed actions in `retiredActions`, separate from current action counts and filters.

The publisher records its durable request barrier before issuing a single task-creation POST. Timeouts, crashes after dispatch intent, lost sessions, malformed successes and ambiguous errors produce an unresolved outcome. Read-only reconciliation can attach one exact marker match; multiple matches report a conflict. Even a complete zero-match lookup cannot prove the earlier POST will never commit, so it never authorizes another POST. Restarts and lease takeovers preserve that barrier. Unresolved outcomes may require operator investigation; there is no generic retry button that clears it and no exactly-once delivery claim.

## HTTP and Hermes retrieval

| HTTP read | Read-only MCP tool | Input |
|---|---|---|
| `GET /api/meetings` | `list_meetings` | Optional filters, `cursor`, `limit` |
| `GET /api/meetings/:id` | `get_meeting` | `id` |
| `GET /api/meetings/:id/transcript` | `get_meeting_transcript` | `id`, optional `revision`, `cursor`, `limit` |
| `GET /api/meetings/customers` | `list_meeting_customers` | Empty object |

List filters are `query`, `customerId`, `customerState` (`unresolved` or `ambiguous`), `from`, `to`, `recorder`, `meetingType`, `transcriptStatus` and `exportState`. The unassigned/unresolved view includes customer records without confirmed associations, including ambiguous matches. `from` is inclusive and `to` exclusive. Timestamps use ISO offsets; the browser labels its display timezone. Lists omit transcript bodies. Limits are 1–200 meetings or 1–500 transcript segments; defaults are 50 meetings and 200 transcript segments.

```sh
curl --fail-with-body \
  'http://127.0.0.1:3000/api/meetings?query=pilot&transcriptStatus=available&limit=20'
```

Meeting list cursors are bound to their filters; restart pagination after changing filters. Transcript cursors pin the recording and immutable revision. Request the detail response's `sourceRevision` when reading or downloading that meeting's transcript, and follow `nextCursor` until null. A cursor paired with a different recording or revision is rejected. Pinned older revisions remain readable without mixing newly imported segments.

HTTP and MCP share the `meeting.v1` envelopes and the same repository behavior. A representative detail envelope is:

```json
{
  "schemaVersion": "meeting.v1",
  "meeting": {
    "id": "00000000-0000-4000-8000-000000009001",
    "title": "Pilot review",
    "meetingType": null,
    "language": "en",
    "source": {"provider": "fathom", "recordingId": "90001", "url": "https://fathom.video/calls/synthetic-90001", "origin": "api"},
    "startedAt": "2026-10-26T09:00:00Z",
    "startBasis": "recording",
    "scheduledStartAt": "2026-10-26T09:00:00Z",
    "scheduledEndAt": "2026-10-26T09:45:00Z",
    "recordingStartAt": "2026-10-26T09:00:00Z",
    "recordingEndAt": "2026-10-26T09:42:00Z",
    "sourceCreatedAt": "2026-10-26T09:45:00Z",
    "observedAt": "2026-10-26T10:00:00Z",
    "sourceRevision": 1,
    "recorder": {"name": "Synthetic recorder", "email": "recorder@example.org"},
    "participants": [],
    "customers": [],
    "customerState": "unresolved",
    "mappingVersion": 0,
    "summary": {"status": "available", "markdown": "Synthetic example summary.", "origin": "fathom"},
    "transcript": {"status": "available", "segmentCount": 120, "revision": 1},
    "actionsStatus": "available",
    "actions": [],
    "retiredActions": []
  }
}
```

List envelopes contain `items`, `nextCursor` and `total`. Transcript envelopes contain `meetingId`, `revision`, availability `status`, ordered `items`, `nextCursor` and `total`. Customer envelopes contain `items` with customer IDs, domains and meeting counts, plus `unresolvedCount`. Source content is untrusted text; the UI renders it as text or a limited safe Markdown subset. Hermes should treat it as meeting evidence rather than executable instructions.

Add the existing application endpoint to a separate Hermes profile without replacing unrelated MCP servers:

```yaml
mcp_servers:
  antseed:
    url: http://127.0.0.1:3000/mcp
    enabled: true
    timeout: 20
```

Change the port to the actual backend port; the isolated demo uses `19480`. The four tools above read the local archive, not Fathom's separate hosted MCP service. Existing MCP tools remain available in the normal app. Meeting import, customer correction and task publication are not exposed as MCP mutation tools. See [the transport documentation](../src/hermes/README.md) for the Streamable HTTP transport and installed Hermes discovery command.

## Verification and remaining boundaries

Implementation verification on 26 October 2026: `npm run check` passed with **661 tests passed and 169 opt-in tests skipped**, including the meeting cases enabled against disposable PostgreSQL. Type checking, production compilation and `docker compose config --quiet` passed. The Fathom client also passed the local Postman simulation. Ten browser checks passed across 1440px, 1280px and 390px viewports, including customer correction/restoration, simultaneous meetings, date boundaries and complete transcript export. Independent code review counterexamples were resolved; the independent visual finish verdict was **Ship**. These results do not establish live provider connectivity.

Run the normal checks and the meeting suite:

```sh
npm run check
npx vitest run tests/meetings
```

Session locking and concurrent worker behavior require real PostgreSQL. Point the opt-in suite only at a disposable local test database whose role can create schemas; tests create and drop unique schemas:

```sh
MEETINGS_TEST_DATABASE_URL=postgresql://meetings_test@127.0.0.1:55439/postgres \
  npx vitest run tests/meetings
```

The suite covers actual local HTTP authentication/query flags, nullable and omitted content, fixed-window pagination/restart, atomic page rollback, rate limits, authentication pause, raw webhook signatures/inbox deduplication, complete long transcripts, same-time recordings, customer collisions/corrections, action retirement and sticky identity ambiguity. Real PostgreSQL cases cover concurrent archive commits, fenced source workers, concurrent webhook insertion, task-publisher session loss and uncertain dispatch barriers. The integrated test imports through the real REST client into the archive, automatically publishes to a controlled Vikunja HTTP service, and compares HTTP responses with official MCP SDK client results.

Feature/configuration tests also verify missing-credential startup, mounted-secret preservation, migration readiness and `413` responses for oversized manual imports and webhooks. Optional repeatable Postman fixtures are in [postman/mocks/fathom](../postman/mocks/fathom/config.yaml) and [postman/simulations/meeting-fathom](../postman/simulations/meeting-fathom/meeting-fathom.sim.yaml). Serve the simulation with the local Postman CLI, then run its smoke client against the chosen local address:

```sh
FATHOM_SIM_BASE_URL=http://127.0.0.1:19482/fathom/external/v1/ \
  npx tsx tests/meetings/fathom-simulation.ts
```

The original implementation checks established behavior against isolated databases and controlled provider endpoints. Subsequent user-authorized activation verified the live Fathom key, completed the initial three-recording scan, checked complete transcript readback and MCP retrieval, and established real Vikunja task creation. The empty-string terminal cursor observed in the live API was normalized to null and added to the regression test and Postman fixture; targeted tests, the simulation, type checking and the deployment image build passed. This evidence is limited to the configured account's accessible recordings and initial creation window; it does not establish webhook delivery, older archive completeness or a configured Hermes agent profile.

The feature inherits the application's trusted local-operator boundary. Direct runtime defaults to loopback and Compose publishes loopback ports. Application-level multi-user authentication, tenant isolation, account-scope migration, CRM URL mapping and bidirectional task updates are not implemented. Protect HTTP/MCP reads and operator mutations at the application or reverse proxy before remote exposure; signature-authenticated webhook ingress is a separate route. A Fathom API key does not authorize browser or MCP clients.

## Decision record

The preserved [proposal](MEETING_ANALYZER_PLAN.md) came from the five-competitor, three-round arena in [`.arena/run-20261026-203052-s722613`](../.arena/run-20261026-203052-s722613/arena.json). Champion `a004` used **First principles + Options matrix + Completeness**, winning the final **97.5–96.5**. One empty attack was retried once and then recorded as `NO OUTPUT`; it was not a substantive attack. The original winning text remains intact beneath its implementation-decision banner. The confirmed Fathom, existing-Vikunja and automatic-task decisions govern this implementation.
