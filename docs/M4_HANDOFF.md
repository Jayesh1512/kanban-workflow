# Builder B M4 handoff

Scope: HTTP/MCP transport wiring, status augmentation and B tests/docs only. No shared contracts, package/lock files or root composition changed. The already integrated `[platform, workflow]` composition supplies the same service instances. M3.2 architectural repairs were a separate commit, `8602ce34` (PM main `d6b56b4`), independently closed by architect; broader QA acceptance is separate.

## Transport behavior

- All 22 B canonical HTTP operations registered from API_OPERATIONS; six chat HTTP routes remain platform-owned. All 27 allowed MCP tools use the same records/analysis/proposal/chat service methods.
- Actual official SDK Streamable HTTP `/mcp`, stateless POST; SDK initialize/list/call and protocol validation. GET/DELETE deliberately 405. No approval/direct stage movement/send/login MCP escape tools.
- Strict transport schemas, source/origin binding, typed params/query, canonical error envelopes, readiness checksum gate and durable command idempotency through services. Successful HTTP bodies are direct domain records/pages. Tool text JSON matches them; structured arrays use an object wrapper.
- Operator HTTP decisions retain approve/reject/correct; correction replacement remains separately pending. Inference/Hermes proposals never move a lane.
- Existing A-first `/api/status` route is augmented after registration with same-instance workflow/extraction/Jev status; configuration and other platform fields remain. Before migration and DB outage stay usable and sanitized. Provider status reads do not call upstream.
- Registration starts no new scheduler/subscriber; workflow keeps its single existing worker/subscription. Shutdown closes SDK transports and drains active domain calls before DB cleanup.

## Owner verification

Default command: `npm run typecheck && npx vitest run --maxWorkers=2 && npm run build` — **267 passed, 58 explicitly skipped; strict TS/build PASS** on this branch after the shutdown-drain/checksum-ingress checks. New default slice: 13 HTTP/SDK binding/error/protocol/shutdown checks + 2 real A-route-order status checks. Binding tests use synthetic domain proxies and prove transport dispatch, not domain correctness or upstream behavior.

Actual isolated stack: PostgreSQL **17.11**, production PgDatabase, pinned Vikunja **2.7.0**, generated ephemeral service credentials captured only in memory. Project `antseed-b-m4-20261017`; random private SQL schemas, fresh temporary Telegram session paths, no existing personal session or live AI key. Explicit run:

```sh
WORKFLOW_TEST_PROJECT=antseed-b-m4-20261017 \
WORKFLOW_TEST_COMPOSE_OVERRIDE=/tmp/antseed-b-m32-compose.yaml \
WORKFLOW_TEST_PG_PORT=56439 \
WORKFLOW_TEST_VIKUNJA_URL=http://127.0.0.1:35439 \
npx vitest run tests/hermes/integration.test.ts tests/workflow/real-integration.test.ts --maxWorkers=1
```

The combined native run passed **19/19** (6 original M4 + 13 M3.2 recovery regressions). After adding the checksum-ingress case, the expanded M4 slice passed **7/7**: **20 distinct native checks** in total. The M4 slice checks all operation families using actual repositories, HTTP and SDK: directory/contact CRUD, roles/context/facts/evidence/priorities, actions, same-key replay, optimistic conflicts, six chat tools, import state, mapping correction/exclusion, stale proposal rejection, correction/rejection, no mutation journal/lane movement from Hermes proposals, and explicit replay only after excluding its source in a no-live-key fixture. Status includes the durable known Jev pause; DB outage remains HTTP200 with sanitized component failure. Model outcomes used to seed these records are clearly controlled fixtures, **not live extraction/Jev evidence**.

## Installed Nous Hermes terminal evidence

