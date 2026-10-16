# M2 platform/Telegram handoff — 2026-10-17

Builder A branch `antseed/builder-platform`; integrated foundation includes main
`af91b97` and the architect session-lock repair. A separate Vikunja no-op fix is
`4914a60b1eb55cf308d4ab5cd6a53917c9fee990`; it contains no M2 changes.

## Delivered behavior

- Exact pinned mtcute0.32.4 user adapter: explicit phone/code/2FA; fresh start sends
  no code. Resume and successful login use an updates-disabled authentication
  client, bind actual self ID, close that SQLite owner, then open the live catch-up
  client. Account mismatch opens no live owner. RPC/logging/abort/timeouts are bounded;
  phone is masked and secrets never returned/logged.
- All archived/cloud dialog discovery, explicit default inclusion and preserved
  exclusions. Message/peer/sender/forward snapshots and supported source links;
  body text alone cannot erase provenance. Business ingestion creates versioned
  analysis-job message snapshots in the same transaction as content updates.
- Bounded awaited synchronous-emitter queue; failure/overflow schedules persisted
  replay rather than assuming mtcute waits for async listeners. Independent durable
  history budgets/cursor leases/generations and live coverage CAS; old callbacks,
  exclusions, edits/deletes and mapping corrections invalidate business work.
- Approved additive migration `202610170001_telegram_operations.sql`: only the
  tombstone chat FK removed; unknown-chat deletes remain external scope without
  invented chats. Null-scope deletes affect common mailbox only. Additional history
  bounds, setup request, durable control inbox and immutable inbox/outbox claims.
  `001_initial.sql` remains unchanged.
- Operational reply routing before exclusion, including outgoing self messages.
  Awaited bus handlers with durable retry, stable signed64-bit outbox random IDs,
  marker readback on unknown send outcomes, current source-version/evidence checks,
  no transport lane changes. Missing control group has visible actionable status.
- Existing/private control group setup journal. State is `remote_unknown` before
  non-idempotent create; repeated keys reconcile, another key cannot blindly create
  while uncertainty remains. Only group/title/key request data persists.
- Platform owns canonical six `/api/chats` HTTP bindings and local onboarding forms.
  Register creates no DB/session/network action. Pre-readiness writes report503;
  code validation is400. No custom app login, sender allowlist or permission gate.

## Verification and evidence classes

1. `npm run check`: strict TypeScript, default deterministic suite and production
   build: PASS111 tests;23 opt-in upstream tests skipped. See
   `/tmp/antseed-m2-handoff-check.log` for exact totals.
   Actual upstream suites are opt-in/skipped, never counted as upstream success.
2. Synthetic Telegram events with actual SQL engine: `telegram-store.test.ts`8,
   `telegram-control.test.ts`6, `telegram-sync.test.ts`4. These cover account binding,
   inclusion/rediscovery, atomic job snapshots, older-history/edit dedupe, scoped
   pre-chat and null-scope tombstones, cursor/replay CAS, in-flight exclusion,
   independent control replay, unknown setup, inbox lease fencing/retry,
   accepted-send/lost-response readback and stale outbox suppression.
3. Deterministic mtcute transport/queue seam: `telegram-adapter.test.ts`8. Proves
   auth/live ordering, close-before-reopen, mismatch/resume/2FA behavior and queue
   overflow/failure semantics under controlled clients; no authenticated account.
4. `telegram-http.test.ts` proves side-effect-free canonical route registration and
   honest pre-readiness failures. Runtime config regression proves blank Compose
   fields preserve mounted Telegram credentials while nonblank env overrides.
5. `TELEGRAM_TEST_DATABASE_URL=<disposable PG URL> npx vitest run
   tests/platform/telegram-postgres.test.ts`: actual PostgreSQL17.11 PASS3/3.
   Repeat checksum migration, connection-pool restart persistence, concurrent
   ingest/delete dominance, same-worker expired claim fencing, two real session-lock
   control consumers. Every test uses and removes its own schema. Telegram is synthetic.
6. `telegram-native.test.ts`: actual mtcute SQLite session prepare/close/reopen,
   zero RPC calls. Built ARM64 Node22.23.3 image repeated this with `--network none`:
   `/tmp/antseed-m2-native-container.log`. This is offline native compatibility only.
7. Canonical image build `docker build -t antseed-builder-m2:20261017 .` succeeds.
   Isolated image runtime on18390 connects only to disposable PG18442; actual
   migrations ready, `/health/live`200, `/api/status`200, empty `/api/chats`200;
   readiness503 for deliberately absent Vikunja credentials/Telegram/AI.
   Restart retained DB and honest unconfigured state. Collaborative browser loaded
   page and chat list without JS errors; rejected unconfigured login cleared its
   input and did not echo the submitted synthetic phone. Runtime/server evidence:
   `/tmp/antseed-m2-runtime{,-server}.log`, `/tmp/antseed-m2-restart.log`.
8. Separate `vikunja-noop.live.test.ts` actual pinned Vikunja2.7.0 PASS1: native304
   observed twice, repeated identical detail updates, workstream synchronization,
   Completed/done preserved, same-ticket details+move serialized. Controlled test
   rejects unrelated304 and wrong readback; architect session tests3 pass.
   `/tmp/antseed-vikunja-noop-live.log`. Disposable probe initially failed publicURL
   and database host/port startup configuration; corrected and reran successfully.
   No existing service data was successfully written during those failed boots.

No M1 acceptance rerun is claimed; PM reports independent M1 QA passed `af91b97`.
The modified M1 integration assertion now expects the additive M2 migration when
that opt-in suite is next run on an M2 stack; retained M1 stacks were not migrated.

## Remaining live gate and operational bounds

No authenticated Telegram call, history read, message send or group creation was
performed. A targeted prerequisite question went to user-designated contact thread
`66cc9b30-4836-4f8d-8c6c-b0831923b62c`; no approved account/session/control source
has been received. Actual login/resume/discovery/control/reconnect needs that scope
and a user-performed setup action. Deterministic and native tests do not pass it.

Live coverage begins at one configurable current-head window; bounded older import
is separately resumable. Recent reconciliation only proves edits/deletes inside
its checked window. Arbitrary older missed deletes cannot be reconstructed from
current Telegram history alone. Queue overflow does not create fake delete events.
Unknown control creation can stay unknown after a zero-result read; it never
recreates automatically. Outbox auto-send stops after10 failed attempts and exposes
`control_delivery_failed`; persisted receipts/random IDs remain for investigation.
No claim of global exactly-once remote effects is made.

Workflow B owns decision idempotency/outcomes, extraction/real Vercel Jev,
records and lane apply. Subscribe in register before starts; await bus handlers.
Unexpected transient handler errors throw for replay; invalid/stale/conflicting/
irrelevant inputs should return a durable sanitized outcome. Platform status alone
cannot establish live provider access. Jev remains Vercel-only with the known403
entitlement blocker from separate research.

## Resource ownership

M2 probes use only `antseed-m2-pg-20261017`18442,
`antseed-m2-backend-20261017`18390 and `antseed-m2-vikunja-noop-20261017`18391,
all disposable synthetic data. They are removed after final verification; no named
M2 volumes are retained. The local M2 image and `/tmp` sanitized evidence remain.
The earlier `antseed-m1-builder-20261017` stack and its four named volumes remain
untouched at PM request; all B/QA/architect/unrelated services remain untouched.
