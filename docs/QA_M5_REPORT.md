# Independent M5 canonical deployment acceptance

**Local canonical deployment: PASS. Authenticated Telegram: NOT RUN. Successful live Jev: externally blocked.** This is the bounded current-image acceptance, carrying the accepted M1–M4 scenario evidence rather than repeating every suite. No additional Hermes model, OpenAI, Jev or Telegram request was made. PM owns the separate demo recording.

## Exact deployment retained for review

| Item | Verified value |
| --- | --- |
|Accepted product | `5d2603d`, including all M3.1/M3.2/M4 domain, concurrency, checksum and shutdown repairs |
|Built source checkout | QA merge `87b5b673e70e4dc353666423ff2ce297cd3b9b8d`; product tree matches5d2603d |
|Backend image | `sha256:14cc126186c877ae28459fcd212bb26752a13325b827880b8bb973d11b61fa85` |
|Vikunja wrapper image | `sha256:11e73e90f0568488d70b20bc067d447baa3fe09d55640e061a23541ec2c8c50f` (actual pinned2.7.0 binary) |
|PostgreSQL image | `sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826` (17.11) |
|New isolated project | `antseed-qa-m5-20261017-33829a` |
|Loopback ports | Backend19080, Vikunja19081, PostgreSQL19433; availability rechecked before creation |
|Runtime | Actual LinuxARM64, Node22.23.3, UID1000; image and container CMD both `node dist/main.js`, no Compose command override |
|Owned volumes retained | Project-prefixed `postgres_data`, `runtime_state`, `vikunja_files`, `telegram_sessions` |
|Manifest | `/var/folders/cg/g6zcn0xn237dnp6xrmh694y40000gn/T/antseed-qa-m5-p0eU1O/manifest.json` (public IDs/paths/settings only) |
|Sanitized evidence | Same directory `evidence.json`; local transcript `/tmp/antseed-qa-m5-runtime.log` |

The image was already built when `ba84edb` arrived. Compared with the tested product, its only source difference is **one expression in src/platform/page.ts**: when provider detail is null, newer code says `Ready` only for state=`ready`, otherwise it displays code/state. The retained image has the older fallback; the actual browser showed `extraction · connecting` with the old detail `Ready`, while HTTP correctly reported `not_checked`. This is the known, separately fixed P2 wording difference, not a claim that the follow-up expression is inside this image. No domain/schema/package/runtime behavior differs. Deployment documentation follow-ups are also outside the frozen image. PM explicitly allowed reporting this already-built baseline without a rebuild/model rerun.

## Reproduction and executed evidence

```sh
# Creates ONE new uniquely named project and fresh volumes, refuses occupied ports.
node tests/qa-m5-bootstrap.mjs
# Uses only the saved QA manifest; retains its synthetic review data/volumes.
node tests/qa-m5-runtime.mjs
node --check tests/qa-m5-bootstrap.mjs
node --check tests/qa-m5-runtime.mjs
git diff --check
```

The bootstrap performs exactly canonical `docker compose ... up --build -d`. The temporary override only publishes QA PostgreSQL to loopback; backend/Vikunja ports use the documented variables. The synthetic AI env lives outside the allowlisted Docker build context and mounts read-only. No existing account/session/configuration is copied. The Dockerfile runs clean npm installation, production TypeScript compilation and target-native build probes in the fresh build. This handoff adds only QA scripts/report; no product, package, shared contract or composition change.

Runtime script and syntax/diff checks exit0. Its six assertion groups establish:

