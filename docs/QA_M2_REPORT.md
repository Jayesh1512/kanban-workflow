# Independent M2 acceptance

**Implemented SQL/transport/native/runtime slice: PASS. Authenticated Telegram: NOT RUN.** Tested committed `f93be3a` (QA merge `b36f2ea61a2fd4a254622feb5d73b620f74f146a`), including startup/raw-ID repair `36dfe97`, replay isolation `5120d05`, published/custom application profiles and RFC3339 dedupe `aff272a`. Canonical composition includes platform and workflow. This report does not accept the separately assigned M3.2 domain/application milestone.

## Executed checks

```sh
QA_M2_PROJECT=antseed-qa-m1-06374d3-20261017a \
  npx vitest run tests/qa-m2-store.test.ts tests/qa-m2-startup.test.ts \
  tests/qa-m2-replay.test.ts --maxWorkers=1 --no-file-parallelism
node tests/qa-m2-runtime.mjs
npm run typecheck
npx vitest run --maxWorkers=2
npm run build
```

- Independent opt-in suite: **23PASS / 0FAIL / 0SKIP** (8store/control,8startup/profile,7replay/fault scenarios). These use production `PgDatabase` against actual PostgreSQL17.11 and random dropped schemas. `allMigrations=true` in the QA helper applies the real migration runner/ledger; the historical M3.1 helper default is preserved.
- Frozen full suite: **249PASS / 0FAIL / 71opt-in SKIP**; strict TypeScript and production build PASS. Skipped opt-in tests are not claimed as executed by this run. Passing owner tests does not replace the independent23.
- Canonical Docker build and actual composed runtime script: PASS, image `sha256:0deee64e471c0bc44d4cc65ff5cae319cb7bfc2a96f555e7c44dec426786cf35`, Node22.23.3/LinuxARM64. Same retained isolated QA project, backend18080/Vikunja18081/PG18433, only its four named volumes. The mounted AI file is the QA synthetic override; no private provider env or unrelated session/profile is mounted.
- Native compatibility: two separate `--network none` containers, node user, writable QA session volume; actual better-sqlite3 write/read and mtcute0.32.4 prepare/destroy/reopen PASS. Only unique synthetic native filenames are removed. This is offline ARM64 evidence, not authenticated Telegram or AMD64 execution.

## Independent scenarios and outcomes

