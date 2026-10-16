# AntSeed M0 architecture and integration baseline

Status: bounded M0 design and executable foundation. This document and the exported TypeScript files are the integration baseline for two builders. `docs/PROJECT_BRIEF.md` is authoritative. No complete Telegram, Vikunja, inference, proposal, domain-route or MCP implementation ships in M0.

## Runtime and current executable behavior

Use TypeScript ESM, Fastify 5, PostgreSQL 17, `pg`, Zod 4 and the official MCP TypeScript SDK. Use native `fetch` for upstream HTTP adapters; avoid inventing compatibility endpoints. Deploy as one backend process with durable PostgreSQL queues, not Redis or a second worker service. Run the process on pinned `node:22.23.3-bookworm-slim`; Builder A verified mtcute/native SQLite on Linux ARM64. Host Node 26 also installs and runs the foundation. AMD64 container verification remains a later QA gate.

M0 commands:

```sh
npm ci
npm run check
npm start
```

`check` runs strict typechecking, deterministic contract/schema/lifecycle tests, then compiles `dist/`. `start` serves `127.0.0.1:3000` by default; override `HOST`/`PORT`. `GET /health/live` returns 200. `GET /health/ready` returns 503 with an explicit unconfigured message because M0 has no domain modules. This is intentional and does not imply Telegram/AI synchronization. `npm run dev` uses tsx. No credentials or database are needed to run this foundation. M1 supplies the required one-command `docker compose up` deployment and automatic migrations/bootstrap.

M0 verification on 2026-10-17: clean `npm ci --no-audit --no-fund` passed; `npm run check` passed (14 tests across 3 files, typecheck and production compilation); actual compiled entrypoint returned liveness 200/readiness 503 over loopback HTTP and exited 0 on SIGTERM; host native better-sqlite3 opened/read/closed successfully after the clean install. A private comparison of configured nonempty key values against the new source/docs/schema/lockfile found no matches. These results do not assert any later domain milestone.

`tests/schema.test.ts` executes the actual migration in PGlite's PostgreSQL engine. It verifies ordered seeds, FKs, uniqueness, approval/apply constraints, tombstones, account binding, retained extraction and date precision. It is an in-process SQL integration test; it is not a Docker/PostgreSQL-service, Vikunja, live Telegram, Hermes or live-model acceptance result. See the separate QA plan/research documents on the PM integration branch for those gates.

## Ownership and exact integration exports

- Architect/PM: `src/shared/**`, `src/app.ts`, `src/composition.ts`, `src/main.ts`, `db/migrations/001_initial.sql`, `package.json`, lockfile, TypeScript/Vitest config and M0 tests. After baseline integration, only PM/architect changes top-level composition and shared signatures. Builders propose any necessary contract changes rather than maintaining private competing types.
- Platform builder A: all `src/platform/**`, `src/telegram/**`, `src/vikunja/**`; Dockerfiles, Compose, deployment/bootstrap scripts, minimal onboarding/operations page; subsequent platform migrations. A owns database/transaction/migration infrastructure, chat policy/mapping persistence, cursors/replay, normalized ingestion, account binding, control setup/bus/outbox delivery and Vikunja adapter. Company mapping updates use the shared schema and invalidate workflow work in the same database transaction.
- Intelligence builder B: all `src/intelligence/**`, `src/workflow/**`, `src/hermes/**`; domain HTTP routes, actual MCP transport/tools, records/company/contact/ticket/fact repositories, provider adapters, durable analysis/checkpoints, proposal decisions/apply/reconciliation, priorities. B owns proposal creation and inserts control outbox work through A's transaction-scoped control port. No Telegram transport or upstream Vikunja HTTP is duplicated in B.
- PM-approved transaction boundary: B may commit an adjudicated analysis mapping directly in the same SQL transaction as its company/contact/fact/ticket records, writing `mapping_history.source=analysis`. A owns operator `ChatService.correctMapping`. Both paths lock the chat, validate current policy/mapping/message versions, preserve explicit human corrections, write reason/evidence, and invalidate affected older work consistently; neither performs network I/O inside the transaction.
- QA: independent fixtures and acceptance tests, not product implementations. Retain M0 tests as regression tests. New migrations use distinct timestamped names after `001_initial.sql`; PM arbitrates names/order before integration. Never edit the applied initial migration.

