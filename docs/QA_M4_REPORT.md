# Independent M4 HTTP/MCP/Hermes acceptance

**Code/local integration and installed-Hermes pending-proposal PASS.** Final product `feb00af` contains lifecycle repair `91d9788`/`caa25ef` and HTTP checksum repair `b8a2873`. Exact tested QA merge is `10cafc2b7d2ec198d52f31854a3be04bcb80d34f`. All **13/13 independent tests pass, zero skips**; both M4 P1 groups are green. This is QA evidence for actual local services, with synthetic company records; no authenticated Telegram or successful live Jev claim.

## Reproduce the local integration set

```sh
QA_M4_PROJECT=antseed-qa-m1-06374d3-20261017a \
QA_M32_PROJECT=antseed-qa-m1-06374d3-20261017a \
  npx vitest run tests/qa-m4-integration.test.ts tests/qa-m4-status.test.ts \
  tests/qa-m4-lifecycle.test.ts --maxWorkers=1 --no-file-parallelism
npm run typecheck
npx vitest run --maxWorkers=2
npm run build
```

The project variables must identify the existing **QA-owned** project; the helper refuses another prefix or differing M4/M3.2 projects. Tests instantiate production `buildApp([platform,workflow])`, production repositories/queues and official MCP client/server SDK over actual loopback HTTP, with actual PostgreSQL17.11/Vikunja2.7.0. Each test uses its own migrated random schema and synthetic remote task, removed afterward. Host Node26.4.0 executes this local graph; this is not a new canonical Docker image/native compatibility claim. The previous M1/M2 image evidence remains separate.

## Independent assertions

| Area | Executed evidence |
| --- | --- |
|Exact catalog/protocol | Official SDK initialize/discovery yields the independently enumerated27tools. Real dispatches cover every27tool and all28canonical HTTP operation families, including the six solely platform-owned chat routes. No approval/decision/direct-move/send/login escape tool exists. GET/DELETE405/AllowPOST, missing acceptable MIME406, malformed JSON and REST-shaped body400/JSON-RPC error. Pinned SDK reports schema-invalid envelopes as -32700; this follows its local SDK source rather than inventing a protocol shim. |
|Actual service parity | Company/contact CRUD, sourced roles, tickets/context/evidence/facts/priorities, manual actions/fact lifecycle correction, shared idempotency and optimistic version conflict are exercised through actual HTTP and MCP against the same canonical service graph. Data are synthetic, persisted through production SQL; no proxy return value substitutes for domain records. |
|Provenance/permission | MCP proposals persist `origin=hermes`; HTTP proposals persist `origin=manual`. Contradictory origins/mapping source and malformed/extra schema input reject. HTTP corrections return original corrected plus a separately pending replacement, rejection is terminal, and stale source approval409. These operations create no journal or actual remote move. No direct MCP decision surface exists. |
|Chat service ownership | All six HTTP and MCP chat paths share actual policy/import/mapping data; MCP mapping audit is `mcp`, HTTP audit is `http`, with reason/evidence. Explicit exclusion suspends tracked work. Replay is tested only after exclusion with synthetic/no live credentials, so it cannot issue a provider call. |
|Typed boundaries | Decimal GET limits, repeated/unknown query keys, UUID/path contradictions, malformed JSON, strict tool arguments and source/origin spoofing reject before mutation. Actual not-found404, optimistic/stale409, validation400 and unavailable503 envelopes include stable error code/retryable/requestId. |
|Checksum P1 | On original201d7fc, MCP rejects after deliberately corrupting actual schema_migrations checksums, but A HTTP inclusion returned200 and committed `{inclusion:excluded,policy_version:1}`. The original expected503/unchanged SQL regression passes unchanged on feb00af. All six A routes now reject under wrong checksum, unknown applied migration and missing ledger entry; actual policy/import/mapping rows stay unchanged. |
|Status before migrations | Hold explicit migration-lock entry in a genuinely empty actualPG schema. Status/UI/protocol discovery remain reachable; ready and business tools are unavailable, Jev status is `database_pending`, and no table is fabricated. Release initialization: real migrations complete and company list becomes200/empty. Fresh Telegram remains disconnected. |
|Real dependency interruption | A TCP proxy to actual PostgreSQL is disconnected, including existing sockets. UI/live/status remain200, readiness503, HTTP/MCP business calls return typed unavailable, and component errors contain no DB URL/endpoint or service secret. Reopening TCP forwarding restores domain200. This is a real connection interruption, not a mocked query exception. |
|Shutdown P1 candidate | On caa25ef, start actual canonical SDK and HTTP reads and hold them after real SQL. Actual `app.close()` interrupts MCP before the client is manually closed, rejects new work and awaits both captured reads. Repeated stop remains pending. Both reads can still query PostgreSQL before completion; platform DB closes last. Emergency socket cleanup is in finally and cannot turn a failed assertion green. This independently verifies the app lifecycle boundary; architect's separate SIGTERM evidence is supporting evidence, not substituted for this check. |

