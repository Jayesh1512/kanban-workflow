# Integrated Outreach CRM

The `/outreach` page and **AntSeed Outreach** Vikunja project are the CRM and the starting point for business conversations. The flow is **Telegram chat → intake approval in Telegram → CRM relationship → concrete Work proposal → separate Telegram approval → Work ticket**. A CRM relationship does not need a Work ticket to import messages, extract contacts/facts or assess its commercial stage.

Approved chats are reconciled directly into CRM sources. Chats for the same confirmed company share one relationship; unknown-company prospects remain separate. Source evidence, facts and contact roles are read by chat provenance, independently of operational tickets. Learning a prospect's first company can preserve its relationship ID; equal names alone do not merge companies.

The five sales stages are Lead / Prospect, Qualification, Negotiation, Deal Won, Archived. Operational testing/completion does not establish a commercial win. Price, credits and sponsorship discussions indicate negotiation until an accepted outcome is evidenced. Silence does not archive a relationship.

## Intake, review and Telegram approval

1. A fresh Telegram conversation queues an intake request in the configured control group. Select historical chats manually using **Request approval**. Discovery alone imports no business messages.
2. Reply **approve to that exact Telegram request** to admit the conversation to CRM and begin import/analysis. Reject or no reply keeps it out. Intake creates no Work ticket.
3. Open `/outreach` and inspect current sources. Propose a sales stage or request an AI assessment. The proposal stays pending; the initial metadata-only native review card does not establish an accepted commercial stage.
4. Approve/reject by replying to the matching CRM message in Telegram. `correct: Qualification` creates a separate pending stage proposal that also needs approval. Approval enrolls pending sources, records its decision and queues native publication.
5. CRM follow-up, identity, Work action/deadline and source-fact edits also create pending data proposals. Their values remain unchanged until the matching Telegram message is approved. Data approvals do not accept a new CRM stage or enroll additional sources.

The web page and MCP propose changes; they cannot approve them. Legacy HTTP decision endpoints reject decisions in CRM-first mode. The local manual-intake helper also rejects admission in this mode. Automatic initial-placement exceptions are disabled by the CRM-first migration. Routine publication refreshes may reuse already accepted stages and sources; they cannot create Work, enroll new sources or authorize stage changes.

The control worker correlates intake, Work movement and CRM/data/Work-creation receipt IDs to exactly one owner. Missing control setup retains proposals. Duplicate replies are idempotent; excluded, edited or remapped sources invalidate outdated approvals. Native dragging is not approval: it is recorded as a conflict, while the accepted stage remains unchanged.

## Create Work from CRM

Open an accepted CRM relationship and expand **Propose a Work ticket**. Choose one approved Telegram conversation, enter a concrete action and its reason, then select **Request Work ticket approval**. Reply **approve** to the separate Telegram request to create that action in **To be started**. No reply/reject creates no ticket. Moving CRM to Qualification, Negotiation or Won does not create Work by itself.

Each approved action creates its own Work ticket, so one CRM relationship or chat can have several tasks. The ticket stores its CRM parent and creation proposal; replaying the same approved proposal cannot create a second ticket. The relationship detail lists its linked Work tickets. Work lane recommendations use their own Telegram approvals and leave the CRM stage unchanged.

The migration preserves existing Work cards, stages, remote IDs and CRM relationships, and backfills parent links where they already exist. It does not delete historical cards or convert existing accepted stages.

`POST /api/outreach/relationships/:relationshipId/work` and MCP `propose_crm_work` take `chatId`, `action`, `reason`, `expectedEvidenceRevision` and `idempotencyKey`. They return a pending proposal rather than a ticket. The selected source must currently belong to the accepted CRM relationship. `POST /api/tickets` / `ensure_ticket` cannot bypass this workflow.

## Email reports

The import disclosure accepts structured JSON, previews coverage and commits the report as pending source context. HTTP endpoints are:

- `POST /api/outreach/imports/preview`
- `POST /api/outreach/imports/:id/commit`
- `GET /api/outreach/imports/:id`

The strict schema is [outreach-schemas.ts](../src/shared/outreach-schemas.ts). Reports require a namespace, checked timestamp, coverage and stable thread keys. Each thread supplies its company/person, contacts, dated claims, next action and optional provisional stage. An explicit known `companyId` joins an existing directory company. Names/domains alone do not silently merge identities.

Identical imports are idempotent. A changed report supersedes the prior committed namespace version, changes source revisions and invalidates pending decisions; removed threads are suspended. Reports are preserved as attributed report claims, **not authenticated original mailbox messages**. No email is sent and no mailbox credentials/feed are implied.

## Follow-ups and identity

The card's follow-up disclosure proposes an AntSeed action with an optional calendar date for Telegram approval; it does not invent a midnight timestamp. The API also supports external/unknown actors, completion/cancellation, exact instants and optimistic actions versions. Accepted detail changes have a durable refresh intent, so a restart between the action update and publication does not lose the refresh. The accepted sales stage remains unchanged.

Display-name corrections use `PUT /api/outreach/relationships/:relationshipId/identity`, expected identity version and a reason. They create a pending Telegram approval and retain an audit record on acceptance. This operation does not merge distinct companies or rewrite Telegram mappings. Correct a company association through the existing sourced mapping operation or an explicit report `companyId`.

## Hermes

Use the existing backend `/mcp` endpoint. These additions share the same service instances as HTTP:

- `list_outreach_relationships`, `get_outreach_relationship`
- `propose_sales_stage`, `list_sales_proposals`, `get_sales_proposal`
- `propose_crm_work` (concrete action proposal; never creates Work before Telegram approval)
- `update_sales_actions`, `correct_sales_identity`
- `assess_sales_relationship` (bounded paid classification), `get_sales_status`

There is no MCP or HTTP approval escape in CRM-first mode. There is no MCP apply, direct-move, Telegram-send, login or raw-file-import tool. For example: “Show Qualification relationships and their pending AntSeed commitments,” or “Propose Qualification for this relationship using its current evidence revision; do not approve it.”

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
