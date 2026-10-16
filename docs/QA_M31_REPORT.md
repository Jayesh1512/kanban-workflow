# Independent M3.1 acceptance

Implemented-scope result: PASS on `94d157b` (QA merged tree `9044fa8c451c8d64e1c26debfb49dcde3f94b028`). The product tree includes SQL date hydration, identity/precision, manual-lock/retry and source-introduction repairs. This is independent QA of committed records/providers/analysis code, not acceptance of M2, M3.2, M4, live model quality or the final release.

## Evidence and reproducibility

Run from the repository root with Node/npm/Docker available. `QA_M31_PROJECT` deliberately requires an existing QA-owned `antseed-qa-m1-*` project; host PostgreSQL defaults to loopback port18433 (`QA_M31_PG_PORT` override). No real provider credentials are loaded by these tests.

```sh
TZ=Asia/Kolkata QA_M31_PROJECT=antseed-qa-m1-06374d3-20261017a \
  npx vitest run tests/qa-m31-contracts.test.ts \
  tests/qa-m31-postgres.test.ts tests/qa-m1-noop.integration.test.ts \
  --maxWorkers=1 --no-file-parallelism
npm run typecheck
npx vitest run --maxWorkers=1 --no-file-parallelism
npm run build
```

The opt-in run passed **69/69, zero skipped**: 54 source/HTTP-contract checks, 14 actual PostgreSQL tests and 1 actual pinned Vikunja follow-up. Each SQL test creates a random `qa_m31_<uuid>` schema, applies the actual initial migration and drops only that schema after closing its pools. PostgreSQL is the retained QA Compose instance, not PGlite or another worker's stack. Tests use multiple production `PgDatabase` pools, real row/advisory locks and reopen connections. Generated service credentials are captured privately in memory from the QA runtime volume; no credentials are committed or printed. The existing M1 reports/regressions remain intact.

The frozen-tree full suite passed **186 tests, 38 opt-in tests skipped**, with strict typecheck and production build PASS. Default tests intentionally skip opt-in services; these skipped tests are not claimed as executed by a default run. An earlier parallel full run under simultaneous team load timed out one PGlite developer retry test at15s (175PASS/1timeout/38SKIP); the controlled single-worker rerun passed that test. A broad check that overlapped the final score-guard merge mixed old parser code with new assertions; it was superseded by the frozen-tree186/0/38 run, not counted as product acceptance. No timeout requirement or assertion was relaxed.

## Independent coverage

