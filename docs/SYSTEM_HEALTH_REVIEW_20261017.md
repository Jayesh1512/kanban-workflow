# System verification — 17 October 2026

The personal app is deployed with the verified backend image
`sha256:9debd3c756ed48cb89fec5aa98c81ebfbcf56adc96b8caa1d477dd8ac9bb3ace`.
At **18:05:21 UTC**, all eight service components were ready, account binding
was intact and `/health/ready` returned 200. This is a timestamped operational
check, not a claim that all historical messages have finished analysis.

## Fresh checks

| Check | Result and evidence class |
| --- | --- |
| Default suite | 450 passed; 146 explicitly opted-in integration cases skipped in that run |
| All opted-in suites | **146/146 passed, zero skipped**, across 24 files, actual isolated PostgreSQL17.11/Vikunja2.7 |
| Combined distinct tests | **596/596** across default and opted-in runs; strict TypeScript and production build passed |
| Lane classification | Fresh **50/50** actual GPT-6 Luna calls with synthetic conversations/authored extraction; all six lanes, Hindi/Hinglish, negative and uncertain cases |
| Installed Hermes | Actual CLI connection/discovery of all 27 tools, exit0; temporary empty profile deleted, default config/env unchanged; no new Hermes model run |
| Container runtime | Actual Linux ARM64 Node22 target build, canonical `node dist/main.js` |
| Native storage | Two separate `--network none` containers prepare/close/reopen real SQLite + pinned mtcute session storage |
| Lifecycle | Actual isolated Compose restart and down/up preserve IDs, data, generated credentials, files and single service user; Vikunja outage/recovery keeps UI/liveness reachable |
| Failure recovery | Real SQL termination, same-worker claim fencing, all seven compiled-worker SIGKILL windows, lost accepted HTTP responses, 401/429/503 recovery, concurrent apply/projection and exclusion |
| Readiness | Simultaneous genuine readiness readers coexist; exclusive migration still blocks them; wrong/missing/unknown ledger and real DB outage remain guarded |
| Credentials | Final 31 changed/new source/test/report files plus final image history and all 11 decompressed/tar image layers: zero actual configured/personal generated credential matches. Earlier isolated-image scan also checked synthetic credentials and test JWT |

Native integration and compiled crash workers ran on host Node26.4. Container
restart/storage checks used target Node22.23.3. Synthetic Telegram transports
prove SQL/recovery semantics, not an authenticated Telegram conversation for
each scenario. Actual personal Telegram receipts/movements are listed below.

## Repairs discovered by the audit

1. **Concurrent readiness checks could reject healthy work.** Both HTTP and MCP
   readers used exclusive migration locks. A controlled real-PG test reproduced
   pending/503 while another reader held its lock. Readers now take shared
   transaction locks; the migration writer retains its exclusive lock. Both
   original reader-overlap and writer-blocking assertions pass.
2. **Schema-local ledger absence could fall through to another schema.** In an
   isolated database with `search_path=<dataset>,public`, dropping the dataset's
   ledger exposed public's ledger. Both gates now check the ledger in
   `current_schema()` explicitly. Missing-ledger requests remain 503 and do not
   recreate data. The personal public-schema deployment keeps the same manifest.
3. **One unsourced optional display-name alias rejected an entire extraction.**
   The Responses adapter can now omit only such unsupported name aliases, while
   retaining source-bound identity and otherwise valid fields. It re-runs the
   unchanged strict validator, rejects unsupported identities/phones/roles/
   affiliations/facts/dates, bounds normalization work and records omitted-name
   counts in provenance. No guessed replacement is created.
4. **Repeated excerpt text inflated extraction requests.** Exact duplicate
   excerpts are represented by their versioned message references; every
   original message, snapshot and nonduplicate excerpt remains available.
   Validation/checkpoint hashes still use the complete original input.
5. **Large historical contexts could exceed the 90-second timeout.** A later
   request timed out after the earlier healthy snapshot, so the final image
   extends contexts of at least 48,000 serialized characters to 180 seconds
   per attempt. Smaller requests retain their configured timeout; an explicitly
   longer configured limit remains respected. Claims cover the whole retry
   budget (430 seconds with personal settings), with no model I/O in SQL
   transactions. Controlled transport/extractor and lease regressions pass.