| Area | Actual assertions / evidence boundary |
| --- | --- |
|Account/policy/migrations | One synthetic account binding survives pool reopen and rejects a different account. Real migration ledger/checksum rerun succeeds. Archived discovery defaults included; explicit exclusions survive rediscovery. Same-key requests return durable results; changed/conflicting requests reject. Excluded content creates no message. |
|Message/job atomicity | Corpus028 original/edit source uses real ingestion plus SQL. Reobserving unchanged canonical snapshots does not increment version; edit advances to2, invalidates evidence/cancels old analysis, creates current versioned job and rejects an in-flight old extraction callback. Older replay cannot overwrite the correction. No lane/proposal is created by ingestion. |
|Deletion scope | Channel and mailbox message101 remain separate. Delete before any chat discovery persists without fabricating a chat, survives pool reopen and dominates later message/edit replay. A null-scope deletion affects common mailbox scope; explicit marked channel deletion remains correctly scoped. |
|History/replay fencing | Same external worker history lease reclaimed with a newer generation rejects the old callback. Exclusion during in-flight history/replay rejects commits, retains importedCount0 and unchanged coverage high-water. No successful checkpoint is fabricated for failed RPCs. |
|Control creation | Synthetic accepted-create/lost-response occurs only after SQL state is `remote_unknown`; another operation key cannot create again. Restart + marker readback reconciles exactly one group. Configured control is excluded from business data and cannot be included. Operational self replies route into durable inbox without business messages/jobs. No real group is created. |
|Control inbox/outbox | No subscriber retains pending inbox; handler error retries durably; expired callback cannot acknowledge; reopened bus finishes current attempt. A separately authored transport-only proposal keeps one signed64-bit randomId across duplicate enqueue/restart, reads back accepted-send/lost-response receipt401, sends only once in the stand-in and leaves ticket lane/stage unchanged. This does not test workflow approval parsing. |
|Saved-session candidate | Controlled native-client factory plus real account DB: transient getMe failure automatically retries after5s; repeated starts do not overlap owners; auth closes before live; durable identity/discovery precede update start; no code requested automatically. Explicit synthetic phone/code flow cancels retry timer. Stop cancels scheduled retry and fences blocked in-flight retry before a later identity/live request. The existence marker is not a real SQLite account session. |
|Native ID candidate | Actual mtcute `DeleteMessageUpdate` + controlled raw gap callback + real SQL: raw TooLong42 requests replay only for `-1000000000042`, not user42. Already-marked deletion keeps channel scope. No authenticated update is claimed. |
|Fairness candidate | Each of history/replay/recent access failure is tested with two included chats plus inaccessible control. Healthy chat reaches101; access faults retain failed coverage, show sanitized per-chat errors and survive pool reopen/backoff without repeated failed RPC. Expiring the test backoff and restoring transport recovers the failed chat and operational inbox. |
|Global failures | Native-shaped45s flood wait, connection failure and a real one-shot SQL08006 remain global, produce no false coverage and resume at the bounded retry time. SQL failure rolls back message data. Positional explicit null from recent readback creates a scoped tombstone; an access/RPC failure never invents that deletion. |
|Profiles/fresh boot | Default published application selection, complete custom pair and empty custom profile are tested with controlled clients. Fresh default/custom start constructs no native client, sends no code and binds no account; only explicit synthetic phone input invokes the stand-in. Partial custom credentials cannot borrow a published half. Application configuration is not account authorization. |
|Canonical HTTP/lifecycle | Actual image CMD remains `node dist/main.js`, with no Compose command override. Live200/status200/root200; ready503 truthfully lists platform+workflow while Telegram disconnected/provider access unverified. All six chat routes exercised; policy version conflict409, manual mapping audit forced to `http`, excluded import409. Malformed code400 and control setup503 occur without opening a session. Graceful shutdown exits0; restart reuses generated credentials. Actual PG outage keeps UI/live200 and ready503; recovery restores SQL availability. |
|Remote board/credentials | Raw actual Vikunja bucket/done snapshots preserve pre-existing remote task lanes; newly projected tasks start only in ToStart/undone. No approval, account connection or provider job is seeded. Public bodies, backend logs and image history contain no generated password/signing secret/synthetic AI key or temporary service JWT. Read-only AI mount and project-prefixed volume ownership checked. This is not a new full image-layer scan; M1 layer evidence remains historical. |
|Browser | T3-owned incognito preview loads actual connections page and local chat list after recovery. No login/control form submitted. A fetch during explicit backend stop correctly refused; navigation/refresh recovered. No new post-recovery script error observed. No unrelated browser profile used. |

## Defects and QA harness dispositions

- **New P2, fixed and independently verified:** equivalent valid RFC3339 spellings (`09:00:00.000Z` then `09:00:00Z`) produced version2/new job at the ingestion port. The original actualPG regression failed before `aff272a` and passes unchanged on `f93be3a`. Normal mtcute normalization already emitted canonical timestamps; no global live duplication was alleged.
- Known saved-session startup retry, raw TooLong mapping and replay-isolation candidates pass the independent scenarios above. Their pre-fix REDs were owner/architect evidence; this report does not invent an independent pre-fix run.
- QA outage probe initially omitted its own idle-pool error handler; that harness crash was corrected and only its exact synthetic fixture removed. A subsequent Compose dependency-health wait was recovered without changing service data. Native probe quoting was corrected to a prepared SQLite insert. These diagnostic harness failures do not establish product failures; the completed runtime command above passes.
- The initially composed projector mirrored earlier **manual QA remote moves** into stale local ticket fields. The final no-automatic-move assertion checks actual remote bucket/done readback, preserving the intended mutation invariant rather than requiring a stale local mirror to stay stale.

## Remaining gates and resource state

No unresolved release-critical M2 code defect was found in this bounded slice. Live login/2FA, actual saved-account restoration, actual dialog/history/catch-up/reconnect and actual operational sends/groups remain **NOT RUN**. No real Telegram account, login code, private contact, real provider request or Jev entitlement retry was used. Live successful Jev remains externally blocked; mocks/native preparation do not clear it. M3.2 approval/apply and M4 Hermes/MCP remain separate assignments; final demo recording follows all integrated tests/fixes.

QA stack remains running on its own ports/volumes with `accountBound=false`, no default `client.session`, no active analysis/approved work and synthetic provider configuration. Exact route fixtures/random schemas/native files are cleaned; old M1 synthetic service data is retained. No A/architect/B stack, user profile, product/shared file, composition source or dependency was changed by this QA commit.
