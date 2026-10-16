# M3.1 integration handoff

`createWorkflowModule(PlatformServices)` implements the approved factory signature. Construction, registration and lifecycle do not query upstream services, apply proposals, register domain routes, or start a background loop. The module truthfully reports degraded/manual-dispatch status until later milestones wire workers and proposals. It never closes the platform-owned database/Telegram/Vikunja ports.

`createWorkflowServices(platform)` returns `records`, `analysis`, `extraction`, `jev` and a bounded `processOnce({workerId,leaseMs,signal?})`. A scheduler must wait for platform migrations/readiness. Set a lease longer than the entire bounded extraction + Jev request budget (including retries and database work); no lease renewal is implemented. Aborted/expired work is fenced and reclaimed rather than accepted after expiration. M3.2 will consume persisted decisions through the proposal service; M3.1 never changes a lane, creates approval records, calls `moveTask`, or creates remote tasks. Local tickets start in `To be started`; subsequent remote projection uses A's port after integration.

## Persistence invariants

- All SQL goes through the shared `Database`/`SqlExecutor`; no new dependencies or migrations. Same-key commands serialize via a transaction advisory lock, store request hash + JSON response atomically, and reject changed input. Remote/network I/O never occurs in a transaction.
- Claims use distinct UUID tokens stored in `analysis_jobs.worker_id`, independent of external worker name. Every checkpoint/complete/fail write requires the captured immutable token, running status and unexpired lease. Expired original callbacks cannot alter a reclaimed attempt, including one using the same external worker name.
- A-owned operator mapping stays authoritative. The PM-approved analysis mapping exception locks chat before job, checks current inclusion/control/policy/mapping/message snapshots and input hash, uses `mapping_history.source='analysis'` with reason/evidence, increments mapping version and cancels/stales prior work while excluding its own completing job. No non-analysis mapping-history correction is overwritten.
- Jev must supply high-evidence adjudication before a new/known automatic association. The initial uncalibrated gate uses native choice confidence >=0.8, selected probability >=0.9 and top-two margin >=0.2, plus actual sourced company evidence. New company resolution serializes directory writes and checks canonical names/aliases/domains globally before creating an entry; collisions remain unresolved. Names alone never merge contacts; Telegram user IDs deduplicate contacts. Role evidence is explicit and read back in context.
- A bounded window uses up to 200 current messages, 8,000 characters per message and 64,000 characters total; the recent context query covers 100 recent messages plus the job's explicit snapshot. The directory shortlist currently contains up to 100 entries in stable order. These are initial personal-tool limits, not completeness claims for arbitrary history/directory size. Large-context retrieval refinement is a later optimization; history ingestion/cursors are A-owned.
- Current extraction is saved before Jev, with source evidence, actor/lifecycle/date facts and separate OpenAI provenance. Jev entitlement/unavailable failures retain checkpoint/facts; explicit replay reuses a still-current checkpoint. Changed policy/mapping/message/ticket/directory context invalidates reuse. Dataset account must be bound; platform's singleton account-binding invariant prevents cross-account reuse.
- Manual actions/dates and manual fact state/actor/date overrides survive re-analysis. Day-only dates remain SQL `date` plus precision, never an invented instant. Priorities distinguish open AntSeed commitments from external promises and filter excluded/suspended/archived/completed or invalidated-source work.

## Providers and verification

OpenAI uses actual `/v1/responses`, a strict generated JSON schema and independent semantic validation of evidence IDs/current message versions, visible identities/contact details, sourced company attributes, roles and source-relative dates. Jev uses only the configured Vercel `/typesafe/v1/systemone` endpoint, typed `choice`/`noul`/`score`, native diagnostics and no model fallback. Errors never reflect upstream bodies or exception strings; provenance retains bounded IDs/model/version and numeric usage only. Long rate-limit delays return to the durable queue instead of blocking a request loop.

M0 research's known real Gateway 403 remains an entitlement blocker. M3.1 made **zero additional live Jev calls**. A local Postman simulation replayed the sanitized documented 403 through the actual HTTP adapter, with one request and no fallback. This is mock transport evidence, not successful Jev inference. The mock is derived from the committed research/official contract; no account-based owner mock search or cloud publication was performed.

The full production OpenAI schema was exercised with synthetic Cedar Labs messages and the supplied runtime credential. Two HTTP 200 outputs failed semantic validation because they invented an actor contact UUID; rejection was correct and neither output entered persistence. The prompt/schema description was tightened to require null without an existing ticket contact UUID. A third bounded synthetic call passed full extraction/evidence validation: `gpt-6.1-sol`, schema `extraction.v1`, 1 company, 1 contact, 2 facts, 1,560 input tokens and 977 output tokens. This verifies the full request/schema and one source example, not multilingual model quality. No credentials or opaque reasoning payloads were copied into artifacts.

Deterministic verification commands:

```sh
npm run check
# Optional isolated real PostgreSQL, using a dedicated loopback test DB:
M31_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/TEST_DB' npx tsx tests/workflow/postgres-smoke.ts
# Optional local Postman CLI 1.73+ transport simulation (stop with Ctrl-C):
postman simulation run tests/intelligence/gateway.sim.yaml --port 4951 --output ndjson
# Another terminal; uses synthetic credentials and loopback only:
npx tsx tests/intelligence/gateway-smoke.ts
```

The optional PostgreSQL script creates/drops its own random schema, exercises separate connections and cleans up. The PGlite fixtures execute the real initial migration and repository SQL; they are distinct from Docker PostgreSQL and live upstream tests. Tests cover same-worker reclaim, stale callback save/complete/fail, policy/mapping/message/stage changes, checkpoint retention/replay, manual mapping/date precedence, identity collisions, shared-directory dedupe, role context, initial tickets, evidence invalidation and actor/date priorities. HTTP tests use actual native fetch against local contract stand-ins for successful/malformed/refused/truncated/429/403/503/hanging responses. The independent baseline/platform tests remain intact.

Final M3.1 verification on the integrated M0/M1 baseline: `npm run check` passed **78 tests**, with **5 platform live tests skipped** by their explicit opt-in configuration, plus strict typecheck and production build. The separate smoke passed against an owned, isolated **PostgreSQL 17.11** Docker container using real concurrent pool connections. The Postman simulation log contains the expected POST to `/typesafe/v1/systemone` returning 403; its temporary server/logs and test PostgreSQL container are not product deployment resources.

Deferred by assignment: proposal creation/approval/apply/crash recovery (M3.2), continuous scheduling, real remote task projection, HTTP/MCP/Hermes tools (M4), real Telegram account onboarding, and successful live Jev inference after account access is fixed. No user's Hermes profile was accessed or modified.
