# M1 architectural repair: session scope and lane preservation

Review/repair owner: architecture. Canonical code reviewed: main `06374d3`
(platform `10ad433`), merged with coordination updates into architect `fe25b67`.
PM authorized targeted changes to database/adapter, one shared lock seam and tests.
No initial migration, dependency, Telegram, AI or domain-module changes.

## Reproduced before repair

Actual isolated PostgreSQL 17.11 and Vikunja 2.7.0, project
`antseed-arch-review-1792189208`; synthetic companies/tickets only. Other workers'
containers/stacks were not used or modified.

- **P1 pool starvation:** eight distinct existing-ticket `ensureTask` calls,
  synchronized at task GET, consumed all eight checked-out lock sessions. Nested
  `getTask -> binding -> pool.query` queued eight extra borrowers. Three calls
  rejected with connection-acquisition timeout; five fulfilled, elapsed 3140 ms.
- **P1 unapproved reverse movement:** pause descriptive full PUT after capturing
  `done=false`, move to Completed and confirm, release PUT. Both operations
  returned success; final lane was To be started. The old readback compared to
  the original lane and accepted the overwritten result.
- **P1 process crash:** terminate exactly the PostgreSQL PID checked out by a
  child process waiting in a session lock callback. Child exited 1 with unhandled
  error event/57P01; its callback catch was never reached.

The local original script is retained at `/tmp/antseed-arch-m1-repros.mjs`, with
sanitized baseline results in the directory recorded by
`/tmp/antseed-arch-m1-review-state.json`. The committed regression scripts are
`tests/platform/architect-session.test.ts` and `architect-races.test.ts`; they
retain the triggering conditions and extend them to the shared workflow seam.

## Repair contract

`Database.withSessionLock(key, (session, signal) => Promise<T>)` reserves one
session. AsyncLocalStorage carries that session through nested query/transaction
and lock calls on the same database instance. Same-key nesting is reentrant.
The concrete `withLock` compatibility alias remains available; callers never
receive a raw releasable PoolClient. Short `db.transaction` sections use the
held client and finish before remote I/O. Nested transactions/lock entry from a
transaction fail explicitly. Pool maximum remains eight.

Projection, details/labels and movements share `antseed:ticket:${ticketId}`;
task-based writes resolve/recheck the local ticket binding. B's apply/reconcile
must use that exact key and the original PlatformServices.db instance/scope.

Checked-out connection error/end rejects the scope with sanitized unknown-outcome
error, aborts its signal, discards the client and permanently fences late scoped
SQL/transactions/locks. A separate caller attempt can use a fresh session to
reconcile. Adapter requests combine the session abort signal and HTTP timeout,
with checks before and after I/O. No recovery borrows a replacement client inside
the failed attempt.

Details use pinned Vikunja's real `PATCH /api/v2/tasks/{task}` with
`application/merge-patch+json` and **only title/description**. Label endpoints stay
inside the ticket lock. No stale done/bucket/project fields are sent. External
remote movement may produce a conservative conflict at readback, while preserving
the actual movement.

## Regression commands and evidence limits

Run deterministic checks with `npm run check`. To opt into real regressions,
first build the compiled child fixture with `npm run build`, then run:

```sh
ARCHITECT_TEST_PROJECT=antseed-arch-review-1792189208 \
ARCHITECT_TEST_COMPOSE_OVERRIDE=/path/to/isolated/override.yaml \
ARCHITECT_TEST_PG_PORT=52900 \
ARCHITECT_TEST_VIKUNJA_URL=http://127.0.0.1:52901 \
  npx vitest run tests/platform/architect-races.test.ts
```

The opt-in file reads only that test project's generated runtime credential bundle
into memory; it never prints credentials or calls Telegram/models. It covers
eight distinct projections at full pool capacity, eight same-ticket calls, outer
workflow lock reentry with seven other clients occupied, paused PATCH against
application and direct remote moves, checked-out connection termination/recovery,
and abort/fencing after a late uncooperative transport completion. The last case
uses real PostgreSQL loss and an explicitly controlled transport, not a claim of
real remote cancellation.

Three deterministic tests separately verify same-client/reentrant SQL and short
transaction semantics, permanent fencing after loss, successful-scope closure
fencing, and rejection of lock entry from a transaction.

Repair verification on 2026-10-17: full `npm run check` with the architect real
test environment passed **41 tests**, strict TypeScript and production build.
This includes all seven opt-in architect real regressions and three deterministic
session tests. The original five separately opted-in platform integration tests
were skipped in this run; their earlier QA results are not relabeled as repair
verification. `git diff --check` passed. The isolated synthetic review project and
volumes are retained for review; no other project's resources were modified.

These tests establish the repaired boundaries, not a product milestone or live
Telegram/AI/Hermes gate. Aborting a remote request cannot undo a write already
accepted; B must retain/reconcile unknown outcomes with its durable journal.
External humans do not participate in our SQL advisory lock; conservative remote
conflict/readback remains necessary. Unknown-create guarantees, Compose setup and
provider/Telegram implementations were not expanded in this repair. Independent
QA must rerun its own unchanged outcome assertions on the integrated SHA.
