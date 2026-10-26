# Integrated Outreach CRM

The `/outreach` page and **AntSeed Outreach** Vikunja project are the commercial pipeline. The existing work project retains its six lanes and its chat tickets. A confirmed company can have several conversation sources and one commercial relationship. Learning an unpublished or singly mapped prospect's first company preserves its relationship ID; equal names alone do not merge companies.

Every retained active work ticket is reconciled into a CRM source independently of operational projection and provider work. Unlinked tickets are prioritized; a failed source is recorded and retried without blocking the rest of the sweep. Multiple chats for a confirmed company share one commercial relationship.

The five sales stages are Lead / Prospect, Qualification, Negotiation, Deal Won, Archived. Operational testing/completion does not establish a commercial win. Price, credits and sponsorship discussions indicate negotiation until an accepted outcome is evidenced. Silence does not archive a relationship.

## Review and approve

1. Open `/outreach`, search a company/person and expand its card.
2. Review approved and pending source contributions separately. Contacts, actual author/forward provenance, current evidence, AntSeed/external actions and date-only deadlines remain attributable to their source.
3. Choose a sales stage and enter a reason, or request one paid AI assessment. A recommendation remains pending. Low-confidence, malformed, stale or unavailable inference never becomes an accepted stage.
4. Approve/reject on the page or reply to the matching sales message in the configured Telegram control group. `correct: Qualification`, for example, creates a separate pending replacement that still needs approval.
5. Approval atomically enrolls the selected pending sources, records its immutable decision and queues a native publication. Approved state, observed native state and publication status are distinct. Approving another source at the same sales stage refreshes details without increasing the stage version or requiring a lane move.

The control worker correlates intake, work and commercial receipt IDs to one owner. It retains early valid replies while an attempted delivery's receipt is unknown. It never broadcasts an approval to both boards. Missing control configuration retains proposals; it does not invent a control group.

The persisted `telegram:automatic-since` policy may authorize one initial sales placement for qualifying historical Telegram sources. Every contributing source must qualify; email reports cannot inherit that permission. Future groups at/after the configured group boundary require their first sales approval, and subsequent inferred commercial changes require approval. Old operational placement is not itself a sales approval.

## Email reports

The import disclosure accepts structured JSON, previews coverage and commits the report as pending source context. HTTP endpoints are:

- `POST /api/outreach/imports/preview`
- `POST /api/outreach/imports/:id/commit`
- `GET /api/outreach/imports/:id`

The strict schema is [outreach-schemas.ts](../src/shared/outreach-schemas.ts). Reports require a namespace, checked timestamp, coverage and stable thread keys. Each thread supplies its company/person, contacts, dated claims, next action and optional provisional stage. An explicit known `companyId` joins an existing directory company. Names/domains alone do not silently merge identities.

Identical imports are idempotent. A changed report supersedes the prior committed namespace version, changes source revisions and invalidates pending decisions; removed threads are suspended. Reports are preserved as attributed report claims, **not authenticated original mailbox messages**. No email is sent and no mailbox credentials/feed are implied.

## Follow-ups and identity

The card's follow-up disclosure records an AntSeed action with an optional calendar date; it does not invent a midnight timestamp. The API also supports external/unknown actors, completion/cancellation, exact instants and optimistic actions versions. Accepted detail changes have a durable refresh intent, so a restart between the action update and publication does not lose the refresh. The accepted sales stage remains unchanged.

Display-name corrections use `PUT /api/outreach/relationships/:relationshipId/identity`, expected identity version and a reason. They retain an audit record. This operation does not merge distinct companies or rewrite Telegram mappings. Correct a company association through the existing sourced mapping operation or an explicit report `companyId`.

## Hermes

Use the existing backend `/mcp` endpoint. These additions share the same service instances as HTTP:

- `list_outreach_relationships`, `get_outreach_relationship`
- `propose_sales_stage`, `list_sales_proposals`, `get_sales_proposal`
- `update_sales_actions`, `correct_sales_identity`
- `assess_sales_relationship` (bounded paid classification), `get_sales_status`