The exact signatures, field names, nullability and discriminated outcomes are exported from `src/shared/index.ts`, with stable lifecycle imports from `src/shared/lifecycle.ts`. `domain.ts` defines records; `ports.ts` defines all interfaces; `schemas.ts` exports runtime validators and inferred mutation input types; `api.ts` defines the transport inventory and shared errors. Exported interfaces are real application ports, not claimed upstream APIs.

PM-approved mapping ownership exception: B's analysis completion transaction may write `chats` mapping and `mapping_history.source='analysis'` atomically with company/contact/facts/ticket persistence and the associated evidence/audit/version invalidation. Lock the chat and compare the input mapping version; protect operator corrections recorded by HTTP/MCP/Telegram, including deliberate unresolved/non-company selections. Model output cannot overwrite a manual mapping simply because a later job sees the newer version. A owns operator `ChatService.correctMapping` and its transaction; B does not route analysis through that separate operator transaction or implement a competing operator mapping service.

Required concrete module exports (implement these names exactly):

```ts
// src/platform/config.ts — A
export async function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeConfig>;

// src/platform/module.ts — A
export async function createPlatformModule(
  config: RuntimeConfig,
): Promise<PlatformModule>;

// src/workflow/module.ts — B
export async function createWorkflowModule(
  services: PlatformServices,
): Promise<ApplicationModule>;
```

`CreatePlatformModule` and `CreateWorkflowModule` are exported callable types for these factories. `PlatformServices` explicitly supplies `db`, `config`, `clock`, `telegram`, `vikunja`, `chats`, `ingestion`, and `control`. It exposes no arbitrary upstream-write route. Domain route/MCP registration uses the `DomainServices` interfaces; the same implementation handles both transports.

`ApplicationModule` has `name`, `register(app): Promise<void>`, `start(): Promise<void>`, `stop(): Promise<void>`, `status(): Promise<ServiceStatus>`. Factories allocate dependencies but start no update loops or remote bootstrap. A factory that fails must release its own partial allocations. `register` installs routes/subscribers and performs no external actions. `stop` must tolerate never-started/partially-started modules and repeated calls.

The shared database session-lock seam is:

```ts
withSessionLock<T>(
  key: string,
  work: (session: SqlExecutor, signal: AbortSignal) => Promise<T>,
): Promise<T>;
```

`PgDatabase` scopes the checked-out connection with AsyncLocalStorage. Nested `db.query`, `db.transaction` and `db.withSessionLock` calls on that **same database instance and asynchronous scope** reuse its session; reentering an already-held key does not acquire a different connection or another lock count. `withLock` remains a concrete compatibility alias. Callers use the scoped executor or `db.transaction` for short atomic SQL sections; transactions finish before remote I/O. Nested transactions and entering a remote-capable session lock from an active `db.transaction` reject. Await all work inside the callback; do not fan out independent operations or retain a scoped executor for later use.

Projection, descriptive/label updates, movement and B's outer apply/reconcile all use **exactly `antseed:ticket:${ticketId}`**. Adapter task writes resolve and recheck the local ticket binding before writing. B must pass the original `PlatformServices.db` instance and invoke the adapter within that outer async scope; never acquire session advisory locks using independent `pool.query` calls or a separate PgDatabase. Other nested lock keys share the same session but callers must use a consistent ordering when more than one resource is needed.

Checked-out session error/end events abort the callback signal, reject with a sanitized upstream-unavailable/unknown-outcome error, and discard the connection. Adapter HTTP combines that signal with its timeout and checks the scope before/after I/O. All later SQL, transactions and lock entries in the lost/closed scope reject permanently; they never obtain a replacement pool client. A distinct caller attempt may enter a fresh scope/token and reconcile remote state. Aborting HTTP cannot undo a write already accepted upstream, so a lost session requires unknown-outcome reconciliation, not blind mutation retry. This is a data consistency mechanism, not an application authorization check.

## Startup composition and integration sequence

The original M0 `createModules()` returned an empty array. M1 now composes the platform module through the canonical entrypoint. PM adds workflow when its bounded implementation handoff lands:

```ts
const config = await loadRuntimeConfig();
const platform = await createPlatformModule(config);
try {
  const workflow = await createWorkflowModule(platform.services);
  return [platform, workflow];
} catch (error) {
  await platform.stop();
  throw error;
}
```