6. **Worker shutdown could park an interrupted extraction as terminal.** An
   aborted HTTP request now remains durably retryable under a fresh queue claim;
   it does not retry within the stopped process. A processor/queue regression
   verifies durable retry/reclaim. Source/policy fencing and the decision
   dispatch recovery rules remain intact.

The first integration runs also exposed stale test assumptions from M1/M2 and
test-only login throttling/expiry. Fixtures now support explicitly isolated
ports, reuse a privately captured valid test JWT, wait for documented recovery,
and keep an uncertain create receipt hidden until restart when testing that
window. Production authentication/rate limits were not changed. Initial failed
logs are retained; the final complete native run is green.

## Real provider and personal readback

Two bounded historical extraction checks used the real configured OpenAI model:

- A prior source-name rejection: 52 messages, request reduced from 93,261 to
  69,978 bytes, valid extraction in 32.9s (24,473 input / 2,083 output tokens).
- A prior timeout: 100 messages, request reduced from 149,451 to 124,065 bytes,
  valid extraction in 81.8s (41,209 input / 5,265 output tokens), within the
  configured 90-second timeout. Neither detached probe persisted model output.

After deployment, one scoped canonical retry of the previously rejected
historical analysis completed successfully in the real worker. An explicit
idempotent recovery call then requeued the **29 remaining eligible historical
failures** through the existing API; stale/excluded work was not revived.
After the final timeout/cancellation deployment, another explicit recovery
queued two eligible interrupted/failed jobs. The existing live card was also
rechecked through the canonical queue without duplicating its applied proposal.
At the final healthy snapshot, **76 analysis jobs** and **384 replay checkpoints**
were pending; proposals pending was zero. These counts change as catch-up runs.
Historical import/replay and these retries continue asynchronously. Source
validation may still withhold unsafe outputs; no exhaustive model-accuracy or
finished-backfill claim is made.

Native board readback agreed with local SQL:

- Task1: **Blocked**, stageVersion2; the user's earlier Work in progress and
  Blocked approvals are applied, their Telegram notifications sent once.
- Task2: **To be started**, stageVersion0, company-unknown prospect retained.
- No prepared/unknown/confirmed mutation was left outstanding. Rechecking the
  existing live card did not send a duplicate proposal or move it.
- 409 business chats included; the one configured Approvals group excluded from
  business analysis. Existing selection/account/session data was preserved.

No new Telegram login/code/group creation, company-chat send, inferred approval,
or manual stage mutation was performed by this audit. Only the personal backend
was recreated. All destructive probes ran in the newly created synthetic
`antseed-qa-m1-system-20261017-f08d8f` project on loopback19680/19681/19633.
That project's containers/network/four volumes were removed after label
verification; existing personal/demo/QA/builder/architect stacks were retained.

## Reproduction/evidence

- Default suite: `npx vitest run --maxWorkers=2`,
  `/tmp/antseed-system-final-accepted-tests.log` (450 default cases). All 146
  native cases were run before the final bounded timeout/cancellation followup;
  its seven added regressions are included in the final default run.
- Native suite: explicit project/port/env opt-ins, serial
  `--maxWorkers=1 --no-file-parallelism`; final `native-complete-pass.log` under
  the directory in `/tmp/antseed-system-check-manifest-path`.
- Same directory: manifest, original failed runs, controlled gate red/green,
  Compose lifecycle results and sanitized secret-scan summary. The test JWT
  was private0600 and removed at cleanup.
- Fresh real classifier run: `/tmp/antseed-system-lane-eval.json`,
  `tests/intelligence/lane-scenarios-live.ts`. Its synthetic source expectations
  and previous committed sanitized results remain in `tests/intelligence/` and
  `tests/fixtures/`. Original 35 relationship fixtures were preserved.

- Final deployed image build: `/tmp/antseed-system-final-accepted-build.log`;
  final allowlisted status: `/tmp/antseed-system-final-runtime-status.json`;
  final secret scan summary: `/tmp/antseed-system-final-secret-scan.json`.

The original demo artifacts were not edited or staged.