## Installed Hermes: actual pending-proposal PASS

One actual installed `hermes` CLI model attempt ran on `caa25ef` / QA merge `26f0e937b03474b1f3b9ce72175e0d54791896f4`, Hermes Agent **0.21.3**, upstream **6cd25026**. It used a newly cloned temporary profile, removed inherited servers/skills/memory and enabled only the isolated antseed MCP endpoint. The default profile was never selected or edited.

Discovery found27tools. The model invoked **mcp__antseed__propose_lane_change**, using canonical **Work in progress** and current synthetic evidence. Real SQL readback found exactly one proposal `55a74014-681c-438e-ab06-6362b718da64`, `origin=hermes`, `decision=pending`, `apply_state=not_requested`. Local ticket stayed **To be started/stage0**, actual Vikunja bucket remained unchanged and mutation count was0. CLI exit0. Default config and `.env` were byte-identical before/after. The exact temporary profile, synthetic task and random schema were removed.

Sanitized result artifact: `/var/folders/cg/g6zcn0xn237dnp6xrmh694y40000gn/T/antseed-qa-m4-hermes-cUZYy2/sanitized-result.json`. It contains version/tool-name metadata and synthetic SQL state only, with no profile contents, prompt history or credentials. `tests/qa-m4-hermes.ts` preserves the reproducible procedure; it is excluded from npm test and requires an explicit one-shot flag. A persistent temporary guard prevents another model invocation for this assignment. **Do not rerun merely for unrelated HTTP/lifecycle changes.**

The first CLI setup preflight rejected combining `--clone` and `--no-skills` before creating a profile/model run. The corrected setup clones normally, then removes only the clone's skills/memory. There was one model attempt, no model retry loop. Reading the pinned SDK's invalid-envelope error classification corrected an initial test expectation; no product behavior was weakened.

## Final verification and limits

Final independent opt-in set: **13PASS / 0FAIL / 0SKIP** (9actual domain/transport/checksum scenarios, 3status/protocol/dependency checks, 1actual integrated shutdown case). The separately executed installed-Hermes single-run check also passes and is intentionally not part of npm test. Frozen default suite: **280PASS / 0FAIL / 142explicit opt-in SKIP**, 33passed/22skipped files. Strict TypeScript, production build and diff check PASS. Opt-in skips are not claimed as executed integration checks.

The pre-migration test originally paused an optional initialization `SELECT 1`. The repair removed that query, so the harness now pauses the explicit migration-lock entry, preserving the original zero-tables/pending/readiness assertions. This is a test scheduling adaptation, not a product defect or a weaker checksum expectation.

Final private audit: zero residual random QA schemas, no temporary Hermes profile, and zero generated/Hermes credential matches in the six new QA files. Projected synthetic tasks and owned session directories are removed by their fixtures, listener/proxy sockets closed, SDK clients closed and canonical app shutdown drained. The existing QA Compose stack remains available with its historical synthetic M1/M2 data; no other stack was changed.

No product/shared/dependency/composition file is edited by these QA files. No existing Hermes profile/session, owner stack, private Telegram chat/contact or real Jev request is used. No unresolved release-critical M4 defect was reproduced after these repairs. Successful live Gateway inference remains externally blocked; installed Hermes model/client success does not clear that gate. The final integrated real-UI demo remains the later M5 deliverable after accepted fixes/tests.