`buildApp({modules})` registers **all** modules before starting any. Workflow registers the control-reply subscriber before platform starts mtcute/catch-up; platform registers its ingestion queue subscriber during register. Starts run platform then workflow. Shutdown closes workflow then platform, stopping workers/subscribers before closing Telegram, HTTP upstream pools and PostgreSQL. Failed register/start closes every constructed module, including modules not started yet. `main.ts` owns listen and SIGINT/SIGTERM.

Platform start schedules bounded initialization/retry and returns even when Telegram credentials/login, AI keys or upstream services are unavailable. It must let the local onboarding listener become reachable; it cannot await user input on stdin. DB-dependent work waits until migrations finish. `/health/live` is process liveness; `/health/ready` aggregates truthful module states and may remain 503 while onboarding is reachable. `/api/status` supplies component status, import counts/cursors, retry/error state and configuration presence, never key values. Missing optional upstreams produce typed `unconfigured`/`degraded`/`unavailable` state; they do not fabricate data or kill independent work. A may expose reduced onboarding while DB is retrying, but business writes return 503 until ready.

Integration order:

1. PM integrates M0 and assigns A M1 platform/deployment. A implements configuration, transactional database/migration runner and real repeatable board bootstrap; PM wires `[platform]`.
2. A builds M2 Telegram normalization, selection, import/replay and control transport. B builds records and company/contact/ticket repositories on the shared schema; domain code uses A's existing chat/ingestion ports. No circular import between the two module trees.
3. B implements real extraction/Jev, durable checkpoints and proposal state machine on `Database`/`VikunjaPort`/`ControlBus`. PM adds workflow factory to composition. Proposal-only movements are mandatory in every path.
4. B registers domain HTTP/MCP/tools and operations; A completes the small local setup/status page. QA exercises real protocol/database/Vikunja plus deterministic fault injection separately from live Telegram/models/Hermes.

## SQL storage contract

`db/migrations/001_initial.sql` is the initial schema. The runner is A-owned. It takes a connection-scoped PostgreSQL advisory lock for migrations, creates `schema_migrations(version text primary key, checksum text not null, applied_at timestamptz not null default now())`, checks SHA256 against the file, and applies each unapplied SQL file plus its ledger insert inside one transaction. Reject changed checksums. Release lock/connection on every exit. Do not use an endless pile of `IF NOT EXISTS` statements to hide drift. Run backend/Vikunja in separate databases, created by Compose initialization/bootstrap. Application migrations never touch Vikunja tables.

Column rules:

- Application entity IDs are UUID (`gen_random_uuid()`); Telegram marked peer IDs/account/sender IDs and Vikunja IDs are PostgreSQL `bigint`. Wire values remain decimal strings. Never globally parse `pg` int8 as JS number. Telegram message IDs are positive `integer` scoped by `(chat_id,id)`; counts can be converted only after safe-integer validation.
- Instants are `timestamptz`; day-only facts use `date` plus `date_precision`. Do not invent midnight as the source's promised time. Timezone is persisted/configurable, initially Asia/Kolkata. Unknown values use SQL NULL and corresponding TypeScript null, not guessed defaults.
- Lanes/workstreams are seeded reference rows with FKs. Lane order is position 0..5. Workstreams are independent labels, including singular `Integration` versus lane `Integrations`.
- Scalar directory arrays (`text[]`) store names/aliases/domains/identifiers/visible contact details. Nonunique company names/aliases/domains preserve ambiguity; one visible name is not proof of company identity. `contact_telegram_ids` has a unique user-ID mapping; channel/anonymous peer IDs never enter that table.
- Relationship/evidence join tables have actual FKs. Do not delete source messages; edits increment message version, deletion creates tombstone, affected evidence gets `invalidated_at`. A valid evidence record requires current matching message version, no deletion, included non-control chat and current mapping/policy. Runtime checks enforce this multi-row predicate; an FK alone cannot.
- JSONB holds source snapshots, forward provenance, validated extraction/decision/checkpoints, separate provider provenance/diagnostics, settings and idempotency responses. Workflow validates these at read/write boundaries. Key values/session payloads never belong in settings/provenance.
- `tickets.chat_id UNIQUE` gives one ticket per tracked chat; multiple chats can share a company and contact directory. Initial lane/default version is `To be started`/0. Only included, confirmed company chats create tickets. Existing tickets survive a mapping becoming unresolved/non-company as `tracking_state=suspended`; do not delete remote tasks or silently reassign historical evidence. Corrected confirmed mapping resumes projection with updated company after transactional invalidation.
- Stage, policy, mapping, fact/contact/company/actions versions are nonnegative monotonic integers. Any observed lane transition, including away and back, increments `stage_version`. `actions_source=manual` prevents subsequent inference from overwriting manual actions/dates; explicit manual fact edits have the same precedence. Workflow derives dated child fact rows via `parent_fact_id`; root facts carry actor/lifecycle and references to answering facts. `state` is authoritative.
- Journal/outbox unique keys enforce one mutation per proposal, at most one active mutation per ticket, one MTProto randomId per outgoing proposal, unique control reply identity and unique `(scope,key)` idempotent command. Same key/different request hash returns 409; same request returns the saved response from the same SQL transaction. No local idempotency cache substitutes for SQL durability.

