# M4 app.close shutdown repair

The M4 transport tests originally invoked transport/workflow close directly. Independent architecture review found that production `app.close()` waits for active HTTP before Fastify `onClose`, while `onClose` was the only place that reached workflow/SDK socket cleanup. A held MCP request could therefore prevent the cleanup that closes it and leave the scheduler running after SIGTERM. Successful standalone transport drainage did not establish this root lifecycle boundary.

The approved repair changes only the B-owned workflow module. Registration installs a Fastify `preClose` hook calling the same internal stop routine exported as `module.stop`. It immediately marks the workflow stopped, aborts the scheduler, clears its timer, unsubscribes control and closes/rejects new transport calls. It then awaits all captured domain calls, scheduler work and control replies. Cleanup failures do not skip the remaining waits.

The first stop call captures one promise. Concurrent/repeated stop calls—including subsequent root `onClose` cleanup—return that same pending, fulfilled or rejected promise. The root app and shared contracts are untouched. Platform DB cleanup remains in root reverse `onClose`, after HTTP and workflow work have drained.

Verification in `tests/hermes/lifecycle.test.ts` uses **production buildApp + createWorkflowModule + actual loopback HTTP/official MCP SDK**, with an explicitly controlled SQL scheduling fixture and correct migration checksums. This is lifecycle/protocol proof, not real PostgreSQL/advisory-lock/provider evidence:

1. Held SDK MCP read: `app.close()` unsubscribes/halts scheduler before read release; no new scheduler phase over a full 1.1s interval. Repeated stop remains pending; DB stays open. Releasing the read completes close without client abort, with domain completion before DB closure.
2. Same held-read ordering for the canonical HTTP endpoint.
3. Normal completed SDK read followed by close; repeated close/stop yields one unsubscribe and one DB close.
4. Synthetic unsubscribe failure: repeated stop shares the rejection but still waits for the held domain call; root failure cleanup closes the platform DB afterward.
5. Owned child process receives actual SIGTERM and calls production `app.close()` with an official SDK request held by the parent. Stop happens before HTTP drain; no subsequent scheduler phase; DB remains open until release. The child exits naturally with code0, without aborting or closing the parent's SDK client first. Test failure cleanup can kill only that exact owned child.

Commands: `npm run typecheck && npx vitest run --maxWorkers=2 && npm run build`. No real model/Jev, Telegram, DB network, Hermes profile or container action is needed for this repair. Existing real PG/Vikunja and live Hermes evidence remains separately recorded in M4_HANDOFF.md. The actual-Hermes pending-proposal acceptance item remains outstanding; this repair makes no new claim about it.

Owner result: **5/5 focused lifecycle checks PASS; full suite 272 passed / 58 explicit opt-in skips; strict TypeScript/build and git diff --check PASS.** The owned SIGTERM child exited0 and no lifecycle test child remains. Independent exact original-repro rerun/QA acceptance is separate. The newly reported platform HTTP checksum-readiness issue is assigned to A and is deliberately excluded from this lifecycle-only commit.