1. **Automatic fresh bootstrap/current runtime.** New project had no containers/volumes before the single up. PostgreSQL, its real migrations, separate Vikunja database, one service user and managed board initialize automatically. Actual container/image CMD match dist/main.js; only the four owned volumes are mounted. AI mount rejects append with EROFS; generated bundle is UID1000/mode0400. Initial account0/jobs0/proposals0, no default `client.session`. `/health/live` is200 with stable status/service; ready503 truthfully reflects disconnected Telegram/provider pause. OpenAI presence is `not_checked`; Jev has the durable known-entitlement pause, with no probe.
2. **Exact native board semantics.** Actual v2 readback gives six managed buckets, one each: To be started, Work in progress, Integrations, Blocked, Archived, Completed. Four workstream labels: Buyer, Provider, Integration, Others. Default points to ToStart; done points to Completed; filter is null. There are no extra native buckets in this fresh project. Repeat startup keeps one service user.
3. **Official SDK and real pending-only flow.** Actual initialize/tools-list discovers27tools; approval/decision/direct-move/send/login tools are absent. HTTP creates an idempotent synthetic company, MCP creates a sourced contact/role, and HTTP ensures the company-chat ticket. A clearly labelled **manual SQL fixture**, not Telegram ingestion or inference, supplies the synthetic message, snapshots, evidence and contact linkage. Current real context is read through MCP. The real worker projects its task. MCP proposal creation persists origin=`hermes`, decision=`pending`, applyState=`not_requested`; same key returns the same proposal and HTTP reads the same record. Local stage0, actual remote ToStart/undone, mutations0.
4. **Actual current-image SIGTERM.** Hold the SDK `list_companies` domain read with a real PostgreSQL ACCESS EXCLUSIVE table lock. Its unique list-query shape is observed waiting in pg_stat_activity, and the SDK promise is still pending immediately before TERM. Send actual SIGTERM to the owned canonical PID1 container. MCP is interrupted before any manual client close; container remains running until the domain lock releases, then exits naturally0. Restart restores service and unchanged data/credentials. A first successful shutdown check was tightened to distinguish the SDK list query from any background company detail read; the strengthened version passes. No image command/test hook replaces the real entrypoint.
5. **Restart and down/up persistence.** Repeat canonical up, then actual down/up without removing volumes. Local ticket/task/proposal IDs, stage/version, source/context projection, board bucket/label IDs, migration checksums and raw remote task bucket/done/title/description/labels remain identical. Credential bundle compares privately unchanged. The pre-recreation service JWT still works, establishing signing-secret persistence. Fresh SDK discovery still has27tools and reads the same pending proposal. No approval or lane write occurs.
6. **Native/offline and secret handling.** Two separate current-image containers with `--network none` write/read a real better-sqlite3 database and prepare/destroy/reopen mtcute session storage on the writable owned session volume. Actual installed versions: node/core/html-parser/markdown-parser0.32.4, wasm0.32.0, better-sqlite3 12.10.0. Synthetic files use `qa_m5_offline_native*`, separate from the absent default account session. Public HTTP bodies, all scoped service logs, image history and streamed exported layers of **both backend and Vikunja images** contain zero matches for generated passwords/signing secret, temporary JWT and synthetic AI keys. No image archive or credential artifact is written.

The complete runtime script passed after the tightened SIGTERM assertion. Its idempotent fixture keys/evidence marker permit safe resumption on its own retained project; initial fresh-empty proof is stored before seeding. No volume reset or broad cleanup is used. Production code did not change during the run.

## Retained synthetic review state

- Backend: `http://127.0.0.1:19080/`; Vikunja: `http://127.0.0.1:19081/`. Generated credentials remain only in the owned runtime volume, never this report.
- Company `109370dd-988d-405c-accc-8e723dac8cf1`, chat `-1000000005050`, ticket `e06dfde9-56ec-41cb-94ca-56bddae87861`, remote task1.
- Contact `d7abcac9-1eb0-4271-a9e2-b763edcb1db7`, evidence `390cda57-070a-462c-ba0b-0bb46995e590`, pending proposal `8a57238a-8d4c-458f-9964-9b87e67a1886`.
- Final account0, analysis jobs0, mutation journals0. One pending authored proposal; actual initial bucket/undone unchanged. Current status visibly reports missing operational control. All three long-running services healthy; init completed successfully.
- T3 owned incognito preview opened only this backend, loaded the synthetic chat table via GET and observed no console errors. No phone/code/control form was submitted. Default browser/profile and Hermes profile were unused.

Existing M1 container IDs, image IDs, StartedAt timestamps and states compare unchanged before/after. PM demo19180/19181/19432 and personal19280/19281 projects were not targeted. Only the newly owned M5 project is stopped/recreated/restarted by these scripts; it is left running with all four volumes and review data.

## Limits and disposition

No new release-critical defect was reproduced in this bounded deployment acceptance. The known page-only wording difference is explicitly disclosed above. The earlier broad M4 suite280PASS/142opt-in SKIP, actual13 M4 checks, accepted42 M3.2 checks and real installed-Hermes pending-proposal evidence remain historical accepted evidence; they are not represented as fresh M5 reruns. The fresh Docker build and actual M5 runtime checks are the new evidence.

Authenticated Telegram login/history/live catch-up/control sends remain **NOT RUN** because this QA project has no account prerequisite. The manually seeded conversation is not proof of live Telegram. Successful live Vercel Jev remains externally blocked by the previously observed entitlement restriction; no new entitlement request, provider fallback or fabricated inference is used. No extra Hermes model run occurred. PM's final demo recording is a separate deliverable and must label synthetic boundaries.