## Telegram account, import, exclusion and provenance

Only one Telegram account is supported per dataset. `telegram_account` is a singleton binding to the actual authorized self user ID. `IngestionStore.bindAccount` writes the first ID and accepts only the same ID thereafter, before any discovery/update processing. A replacement session belonging to another account reports dataset-account mismatch and pauses ingestion. Intentional account changes require a new database/session volume or a separately reviewed explicit data reset/migration; login cannot silently rebind populated data. This is data identity, not an app permission check.

Use `@mtcute/node` **0.32.4**; exact core/html-parser/markdown-parser overrides are 0.32.4, wasm 0.32.0 and better-sqlite3 12.10.0. Lockfile is required. Mount the whole session directory because SQLite WAL/sidecar files must persist. Native packages must be installed/built in the target container, never copied from macOS node_modules. npm 11 may ask for install-script allowlisting; native SQLite must be exercised, not inferred from a successful install.

Use `iterDialogs({archived:'keep'})`, `updates:{catchUp:true}` (default is false). Normalize marked IDs, explicit peer/sender kinds and available names/usernames/visible phones/emails. A channel or anonymous sender is not a Telegram user. `Message.forward` persists source kind/forward status and nullable original peer/name/date/message ID; forwarder identity is separate from original author. Hidden original identity remains null. Own and forwarded messages with identical text remain different evidence contexts. No textual 'Forwarded' prefix is required. Do not infer employment from membership or quoted/forwarded claims. B receives normalized source snapshots and current evidence via `AnalysisInput`/context.

`Message.sender` and `Message.peer` are required `PeerSnapshot` fields, mapped from the existing `messages.sender_snapshot` and `messages.peer_snapshot` JSONB columns. `TelegramMessageInput` inherits them from Message. Both `AnalysisInput.messages` (including `ExtractionPort.extract`) and `RecordsService.getContext().messages` therefore retain available names, usernames and visible phone/email values without adding those values to raw business text. Missing attributes remain empty arrays/null IDs with the correct peer kind; the forward's original author remains separate.

mtcute emitter `.add(listener)` does not await async callbacks. A enqueues updates and explicitly awaits persistence in its own bounded worker, catches queue errors and schedules replay. mtcute PTS/session persistence is **not** atomic with PostgreSQL. Use two application checkpoints:

- Descending bounded backfill uses `history_cursors` with `{nextMessageId,nextDate}`, generation and per-chat lease. `claimHistory` claims a lease; `commitHistoryBatch(chatId, expectedPolicyVersion, expectedGeneration, batch)` CAS-updates generation and inserts/upserts messages/jobs in the same transaction. A stale lease/cursor/policy loses with 409 and does not advance. Persist `.next={id,date}` only after durable messages. Respect configured batch/max-batch limits and flood waits.
- Live/reconnect reconciliation uses independent `live_checkpoints`, high-water ID, generation, `replay_required` and last completed time. On restart/reconnect/TooLong/queue failure, replay a configurable overlap from persisted high-water through current head, page within bounds, CAS-commit durable normalized messages before advancing. For TooLong or an interrupted replay, retain `replay_required` and continue bounded jobs; do not claim caught up after one page. Periodically reconcile recent history for missed edits/deletes. Marked high-water is coverage, not proof Telegram retained every delete event.