There is no MCP approval, apply, direct-move, Telegram-send, login or raw-file-import escape. For example: “Show Qualification relationships and their pending AntSeed commitments,” or “Propose Qualification for this relationship using its current evidence revision; do not approve it.”

Sales inference uses the existing configured OpenAI Decisions `gpt-6-luna` client and credentials. The [official Decisions guide](https://developers.openai.com/api/docs/guides/decisions) documents its typed choice contract. This is a separate commercial rubric; the operational six-lane classifier is preserved. Automatic assessments are bounded and source-hash deduplicated. Failed/uncertain results are retained; an explicit retry can recover the same current revision. Missing conversation evidence is not submitted for paid inference.

## Native publication and recovery

`GET /api/outreach/status` exposes board URLs, mode, pending publications, conflicts and unresolved request IDs. `PUT /api/outreach/mode` accepts `observe`, `publish`, `paused`. Publish enables bounded classification and accepted native publication. Pause stops new turns; already-dispatched work still needs its normal receipt/readback recovery.

Relationships awaiting their first sales-stage approval have a metadata-only review card in Lead / Prospect. Its title says “Review initial sales stage”; no accepted stage, enrollment, message claims, or inferred commercial outcome is created by that projection. Approval upgrades the same card. Excluding its last eligible source retires it.

Routine polling timestamps and work-board projection bookkeeping do not change source revisions. Actual conversation, mapping, or business-content changes queue a refresh of already approved descriptions while preserving the accepted sales stage. New source enrollments and stage changes retain their approval requirement. A replacement publication supersedes obsolete conflicts while retaining their audit records.

The managed project has namespace, relationship and generation markers. Default bucket is Lead / Prospect; no sales bucket is the done bucket. Won/Archived do not set task `done`. Every native mutation has a request journal persisted before HTTP dispatch, serialized by the canonical relationship session lock. Network I/O occurs outside SQL transactions.

Vikunja 2.7 requires the unique index `UQE_task_positions_task_project_view` on `(task_id, project_view_id)`. Its migration ID is `20260617153629`. If an older schema transfer retained the migration row but lost that index, task creation fails with PostgreSQL `42P10`. Pause CRM publication, verify there are no duplicate `(task_id, project_view_id)` pairs, restore that exact unique index under a database lock, confirm task creation/readback, and then resume publication. Never mark the migration applied or create the index before checking duplicates.

A dispatched request without a durable terminal response quarantines that resource. **GET at the old or target bucket is not proof that an earlier request cannot still execute.** Timeouts, aborts, restarts and a mode toggle do not release this barrier. A late worker may append its immutable endpoint receipt; a fresh coordinator validates that receipt before readback. A permanently lost receipt can require a particular service-side request drain investigation. No unsafe “force retry” endpoint is supplied. Other independent cards continue.

Source exclusions/edits remove previously published descriptive claims through the same managed request journal. A detached derived sales card is retired with an audit snapshot, without deleting its operational ticket or treating retirement as a sales archive. Native attachments prevent automatic destructive retirement until they are preserved. Distinct company merges are not exposed as a blind operator shortcut.

A human native-stage move is drift, not an implicit business approval. Inspect the conflict and create an explicitly approved proposal with `restoreNative:true` to restore a reviewed target. The UI offers that choice for a conflicted card. The old unresolved-request guard still applies.

## Deployment and rollback

All CRM migrations, including the stable source-revision migration, must be present in the image. Exact migration names/checksums gate HTTP, MCP, control decisions and scheduler work. Build the complete image; do not overlay only a new catalog onto an old ledger.

Back up the current database, restore-test it privately, then recreate only the intended backend with its existing runtime/database/Telegram volumes and environment. Verify the original work binding, six buckets, authenticated Telegram session and stored group boundary. Verify the separate sales binding and five neutral-done buckets.

Rollback is forward-compatible: pause CRM automation and keep the complete migration manifest. Do not run the old six-migration binary against the extended ledger or delete live database/session volumes. The pre-upgrade database backup is a restore point, not permission to overwrite later business activity.
