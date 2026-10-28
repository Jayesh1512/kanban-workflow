# Meeting Analyzer implementation plan

> **Confirmed implementation decisions — 2026-10-26:** Use Fathom, the existing Vikunja project and **automatic task creation**, as explicitly confirmed by the user. Eligible current, incomplete, unambiguous actions queue without review; this overrides the review-first defaults in the original winning proposal preserved below. Signed webhooks are durable refresh signals for canonical REST ingestion, and live provider access/deployment updates remain unverified. See [implemented setup and behavior](MEETING_ANALYZER.md). Arena winner: `a004`, **First principles + Options matrix + Completeness**, five competitors / three rounds, final **97.5–96.5**; [full record](../.arena/run-20261026-203052-s722613/arena.json).

Build Meeting Analyzer as an additive feature of this application. Fathom supplies meeting recordings, transcripts, summaries and action items; PostgreSQL owns the searchable archive, customer associations, corrections and task handoff history. Hermes reads that archive through new tools on the existing `/mcp` endpoint.

The first build should deliver a working vertical slice: import Fathom meetings, browse customer history and full meeting details, and retrieve the same records through MCP. Follow with verified webhooks and reviewed Vikunja task publication. No credentials are needed to build or test those slices.

## Decision and assumptions

The realistic choices are:

| Approach | Uses current customer/task data | Owns complete historical archive | Implementation effort | Decision |
|---|---|---|---|---|
| Configure Hermes against Fathom MCP only | Weak | No local archive | Low | Useful optional connection, insufficient for this project |
| Separate application and database | Requires another integration | Yes | High | Defer unless separation becomes a requirement |
| Add meeting services, screens and tools here | Strong | Yes | Moderate | Choose |

Confirmed requirements are Fathom ingestion, complete transcripts plus summaries/action items, customer grouping, simultaneous meetings, task handoff, useful filters and standard historical retrieval for Hermes.

Reversible defaults: extend AntSeed rather than replace it; use existing `companies` as customers; begin with the current single-operator deployment; use Fathom's extracted output without another paid AI call; require review before exporting an action item; target Vikunja initially because this repository already integrates it. Keep the task destination behind a new port so another manager can replace it. These are implementation choices, not answers the user has supplied.

When a connection is explicitly enabled, suggest a bounded 30-day initial import, displayed as a creation-time coverage window. Older history can be imported in resumable batches. No unattended all-history import, webhook registration, remote task creation or paid extraction during the initial build. Missing Fathom credentials must produce `unconfigured`, never prevent the existing app from starting.

## Repository integration

Inspection establishes these integration points:

- `src/composition.ts` currently composes platform and workflow modules. Keep that composition. Create the meeting service graph from `createWorkflowServices()` in `src/workflow/module.ts`, with implementation isolated under new `src/meetings/` files. Register its page and worker there, and pass its domain service into the existing transport graph. This shares the existing readiness gate and avoids a competing `/mcp` registration.
- `src/shared/ports.ts` contains `DomainServices`, `RuntimeConfig`, `Database`, and `PlatformServices`. Add a meeting domain service and optional connection configuration. Normalize absent meeting config to disabled at the feature boundary so existing programmatic configurations remain valid.
- Add catalog entries in `src/shared/api.ts` and corresponding Zod bindings in `src/hermes/bindings.ts`. `src/hermes/http.ts` and `src/hermes/mcp.ts` already share service behavior. Preserve that design; browsers and Hermes must call the same meeting service methods.
- Add `GET /meetings` from a new `src/meetings/page.ts`, following the existing server-rendered HTML approach in `src/outreach/page.ts`. Keep platform onboarding at `/` and outreach at `/outreach`; add a small navigation link without redesigning either.
- Use one new migration, for example `db/migrations/202610260003_meetings.sql` after checking the current directory. `src/platform/database.ts` discovers migrations and validates checksums. Never change an applied migration, including the currently uncommitted outreach migrations.
- Reuse `createMigrationGate` or the workflow readiness function; do not run meeting SQL before the complete migration ledger is valid. Add independent bounded meeting worker scheduling and drain/abort it through the workflow's existing stop lifecycle.

The working tree already contains substantial outreach, Hermes, SQL, configuration and design changes. Start implementation by recording status and reading current hunks; make narrow additive edits in the current tree. Do not reset, replace files from a clean checkout, or format unrelated code.

## Fathom contracts and ingestion