`message_tombstones` persists deletion before message/backfill, including nullable scope for common nonchannel mailbox deletes. Null-scope deletes match only user/group common-mailbox rows, never channel/supergroup IDs. Keep unresolved tombstones; later imports must consult both scoped/unscoped applicable tombstones and cannot resurrect content. Incoming older history never overwrites a newer edited timestamp/version; identical replays are no-ops. Tombstones dominate all later replay. Invalidate source evidence/jobs/proposals transactionally on real edits/deletes.

Newly discovered chats start **included**, except the configured control chat, which is excluded from business ingestion. `IngestionStore.upsertDialog` explicitly inserts that discovery policy; it must not rely on the schema's reserved `undecided` default or add a per-chat approval step. Rediscovery preserves existing explicit selections, especially exclusions. The enum may retain undecided for transitional records, but it is not the discovery default. Exclusion immediately increments policy version, pauses history, cancels queued analysis, invalidates in-flight result acceptance and marks un-applied proposals stale; do not ingest or run AI on business content after exclusion. Every analysis/extraction/apply transaction rechecks policy/mapping/message versions. Previously stored evidence is retained for audit but excluded from AI/context/priorities. Re-inclusion requires a fresh policy snapshot; it cannot revive stale proposals.

Route control messages/replies **before** business exclusion and never feed control content to AI. Same-account outgoing replies from another client are valid control replies; do not filter `outgoing` globally. Correlate replies using outbox `(chat_id,message_id)`; sender IDs are audit fields, not allowlists. Plain MTProto replies support approve/reject/correct.

Control group setup is an explicit local onboarding action. `configureControlChat` requires `operationKey`. Persist `control_setup_operations` with request hash and unique marker before remote create. Put marker in the group's description and reconcile accessible dialogs/full chat metadata after unknown outcome; `channels.createChannel` has no randomId. Never blind-recreate on timeout/crash. If discovery cannot uniquely establish the result, show `remote_unknown`/`conflict` and allow operator selection of an existing group. On configure, atomically unset old control flag, set new group `is_control=true,inclusion=excluded`, bump affected policies and cancel/stale business work. No real group creation/messages occur in automated tests by default.

Login returns explicit delivery mode/resend deadline, password hint, invalid/expired-code/password/flood errors and retry timestamp. `submitLogin` does not retain codes/2FA in application DB/logs or fallback to stdin. Session persistence belongs to mtcute.

## Real Vikunja adapter

Pin `vikunja/vikunja:2.7.0`. Use its actual **v2** API, JSON collections `{items,total,page,per_page,total_pages}`, POST creates and PUT replaces. Buckets belong to **project view**, not directly to project. Movement is `PUT /api/v2/projects/{project}/views/{view}/buckets/{bucket}/tasks` with `{task_id}`. No invented `PATCH task.stage` API. Page through collections. A's primary-source/live research is recorded separately in `docs/PLATFORM_RESEARCH.md` on the PM branch.

Reconcile/reuse the auto-created Kanban view and To-Do/Doing/Done default buckets into the six exact ordered lanes, setting managed view `default_bucket_id=To be started` and `done_bucket_id=Completed`. Ensure filters include done tasks so Completed stays visible. Archived is just a bucket, never project archival/task deletion. Persist `board_bindings`, `board_buckets`, `board_labels`; acquire application bootstrap lock and search stable identifiers before creating missing objects. A partial bootstrap restarts without duplicates. `ensureTask` uses a durable ticket UUID marker in description and remote readback before retry after unknown create. New tickets enter To be started only. Details/label updates preserve lane/done/view assignments; full PUT semantics must not clear unrelated fields.

Details use the real v2.7.0 `PATCH /api/v2/tasks/{task}` with `Content-Type: application/merge-patch+json` and only `{title,description}`; label associations use their own endpoints within the same ticket lock. No stale `done`, bucket, project or unrelated task fields are echoed in a full PUT. A concurrent direct remote move can make final readback return conflict, but must not be silently overwritten by a descriptive update. Local stage moves serialize with details and projection through the shared ticket session lock. The pinned instance's `/api/v2/openapi.json` and source `pkg/routes/api/v2/tasks.go` document this partial-update operation.

