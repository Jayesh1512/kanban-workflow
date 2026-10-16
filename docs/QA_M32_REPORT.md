# Independent M3.2 acceptance

**Implemented approval/apply/recovery slice: PASS. Live Telegram and successful live Jev: NOT RUN / externally blocked.** Frozen product baseline `d6b56b4`. This accepts the five-P1 candidate repair `8602ce34` through independent assertions, rather than relying on the architect's supporting verification. M4 HTTP/MCP/Hermes is separately assigned and is not accepted here.

Exact tested QA merge: `fa0abc66ae53e12f0ed2549ed5438560ad6372e5`. Product directories match committed `d6b56b4`; only the QA files in this handoff were added. No product/shared/dependency/composition file changed.

## Executed checks and reproduction

```sh
npm run build
npm run typecheck
QA_M32_PROJECT=antseed-qa-m1-06374d3-20261017a \
  npx vitest run tests/qa-m32-approval.test.ts tests/qa-m32-crash.test.ts \
  tests/qa-m32-concurrency.test.ts tests/qa-m32-gates.test.ts \
  tests/qa-m32-remote.test.ts --maxWorkers=1 --no-file-parallelism
npx vitest run --maxWorkers=2
```

- Independent opt-in set: **42PASS / 0FAIL / 0SKIP**: 17approval/inference/staleness, 7SIGKILL windows, 9fencing/concurrency/recovery, 5migration/breaker, 4actual HTTP fault/progress checks. Strict TypeScript and production build PASS.
- Frozen default suite: **252PASS / 0FAIL / 116explicit opt-in SKIP**, 29passed/17skipped files. Opt-in skips are not evidence that their live targets ran.
- Actual PostgreSQL17.11/LinuxARM64 and Vikunja2.7.0 in the retained **QA-owned** Compose project, loopback18080/18081/18433. Every check uses a random schema with real migration runner/ledger and only uniquely marked synthetic task data. Schemas/tasks are removed. No owner stack, volume or port is used.
- Domain worker SIGKILL checks execute the actual compiled `dist` services under host Node26.4.0. They are abrupt domain-process recovery checks, not a claim of killing the canonical Fastify/Compose process at each window. Canonical Node22.23.3 image/native/outage evidence remains the separately accepted M1/M2 evidence; this handoff does not rebuild the older running QA backend image or duplicate M1 clean startup.

## Independent outcomes