Use REST for application ingestion. Fathom's authenticated MCP endpoint, `https://api.fathom.ai/mcp`, is a separate client connection; it does not populate this application's database. Do not assume Fathom tool names or that Hermes authentication compatibility has been tested.

The verified [meeting contract](.arena/reference/fathom-meetings.md) is `GET https://api.fathom.ai/external/v1/meetings` with server-side `X-Api-Key`. Request `include_transcript=true`, `include_summary=true`, `include_action_items=true`, and optionally `include_crm_matches=true`. Follow `next_cursor` until null; the response is `{items, limit, next_cursor}`. There is no documented request page-size parameter in the supplied contract. Do not invent one or an individual-meeting endpoint.

Important semantics:

- `created_after` and `created_before` filter Fathom `created_at`, not meeting start. Archive filtering must use stored meeting timestamps independently.
- Useful supported upstream filters include exact invitee company domains, domain type, recorder emails, team names and meeting type. Recorder/team filters affect access scope; do not describe this as importing every meeting in the organization.
- Summary and transcript inclusion on this endpoint is unavailable for OAuth-connected apps. Choose the API-key connection for this implementation. OAuth would require separately verifying the `/recordings` contract.
- Transcript items contain speaker information, text and relative `HH:MM:SS` timestamps. Preserve their order and original timestamps. Summary is `default_summary.markdown_formatted` with a template name. Action items carry description, assignee, completed/user-generated flags, recording timestamp and playback URL; the supplied action contract contains no due date or stable action ID.
- Null, omitted and empty fields have different meanings. Store availability explicitly. A missing transcript is “not available from Fathom,” not a complete empty transcript. Do not overwrite a previously complete component with a response that omitted its include field.

Proposed connection configuration: `FATHOM_API_KEY`, `FATHOM_ENABLED=false` by default, polling interval, request timeout, optional webhook secret, and bounded import settings. Validate without making network calls at construction. Never return secrets in `/api/status`, MCP output or logs.

Implement `src/meetings/fathom.ts` with injected `fetch` and clock, response validation, abortable timeout, and pagination. Store durable import runs with fixed creation bounds, filters, cursor, imported counts and errors. Upsert a page and advance its cursor in the same transaction; after a crash, replaying a page is harmless. After a successful bounded scan, advance the coverage checkpoint. Start periodic scans with overlap and run configurable deeper reconciliation because creation-time overlap alone cannot discover arbitrary edits to old recordings. Show last successful coverage and failures rather than claiming perfect synchronization. Back off on 429/5xx, honor valid `Retry-After`, and pause authentication failures until configuration changes or an explicit retry.