Actual installed `hermes` CLI **0.21.3** (local upstream commit `6cd25026`), its existing runtime/account/model configuration, isolated temporary profile `antseed-m4-20261017`. Standard `profile create --clone --no-alias` was used; only the owned clone was configured, all inherited MCP servers/skills/memory were removed there, and its sole server was `http://127.0.0.1:4937/mcp`. Original profile was never selected or edited. No profile switch, gateway restart or unrelated account/server modification.

A real application was launched with `tests/hermes/demo-server.ts`, production platform/workflow modules, random actual PG schema, actual Vikunja projection and synthetic Cedar/company/contact/fact/evidence records. No real AI credential was loaded by this application; known Jev pause remained in effect. Commands:

```sh
hermes -p antseed-m4-20261017 mcp test antseed
hermes -p antseed-m4-20261017 chat \
  --query-file /tmp/antseed-b-m4-hermes-query.txt --oneshot \
  --max-turns 4 --run-budget 60 --format stream-json \
  --ignore-rules --reasoning low -t antseed
```

Discovery connected in **484ms**, found all **27** tools. The actual configured `gpt-5.6-luna` Hermes run used `tool_describe`, then **mcp__antseed__get_ticket_context** and **mcp__antseed__list_proposals**, both successful. It reported **To be started**, the existing evidence ID and **0 pending proposals**. CLI/result exit **0**, duration **7.379s**. This is a real Hermes model+MCP client run against actual SQL/Vikunja-backed synthetic records, distinct from the generic SDK tests. An initial three-turn run also returned the correct answer but exited1 because schema discovery consumed a turn; the four-turn run resolves that bounded-client-budget limit. Neither run invoked replay, a write tool, Jev, Telegram or external companies.

Sanitized local evidence remains in `/tmp/antseed-b-m4-hermes-events-final.jsonl` and its stderr log; only synthetic tool results/model metadata, no keys. Public synthetic manifest `/tmp/antseed-b-m4-public.json` contains IDs/loopback URL only. Nothing from the private Hermes config or service credential bundle is copied into this repository or report.

One additional actual-Hermes proposal-only attempt was requested before cleanup. **It did not establish the live write path.** The test author mistakenly supplied noncanonical `targetLane="To Review"` instead of `Work in progress`. Hermes called only `tool_describe`, read the canonical enum and declined; it never called `propose_lane_change`. CLI exit0 in7.838s is **not a proposal success**. Per the explicit single-attempt/no-loop limit, no replacement model attempt was made. Independent readback through actual SQL/production Vikunja adapter confirmed **0 proposals, 0 mutations, local To be started/stage0, remote initial bucket unchanged**. Evidence: `/tmp/antseed-b-m4-hermes-proposal-events.jsonl` and `/tmp/antseed-b-m4-hermes-proposal-readback.json`. Actual-Hermes pending-proposal creation remains a specific outstanding live-client check; SDK+real repository tests do prove pending-only behavior.

The installed Postman CLI separately sent actual local HTTP requests: directory GET **200, 2/2 script assertions passed**; malformed limit GET **400**, canonical validation/retryable-false envelope observed. No collection publication, cloud deployment or workspace edits.

## Limits

No successful live native Jev response/model identity has been established. The historical real Vercel403 entitlement failure remains an explicit durable pause; **no fresh Jev request** was made. Controlled provider fixtures, native protocol tests, actual PG/Vikunja and actual Hermes model/client evidence are separate categories. Live Telegram login/import/control delivery remains unverified by this milestone. Independent QA owns acceptance; these are owner results.

## Cleanup and secret verification

The exact owned demo process received SIGTERM and exited0 after closing modules/dropping its random schema. `hermes profile delete antseed-m4-20261017 --yes` removed only that temporary profile; the original default profile remains. The exact Compose project was removed with its own four volumes and network. No A/QA/user stack was touched. A private scan of 24 new/edited/evidence files against supplied AI keys, the temporary profile's credentials and generated service secrets found **0 matches**; no key values or fingerprints were printed. `git diff --check` PASS. Sanitized synthetic evidence logs remain in `/tmp` for review.