Stock Vikunja image is scratch, UID1000 and contains no shell. Bootstrap uses actual CLI in a shell-capable wrapper/init service, not `sh -c` inside stock image. Reconcile existing CLI user before create or explicitly recognize its known duplicate failure; do not hide all exit-1 failures. Registration may stay disabled. Persist `VIKUNJA_SERVICE_SECRET`, database and writable UID1000 files volume. Bootstrap waiting/error is distinct from ready. Upstream service credentials are necessary connections, not custom app authorization.

## Extraction, Vercel Jev and replay

Runtime config defaults to `AI_ENV_PATH=/Users/jys/Documents/Projects/hello/.local-preview-20261012/ai.env`; support portable override and read via dotenv/file APIs, never shell-source. Process environment overrides file values. Do not copy/bake env into images/build contexts. The platform config loader supplies `RuntimeConfig` to B without logging it. Keys remain runtime memory only.

Extraction uses configured OpenAI model (`gpt-6.1-sol`), real structured `/v1/responses` contract verified by B's research; Jev uses Vercel **only**, configured `https://ai-gateway.vercel.sh/typesafe/v1/systemone`, model `typesafe-ai/jev`. Gateway credential is `JEV_API_KEY?.trim() || AI_GATEWAY_API_KEY?.trim() || null`; blank override cannot shadow the configured Gateway key. `RuntimeConfig.jev.provider` is literally `vercel`. Never fallback to direct TypeSafe, OpenAI or a mock in production.

Gateway request is JSON `{model,state,questions}` with `Authorization: Bearer <Gateway key>`. Native typed questions are `noul` (yes probability), `choice` (criteria keyed by option) and `score` (ordered criteria). Parse `answers` keyed by question, not `choices[0].message.content`. Preserve `JevDiagnostics` native types/distributions/confidence/legend and rubric version, plus separate `ProviderProvenance` for extraction and Jev. Bound timeouts/retries; respect rate limits. Invalid/missing/unknown answers produce a typed failure, never a default lane.

`AnalysisQueue` claims leased jobs, loads versioned input, saves validated extraction through `saveExtraction(checkpoint, claimToken)` **before** calling Jev, and exposes `getExtraction` for replay. The canonical input hash includes account/chat, policy/mapping/message/evidence versions, relevant ticket context, timezone and extraction schema version. Commit checks current input hash/versions. Persist extraction/facts/provenance even when the later Jev call fails; do not publish guessed Jev classifications. Reuse a current checkpoint rather than paying extraction again; changed input requires a new checkpoint. `complete(jobId, decision, provenance, claimToken)` uses the saved extraction and rechecks policy/mapping/evidence/ticket stage; failures use `fail(jobId, error, claimToken)`.

Every claim returns an immutable `AnalysisJob.claimToken: string`, freshly generated for that attempt even when the same worker reclaims the same job. Persist the token in the existing `analysis_jobs.worker_id` column (for example, worker ID plus a random UUID); the caller's stable worker ID alone is not a token. Each of the three result writes atomically requires **exact token equality, `status='running'`, and `lease_until > now()`**, in addition to input-version checks where applicable. Lock/check the claim in the same transaction as all resulting writes; an expired/replaced token returns conflict and changes no job/checkpoint/domain state. `loadInput` and `getExtraction` remain reads. Capture the returned token in each asynchronous attempt's closure; never look up a mutable current token when a delayed callback returns. Repository concurrency/lease-reclaim implementation tests belong to B.

```ts
const claim = await queue.claim({ workerId, leaseMs });
if (claim) {
  const { id: jobId, claimToken } = claim;
  const finish = (decision: JevDecision, provenance: ProviderProvenance) =>
    queue.complete(jobId, decision, provenance, claimToken);
  // This attempt's asynchronous callback retains finish and its original token.
  // saveExtraction and fail likewise receive this captured claimToken.
}
```

Observed real probe: configured Gateway key was accepted enough to route, but HTTP 403 `no_providers_available` / `RestrictedModelsError` reports free-tier paid-credit restriction (zero provider attempts). Treat it as provider unavailable/entitlement, retain `provider_unavailable` jobs/checkpoints, show honest status and permit explicit `replayUnavailable` after access is fixed. Do not hammer entitlement errors or fabricate successful recommendations. OpenAI's separate successful synthetic request does not pass the live Jev gate. No additional real entitlement probe is needed for M0. Real Gateway success remains externally blocked; deterministic mocks are explicit test dependencies only.