| Area | Assertions and actual evidence |
| --- | --- |
|A01 approval boundary | For each of five noninitial target lanes, proposal creation, operational delivery through the synthetic Telegram transport, fresh service/pool restart, and apply dispatch keep actual remote ToStart/undone and local stage0 until explicit approval. Five concurrent dispatches then produce one journal, one local increment and actual target bucket/done. Initial ToStart is checked in every scenario; return-to-ToStart is independently exercised through real remote manual movement and observation. |
|Inference permission | Actual SQL extraction checkpoint/completion hooks with **QA-authored** Jev decisions: `propose` creates only a pending proposal; `no_change`/`uncertain` create none. None creates a mutation or changes actual remote lane. This establishes orchestration permissions, not model quality. |
|A02 correction/rejection | Reject is terminal; a later approve conflicts. Correction persists original `corrected`, creates a separately pending replacement, and moves nothing until the replacement itself receives explicit approval. Its eventual actual WorkInProgress effect increments once. |
|A03 durable replies | Actual DurableControlBus + SQL with synthetic self-account replies: same message replay produces one decision; conflicting reject cannot change approval. Decision commit alone leaves actual remote unchanged. An early approve remains pending while accepted-send/lost-response has no receipt link; a fresh bus/pool repairs receipt701, then commits one decision with one synthetic send. Unrelated text finishes terminally. |
|A04 stale sources | Message edit, deletion, mapping version, policy version, and actual remote away-and-back stage observation invalidate approval/apply. Stale status persists, no journal or new remote move occurs. The away/back case retains the higher source version even when lane returns to its original value. |
|A05 seven crash windows | Real child processes are SIGKILLed (1) inside proposal transaction before commit, (2) after proposal commit, (3) after decision commit, (4) after journal commit, (5) after actual remote acceptance while the proxy withholds the successful bucket PUT response, (6) after confirmed-response SQL before local commit, (7) after local commit before acknowledgement. Parent independently observes actual SQL/remote state before kill. Recovery respects pending approval, rolls back uncommitted proposal/outbox, adopts durable intent, reads back accepted effects, and reaches one committed journal/stage1. Reconcile is idempotent; accepted effects require zero additional parent move calls. |
|A06 lease/ownership | Real SQL with immutable per-attempt token: prepare and writes reject outside scope or under a mismatched ticket. Expired claim cannot renew/write; a new scope using the same external worker ID receives a different token. Original captured callbacks (prepare/claim/mark/confirm/commit) reject and cannot change the adopted row. A different store instance outside scope cannot commit. |
|Actual PG loss | After actual remote acceptance, terminate the checked-out PG backend with `pg_terminate_backend`. Fresh recovery reads actual target and commits once; all five original late callbacks reject, including direct SQL and nested session-lock reentry. They cannot fall back to another connection or change the fresh journal. |
|Uncertain effects after exclusion | Prepare durable journal; put actual remote at source, target, or a third lane; exclude via production TelegramStore. Every case reads back before deciding, sends **zero** new stage writes and reaches conservative conflict. Actual target/third observations reflect local lane once despite suspended tracking; source remains stage0. Repeated reconcile does not increment again. |
|Queue fairness | An oldest approved/stale/no-journal proposal created before actual away/back observation does not starve a later current approval. The later actual remote move commits; no journal is invented for the terminal stale row. |
|Projection/exclusion | Pause real SQL after remote observation has changed the ticket. Independent operator exclusion is observed waiting on the source chat row lock, then commits without40P01; projection may conservatively conflict. Remote Completed, local stage1 and suspended tracking survive. No synthetic database engine substitutes for PostgreSQL here. |
|Remote failure/recovery | A real local HTTP proxy returns401/429/503 for bucket PUT only. Source remote remains unchanged, status reports unavailable and journal remains unknown. Restoring forwarding allows fresh readback/retry: one accepted actual remote move and one logical stage. A separate refusal injection has the same conservative result. The withheld-success response case above covers actual remote uncertainty; arbitrary latency distributions are not claimed. |
|No transaction across I/O | Hold one actual apply at its remote boundary, query `pg_stat_activity` by its exact backendPID: idle session, `xact_start IS NULL`. A different ticket/schema's apply completes against actual Vikunja while the first waits. Both finish stage1. |
|A07 lifecycle | Missing control is explicitly visible as `control_chat_missing`, pending and unmoved. Approved Blocked remembers previous active ToStart. A new resume proposal does not move until separately approved, then reaches actual WorkInProgress/stage2. Archived/Completed actual done semantics are covered in the all-target matrix. |
|Exact migration gate | Wrong checksum, unexpected ledger entry and missing ledger entry all block scheduler **and** real control subscriber ingress before any decision, journal, remote call or settings mutation. Status is `migration_drift` or `database_pending`; inbox stays replayable. Settings are compared against the full migration-seeded baseline. |
|Durable Jev pause | Actual SQL + synthetic credentials: known403 bootstrap dispatches zero HTTP; restart, another job and credential rotation cannot bypass it. Current extraction checkpoints survive provider-unavailable. Explicit replay clears the pause without bootstrap reseeding; a localhost native-shape403 pauses after one request across jobs. Another explicit replay with restored localhost response completes using current retained extraction. A thrown/unknown dispatch leaves a durable unavailable pause across fresh instances and prevents automatic reissue. No real Gateway/model request occurs. |

## Findings, limitations and cleanup

All five known M3.2 P1 finding groups are green in these independent scenarios. Their original RED evidence belongs to the architect; this report does not invent independent pre-fix executions. No additional release-critical defect was reproduced in this bounded slice.

Two initial QA assertions were corrected: the documented `decide` return is `{proposal,replacement}`, and the migration runner seeds settings beyond the projection signature. Final assertions preserve correction semantics and compare the entire settings snapshot; neither change relaxes a product failure. Product files were untouched.

The synthetic Telegram adapter never opens an account/session, sends a live message or creates a live group. Localhost Jev responses and authored extraction/decisions establish contracts and durable recovery only. Successful live Jev remains blocked by previously observed Gateway paid-credit restriction; no entitlement request was repeated. Multilingual model quality, authenticated Telegram delivery, canonical HTTP/MCP parity, installed Hermes and the final real-UI demo remain separate gates.

After the final run, the independent PostgreSQL namespace audit found **zero residual QA random schemas** (excluding its own transient audit schema, which was also dropped). Each newly projected synthetic remote task is deleted before dropping its schema. Child processes are killed/reaped and proxy/listener sockets closed. Only the existing QA stack/service data remain; no default Telegram session or user/Hermes profile was used. Service password/JWT/DB URLs are captured privately in memory, and worker configuration travels on stdin rather than argv/logs.