| Area | Evidence and precise limit |
| --- | --- |
|35-case corpus | All35 cases pass through the actual Responses adapter/native fetch into a local HTTP stand-in.34 current revisions preserve literal source text, Unicode, negative statements, original timestamps, snapshots, forwarding metadata and evidence IDs; deleted034 is rejected. The stand-in echoes an authored fact and performs **no classification**. This is not 35 successful model interpretations or lane decisions. |
|OpenAI/Gateway contracts | Strict Responses schema, split output blocks, fixed endpoint/model and bearer transport; actual local HTTP typed Jev distributions/diagnostics; malformed distribution rejected; weighted score discrepancy0.019 accepted and0.021 rejected under0.02 rounding tolerance; synthetic403 returned once without fallback, reflected secret or fabricated decision. These are stand-ins, not calls to either provider. |
|Identity and precision | Correct original-author phone accepted; forwarder phone, fabricated names/usernames, hidden-origin identity and unrelated AntSeed->internal assignment rejected. Day-only cannot become an arbitrary instant; fabricated date phrase and ambiguous-kal instant rejected. English029/Hinglish030/Hindi032 correct exact instants accepted; wrong1999 variants rejected.032 retains its original timestamp despite later punctuation edit/import. |
|Checkpoint/replay | Extraction/provenance/facts survive closing/reopening the pool before Jev. Entitlement pauses without repeated claims; explicit replay reuses a still-current checkpoint without a second extraction. Changed additional context forces fresh extraction; exclusion cannot revive the old job. No extraction is represented as a successful Jev decision. |
|Fencing/invalidation | Same external worker ID, expired/reclaimed job and different immutable tokens across independent pools: original save/complete/fail all reject without changing the new attempt. Exclusion, source edit/delete, mapping version, additional context and company-directory changes reject in-flight stale save/complete atomically. |
|Manual precedence/approval | Operator mapping history, manual next action/date and completed manual fact survive reanalysis. A synthetic Completed recommendation leaves seeded Integrations/stageVersion5 unchanged and creates no proposal or remote mutation in this milestone. |
|Directory/roles | Corpus026/027 preserve scoped message101 evidence, one shared contact/company and two chat tickets across pool reopen; operator role correction reads back.026 supplies explicit external introduction;027 supplies unknown affiliation because this source-only adaptation does not import the corpus's external-affiliation seed as fresh model evidence. No inferred affiliation is claimed for027. |
|Dates/priorities | With explicit process `TZ=Asia/Kolkata`, SQL DATE2026-10-18 reads back identically in facts/context after reopen, with no invented instant. The same instant yields overdue/urgent in IST and upcoming/normal in UTC; repeat priorities are deterministic. External promises, completed facts and Archived tickets are excluded. |
|Actual concurrency/recovery | A trigger/advisory gate parks manual correction while a second real connection saves analysis; both complete and manual state wins. A one-shot real PostgreSQL40001 during fact insertion becomes durable retry, then a second attempt completes. These are SQL execution/interleaving tests, not mocked transaction promises. |
|Vikunja304 follow-up | Two actual unchanged title/description PATCHes return native304 and succeed. Labels change Buyer->Integration, unrelated label/priority/due date/progress and Completed/done survive raw API readback. Another no-op preserves Archived while changing workstream. Only the new synthetic task/label are deleted afterward. The adapter runs locally against real pinned Vikunja; this is not a rebuilt M2 image acceptance. |

## Defect dispositions

| Finding | Independent RED evidence | Repaired independent result |
| --- | --- | --- |
|Known origin/profile/affiliation P1 | Original phone rejected; forwarding phone and fabricated profile/internal attribution accepted. Five identity assertions failed before d2d4269. | Original assertions pass after d2d4269 +7fd72e7. The positive external fixture was briefly isolated with unknown to diagnose the new guard, then restored to its original external assertion after the legitimate-introduction repair. Negative safety expectations were retained. |
|Known precision bypass P1 | Three authored day-only/invented-time/ambiguous-kal instant outputs accepted. | All reject after d2d4269; correct sourced exact time remains accepted. |
|Known lock/retry P1 | Real gated manual update fulfilled while analysis rejected40P01. A real injected40001 incorrectly became provider_unavailable/provider_invalid_response. | Both assertions pass after 6a043df; manual completion survives, current analysis remains recoverable and transient retry completes. |
|New multilingual date P1 reported to PM+B | Correct corpus030 rejected for missing clock;032 rejected for missing sourced calendar day on dbf3b81. English029 passed. | All three unchanged positive rows pass after d1e5375; arbitrary1999 outputs still reject. |
|Known date-only hydration | Owner-discovered before independent execution. | Actual-PG IST facts/context/priorities regression passes after ecdda1c. No claim of an independent pre-fix reproduction. |
|Known native304 | Owner-discovered before independent execution. | Actual upstream two304/readback/lane-preservation follow-up passes after 4914a60. No claim of an independent pre-fix reproduction. |

## Remaining boundaries

No release-critical M3.1 code failure remains in this tested slice. Live successful Jev remains externally blocked by the previously observed paid-credit restriction; no new entitlement request was made. No independent live OpenAI multilingual-quality result is claimed. Manual dispatch, authored extraction/decision fixtures and local HTTP success do not establish live Telegram or Hermes behavior.

The neutral corpus's complete semantic oracle (engineering review versus testing, negation, ambiguous/incidental/forwarded mapping, blocker/resumption, buyer-ID versus usage and campaign completion) still needs actual model/workflow evaluation at the integrated milestones. M3.1 intentionally has no scheduler, proposal/application service, remote task projection, domain HTTP routes or MCP tools; their absence is not an M3.1 defect. M2 startup retry/replay fairness and the final real-UI demo remain separate assigned gates. Private profiles and all other workers' stacks were untouched.