Extraction captures structured company names/aliases/domains/buyer/provider IDs with evidence separately from matching candidates; contacts and sourced roles; accountable AntSeed/external/unknown actors; actions/questions/blockers/commitments, answer/completion/withdrawal state and original date phrases. Dates resolve relative to source message timestamp/timezone. Manual updates have precedence. B validates evidence IDs actually supplied in context. Workstream, relevance, company matching, urgency and proposed stage come from Jev's bounded decisions, including uncertain/no-change. Incidental/negated/forwarded claims are evidence to evaluate, not executed instructions.

## Proposal decisions, application and recovery

`ProposalService.propose` is the only lane-change entrypoint for AI/Hermes/manual requests. It records source lane **and stage version**, mapping/policy versions, target, evidence, reason/next action and origin; rejects same-lane/no-evidence/invalid targets and stale inputs. No automatic subsequent movement occurs. The creation transaction stores proposal + control outbox with stable randomId; A delivers and saves actual control message ID. A crash after Telegram accepted send uses the same `sendText` randomId and readback/correlation where available, never a newly generated ID per retry. Ambiguous delivery remains visible until resolved.

`decision` and `applyState` are independent. Decision pending -> approved/rejected/corrected exactly once under row lock. Duplicate same commands return the saved response; conflicting decisions return 409. A correction records an immutable corrected original plus a replacement **pending** proposal with correctionOf/evidence/reason; the replacement needs a separate approval. Rejection/correction never applies the original. Decisions include transport/source, note, timestamps and control-reply audit; no sender authorization checks.

Approval transaction validates all source versions/current valid evidence/inclusion/control/mapping and queues apply durably. The worker's transaction prepares a unique `mutations` row and sets apply queued/applying, then performs bounded remote I/O **outside** SQL transaction. Lock/serialize per ticket (including across backend processes) before preflight/write/readback; use one checked-out session advisory lock for the apply critical section plus fenced claim/lease checks. Do not treat a lease timeout alone as permission for competing unfenced writes.

Preflight reads current managed-view bucket. If remote differs from source, reconcile observed lane/version and mark proposal stale/conflict; never overwrite a third state. On network ambiguity, record `remote_unknown`, move proposal to reconciling and read remote before another write. Target observed => `remote_confirmed`; original source still observed => bounded retry only while proposal is still current; third state => conflict/stale. After confirmed target, one SQL transaction updates ticket lane/stage version/previous active lane, proposal applied/appliedAt and mutation committed. A repeated commit is a no-op. Pending approved rows with no journal are recovered by scanning the durable apply state; no ephemeral scheduling requirement.

Recovery windows: proposal commit before delivery -> outbox resumes; decision commit before worker -> queued scan resumes; journal before remote -> preflight; remote accepted before response/local commit -> readback then one local commit; committed before reply acknowledgement -> idempotent stored result. Failed/reconciling states retain sanitized errors and retry information. Evidence edits/deletes, exclusion or mapping correction invalidate unapplied work at every checkpoint. If remote may already have changed, reconcile that fact without silently moving it back; surface conflict for a fresh operator-reviewed proposal.

Entering Blocked stores the prior active lane (To be started/Work in progress/Integrations). Clearing blockers can suggest resumption, but needs another proposal/approval. Archived remains visible and Completed needs evidence of the agreed outcome; buyer ID alone is insufficient.

Remote limitations are explicit: Vikunja offers no distributed transaction/CAS with our PostgreSQL. A remote human can change the board concurrently. Poll/readback updates local version for observed movements (including away/back); retain remote update/revision metadata in adapter/reconciliation diagnostics where available. A completely unobserved remote away-and-back cannot be proven from current bucket alone. Never claim global exactly-once HTTP effects; the guarantee is one logical locally committed movement per approved proposal with durable unknown-outcome reconciliation and conservative conflict handling.

## HTTP, MCP and Hermes