Use webhooks to reduce latency after the archive works. The official [webhook guide](https://developers.fathom.ai/webhooks) and [registration contract](https://developers.fathom.ai/api-reference/webhooks/create-a-webhook.md) describe post-meeting events, not a live recorder. Configure transcript, summary and action inclusion; choose recording scopes explicitly. Building the endpoint does not register a webhook or prove that Fathom can record simultaneous meetings under the user's plan.

`POST /api/integrations/fathom/webhook` must capture the exact raw body in a route-scoped Fastify parser. Verify `webhook-id`, `webhook-timestamp`, and versioned `webhook-signature` before parsing: HMAC-SHA256 of `id.timestamp.rawBody`, using the Base64-decoded secret after `whsec_`, timestamp tolerance around five minutes, length-safe constant-time comparison across valid signatures. Malformed headers fail safely. Persist an authenticated inbox row before returning 202; return retryable failure when persistence fails. Deduplicate by connection and webhook ID. Oversized requests are rejected and repaired through polling; never silently truncate transcripts.

The saved payload page does not provide a usable field schema. Do not infer that its body equals a list-meetings item. Initially treat verified events as durable refresh signals for bounded REST reconciliation. Once an actual authorized sample or complete official schema is available, add a versioned normalizer for direct content. Keep unknown authenticated shapes diagnosable without losing the event. No unverified webhook fields may trigger task export.

## Data ownership, customers and concurrent meetings

Create these tables, with foreign keys, UTC `timestamptz` values, indexes and JSON validation at the service boundary:

| Table | Owned data and key |
|---|---|
| `meeting_connections` | Stable source/account scope, enabled state and synchronization metadata; no API key in ordinary rows |
| `meetings` | Internal UUID; unique `(connection_id, recording_id)`; titles, source URLs, recorder, language, Fathom creation time, scheduled and recording intervals, current revision and component availability |
| `meeting_revisions` | Immutable normalized source snapshot and content hash, original payload, observation/source metadata; unique meeting/content hash |
| `meeting_transcript_segments` | Revision, ordinal, speaker/name/email, relative timestamp and complete text; unique revision/ordinal |
| `meeting_actions` / `meeting_action_versions` | Stable local UUID plus immutable per-revision membership/content; source fingerprint, current/retired/superseded/ambiguous state, first/last-seen revision, corrections, source completion, review/version and provenance |
| `meeting_customer_links` | Meeting/company links with candidate/confirmed/rejected state, method, supporting values, manual authority and version |
| `meeting_import_runs` / `meeting_webhook_inbox` | Durable cursors, coverage, delivery deduplication, leases and retry/error state |
| `meeting_task_exports` / `meeting_remote_requests` | Action/destination/project identity, approved action/source versions and immutable snapshot, unique export key, outbox state; durable pre-dispatch request barrier, terminal receipts, reconciliation evidence and remote ID |

Keep meeting evidence in meeting tables. Existing `evidence` is tied to the Telegram workflow; do not manufacture Telegram messages or tickets to satisfy that schema. Existing companies are references, not copied customer records. Fathom owns source facts; this app owns manual associations, action corrections and export decisions. Reimporting cannot erase manual choices or silently change an already approved task snapshot.

A recording ID, not its time or title, identifies a meeting. Two meetings at 10:00 remain separate, and two meetings for the same customer remain separate history entries. Different authorized connection scopes may expose the same recording: preserve scoped source ownership first, and only offer an explicit verified consolidation later.

Customer matching order: authoritative manual link; explicitly configured CRM record-URL mapping; unique exact match from normalized external invitee domains to existing company domains. The database intentionally allows nonunique company names/domains, so collision means review. Exclude configured internal domains and common personal email providers from automatic domain association. Title/name similarity and new CRM names create candidates only. Do not auto-create companies, infer employment from attendance, or silently merge customers. Multiple external companies may produce multiple links; unresolved meetings remain visible and searchable. A manual correction must use expected version, record its reason and survive subsequent imports.

Deduplicate source snapshots by content hash. Serialize commits per recording using row locks, while different recordings can ingest concurrently. Durable workers claim bounded jobs using `FOR UPDATE SKIP LOCKED`, leases and fencing tokens so expired workers cannot finalize over a newer owner. Never hold a database transaction across HTTP. Serialize refreshes for a connection or use fenced scan generations so late responses cannot replace a newer canonical snapshot. Webhooks trigger canonical refresh rather than last-arrival-wins source updates.

Action identity needs particular care: Fathom supplies no stable action ID. Match identical items using description, recording timestamp, assignee and occurrence ordinal to distinguish duplicates. Store action membership against the source revision. Changed items become a new source revision/candidate; ambiguous matches require reconciliation, with both potential identities blocked from automatic export. Previously exported or manually corrected actions retain their local IDs, audit trail and task links; changed source wording must not automatically create another task.

A validated, explicitly present `action_items` array is an authoritative set for that observation: `[]` retires every previously current source action. Omitted or null action fields mean unavailable/unknown and never prove removal; preserve the last known set with its originating revision and freshness status. On a complete set update, mark unmatched old actions `retired` (or `superseded` only after a reviewed replacement mapping), record the removal revision, increment their versions and invalidate unconsumed approvals in the same transaction that advances the meeting revision. Preserve local corrections and successful exports as historical records. Reappearance or changed content requires fresh review; an old approval cannot silently reactivate.

Cancel queued exports for retired/superseded actions before dispatch. Approval and publisher dispatch both lock the same action/export rows and require current source membership plus the approved action/content version; a stale approval returns conflict. The durable dispatch-intent commit is the boundary after which an external effect may already be in flight: a later source removal marks that export `source_removed_after_dispatch`, preserves any unknown-outcome barrier or completed remote task, and requests operator review rather than claiming cancellation or deleting a remote task. Any explicitly retained local follow-up from a removed source item requires a separate operator decision and new approval, labeled with historical provenance.

HTTP, UI and MCP default action lists/counts use the same current-membership query. Removed/superseded items appear only in an explicit history view/filter with their source revisions and export state. For unavailable current action data, show that freshness limitation instead of reporting an authoritative empty set. Pinned historical revision reads return that revision's membership separately from present-day review/export status.

## Browser and Hermes contract

The `/meetings` screen should provide a customer history sidebar/list and meeting list with start date/time, duration, customer associations, recorder, title, transcript availability and action/export counts. Detail view shows source links, scheduled versus recorded times, complete paged transcript, summary, action provenance, matching controls and reviewed task handoff. Show pending/failed ingestion and missing content clearly. Render transcripts as escaped text and sanitize summary Markdown before HTML display.

Shared list filters: customer ID, unresolved customer, half-open start-time interval `[from,to)`, recorder, meeting type, transcript availability, text query, action review state and export state. Use recording start with scheduled-start fallback and label the chosen basis. Store UTC; display using configured IANA timezone. Date-only UI selections become timezone-correct UTC boundaries, including DST. Deterministic keyset pagination uses `(effective_start_at,id)` and an opaque cursor bound to the filters. Transcript pagination must preserve every segment; no implicit agent response truncation.

Add proposed local tools `list_meetings`, `get_meeting`, and `get_meeting_transcript`; these are our names, not claimed Fathom tools. Add corresponding HTTP reads, customer-link correction, explicit sync/import requests and action review/export routes to the catalog. Keep task export and customer correction operator-only initially; Hermes retrieval is read-only.

Use a versioned Zod output envelope for both transports:

```json
{
  "schemaVersion": "meeting.v1",
  "meeting": {
    "id": "uuid",
    "source": {"provider": "fathom", "recordingId": "123", "url": "https://fathom.video/..."},
    "title": "Customer review",
    "startedAt": "2026-10-26T10:00:00Z",
    "customers": [{"id": "uuid", "name": "Acme", "state": "confirmed"}],
    "summary": {"status": "available", "markdown": "...", "origin": "fathom"},
    "actions": [],
    "transcript": {"status": "available", "segmentCount": 120, "revision": 1},
    "sourceRevision": 1,
    "observedAt": "2026-10-26T11:00:00Z"
  }
}
```

Define nullable time fields, action versions, source membership/presence revision and freshness, assignee, evidence timestamp/playback link, local review/export state and pagination in the actual schemas. Transcript retrieval returns meeting ID, pinned source revision, ordered segments and `nextCursor`; revision changes yield a restart/conflict instead of mixing versions. Lists omit transcript bodies. MCP already returns text JSON and `structuredContent`; use that existing behavior and describe source text as untrusted data. Provide a Hermes configuration example pointing at the local `/mcp`; verify initialization, tool listing and calls with the SDK client before claiming compatibility.

Initial deployment inherits the current trusted local-operator boundary and default loopback host. Document that team isolation is not implemented. Before exposing meeting reads remotely, enforce access at the application/reverse-proxy boundary for HTTP and MCP, keeping the webhook's signature-authenticated ingress separate. A source API key is not client authorization.

## Task handoff

Use `MeetingTaskPort`, implemented by a dedicated Vikunja action adapter. Do not call existing `VikunjaPort.ensureTask`: it requires a real `ticketId`, writes `tickets.vikunja_task_id`, and represents customer Kanban cards rather than independent meeting actions.

Review lets the operator correct title, customer, assignee and optional deadline, choose a configured destination project, and approve/export with an idempotency key plus expected action version. Unknown source deadlines remain null; preserve date-only versus exact-time precision. Each exported task includes meeting/customer context, the source playback link and a stable marker derived from the local action/export UUID. Persist the approved snapshot and outbox row before any remote call. No new project is created silently.

The publisher must use a durable uncertain-write barrier, not just local uniqueness or marker search. `src/outreach/publisher.ts` already demonstrates pre-dispatch request records and immutable response receipts; borrow that safety pattern without sharing outreach tables or remote board ownership. A dedicated meeting adapter must not inherit generic automatic POST retries from `src/vikunja/adapter.ts`.

Serialize per action/destination and use an atomic guarded transition to record a request UUID, exact payload, approved action/source versions and `dispatched` barrier before invoking the network once. All later workers, lease takeovers, restarts, approval replays and mode toggles must observe that barrier. A process crash after the dispatch record but before `fetch` is conservatively uncertain. Fencing prevents stale SQL finalization but cannot revoke a remote request already sent. Persist a late terminal response as an immutable receipt even if the originating worker lost ownership; only the current owner may interpret it and update business state.

Timeout, abort, lost session, missing receipt, malformed successful response or a potentially side-effecting server error means `unknown`; do not retry creation. Read-only reconciliation can attach one verified marker match and store its task ID/URL, while multiple matches raise a conflict. A complete zero-match search does **not** release the barrier: the earlier POST could still commit after that read. Elapsed time, client cancellation and an expired worker lease prove no remote quiescence. A terminal failure permits retry only if its verified provider semantics establish no task was created; a 5xx alone is insufficient. After a known successful request with missing task ID, keep reconciling rather than reposting.

Release an uncertain barrier only with durable evidence that the original operation cannot still commit and a complete authoritative lookup after that point establishes no task exists—for example a provider-backed request outcome or verified server-side quiescence. No such Vikunja facility is assumed here. The default when evidence is unavailable is a visible unresolved export requiring operator investigation; an operator can attach a verified existing task, but a generic retry/acknowledge button cannot declare absence. Provider-enforced idempotency could later enable safe replay after its actual semantics are verified. This deliberately trades unattended progress for preventing a second create while the first may remain live; do not advertise exactly-once delivery.

Changes in Fathom completion or task completion do not synchronize bidirectionally by default. Source removal after dispatch remains visible without deleting the task. This keeps automatic ingestion separate from approval while delivering real tasks through a replaceable destination adapter.

## Build sequence and acceptance

1. **Implement now: archive vertical slice.** Add the migration; `src/meetings/{domain,schemas,repository,fathom,service,page}.ts`; meeting config; workflow construction/lifecycle; catalog/bindings; `/meetings` navigation. Implement explicit bounded REST import plus disabled-until-enabled polling, full storage, customer matching, filters, detail/transcript pagination and three read-only MCP tools. Include sanitized synthetic Fathom fixtures and import status. This slice is complete when two overlapping meetings for one company import once, appear independently in its history, retain full transcripts, and return identical source revisions through HTTP and MCP. It starts and existing screens work with no Fathom key.
2. **Reliable automatic delivery.** Add `webhook.ts`, raw-body verification, durable inbox/retries, refresh signals, coverage/reconciliation controls and status. Add direct webhook normalization only against verified payload evidence. Register or test a live webhook only after connection configuration is supplied; inspect registration response and record returned signing secret securely.
3. **Task publication.** Add action review/versioned corrections and current/retired membership reconciliation, export outbox plus durable request barriers/receipts, destination port and Vikunja adapter/reconciliation. Make approval-to-remote-task work against a local test server before any configured external write. Retain review as a setting so automatic export can later be deliberately enabled.
4. **Operational completion.** Exercise authorized live Fathom import and two simultaneous recordings if available, webhook receipt, history scope, Hermes configuration and one reviewed task. Verify actual recording availability/account permissions rather than infer them from successful HTTP mocks. Team permissions, a different task manager, broader history and optional AI re-extraction remain configurable follow-up decisions, not blockers for the archive build.

Use Vitest plus PostgreSQL-compatible PGlite fixtures following `tests/workflow/database.ts` for migrations, normalized storage, customer ambiguity, source preservation, action identity and removals, filters and cursor/revision contracts. Test populated→empty action arrays versus omitted/null fields, retirement with manual corrections, canceled queued exports, stale approvals, reappearance, and HTTP/MCP current versus historical action counts. Use HTTP fakes for exact Fathom query flags, nullable fields, multipage resume, 401/429, crashes and oversized content. Verify webhook signatures with literal raw-body differences, malformed/multiple signatures, stale timestamps and duplicate delivery. Test Fastify injection and the official MCP client to ensure filters, errors and output agree.

Run real PostgreSQL tests for concurrent page/webhook commits, job leasing/fencing, migration readiness, session loss and export reconciliation. PGlite's fixture explicitly cannot prove session/advisory locks. Test task POST timeout-after-success and approval replay against a controlled server. Hold POST A open, time it out, perform a complete marker lookup returning zero, expire its worker lease and restart the publisher; assert that no POST B is sent even when A later commits. Also test crash after dispatch intent but before fetch, late receipts after session loss, duplicate markers, ambiguous 5xx, and concurrent source removal versus dispatch. An unresolved request must survive all retries/mode toggles; only verified resolution may settle it. Keep live provider tests opt-in; passing fixtures does not establish real Fathom access, public webhook delivery or Hermes client authentication.

Run `npm run check` after each complete slice. Capture any pre-existing failures before changes and distinguish them from regressions; preserve incumbent Telegram, outreach, Kanban projection and MCP tools. Acceptance is evidence of complete persisted meeting history and safe task handoff, not merely an endpoint returning sample JSON.