The authoritative exact domain route/method/tool inventory is exported as `API_OPERATIONS`. `PLATFORM_OPERATIONS` lists status/login/control-setup operator HTTP routes. Transport bodies use the exact corresponding port inputs; path IDs merge into inputs, query inputs use documented PageInput, and mutation inputs require idempotencyKey. List results are `{items,nextCursor}` with default 50/max 200 and stable tuple cursors. Detail and successful mutation responses are the port's declared records (200); asynchronous proposal decisions can return durable queued state, never pretend remote apply completed. Invalid input -> 400; missing -> 404; stale/conflict/excluded/ambiguous -> 409; unavailable/unconfigured -> 503. Errors use `ApiError` with stable code, sanitized message/retryable and requestId. No custom login, auth middleware, roles, RBAC, sender allowlist or tool permission framework is introduced.

`MCP_OPERATIONS` filters only non-null tool entries. **There is no `decide_proposal` Hermes tool.** The operator HTTP decision route and internal control-reply service remain explicit, separate bindings. Hermes gets proposal create/list/get, including decision/apply state, not the ability to approve its own proposal through this MCP surface. This is initial product surface design; no auth gate is needed. No MCP tool can call VikunjaPort.moveTask directly. Setup/login or arbitrary Telegram sends are HTTP/internal only.

B implements an actual MCP SDK Streamable HTTP server at `/mcp` (stateless per-request transport is sufficient), with protocol initialize, capabilities, tools/list and tools/call. Mount/bridge the SDK transport to Fastify raw req/res, managing hijack/lifecycle correctly; ordinary REST JSON is not MCP. Register schemas using shared validators, normalize tool failures as `isError` structured/text results, and map successful service records to structuredContent with JSON text fallback. Validate both transports, provide discoverable tool descriptions and retain the exact tool names. GET/DELETE behavior follows the chosen official SDK stateless transport; QA exercises negotiated protocol rather than assuming an arbitrary version string.

Nous Research Hermes Agent remains the client, not a new Hermes service. Local Hermes v0.21.3 is available per research; later real-client validation is required in addition to SDK tests. Example `~/.hermes/config.yaml` fragment (actual local backend, no API token):

```yaml
mcp_servers:
  antseed:
    url: "http://127.0.0.1:3000/mcp"
    enabled: true
    timeout: 120
```

Reload/test with the actual installed Hermes commands as documented by its version. From a container use the reachable backend service/host URL. Priorities use open AntSeed commitments, overdue/upcoming follow-ups, unanswered questions and blockers, excluding suspended/excluded/completed/archived work by default. Facts retain external actor and answered/completed state so an external promise is not an AntSeed todo. No priority generation triggers outreach or movement.

## Primary sources and review disposition

Verified sources and worker live probes inform the design; links describe upstream behavior, not proof this application implements it yet:

- [mtcute quick start](https://mtcute.dev/guide/) and exact installed 0.32.4 declarations for getHistory/iterDialogs/emitters/storage (see A's research).
- [Vikunja API v2](https://vikunja.io/docs/api-v2), [v2.7.0 source](https://github.com/go-vikunja/vikunja/tree/v2.7.0) and real A-owned 2.7.0 board/task probes.
- [Vercel TypeSafe-compatible API](https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe), [Gateway authentication](https://vercel.com/docs/ai-gateway/authentication-and-byok), [native typed answer reference](https://docs.typesafe.ai/api). B's Gateway entitlement result remains a blocked live-success gate.
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Hermes MCP guide](https://hermes-agent.nousresearch.com/docs/guides/use-mcp-with-hermes).

Consolidated draft review disposition: A1 singleton account binding; A2 independent checkpoint/generation/lease/tombstones and replay rules; A3 normalized sender/peer snapshots; A4 explicit services/control wiring and lifecycle cleanup; A5 journaled setup and accurate login states; A6 actual Vikunja v2/bootstrap invariants. B1 HTTP-only decisions; B2 saved/read extraction checkpoint before Jev; B3 structured extracted companies; B4 accountable facts/lifecycle/date precision/update route; B5 role-free contact create IDs and role-bearing detail/context; B6 separate provider provenance/native diagnostics; B7 operator reason/source/evidence mapping audit. QA Q3 forward metadata survives normalized input, Message and analysis, with an identical-body contract example. These are shared contract/schema/design dispositions, not claims that future domain modules or all acceptance scenarios already pass.
