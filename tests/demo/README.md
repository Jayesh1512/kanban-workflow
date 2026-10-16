# PM-owned Cedar demo helper

Tooling only. **PM executes these commands; Builder B has not connected to or mutated the PM stack.** No new frontend, agent/profile, model run, Telegram login/send or Jev call. No product/shared/package/composition edits.

The PM manifest is the explicit authority for one `antseed-pm-demo-*` project and three distinct loopback ports. Current assignment: project `antseed-pm-demo-20261017`, backend19180, Vikunja19181, PG19432. Read its exact manifest filename from `/tmp/antseed-pm-demo-manifest-path`. The helper neither launches nor stops Docker services and refuses a running backend during seed. That short stopped-backend phase prevents the normal scheduler from racing an authored analysis claim. The helper's checks apply only to demo tooling, not product authorization.

All scenario data is synthetic and displayed as such. Three source messages introduce Mira Sen (CTO) and Jo Rao (engineering lead) at Cedar Labs and an AntSeed commitment to send pricing/integration notes **tomorrow**. Both contacts share the company directory; Jo separately owns a review commitment. Snapshot identities/roles/evidence are explicit; source URLs stay null rather than inventing Telegram links. Tomorrow resolves against each original source time in Asia/Kolkata, retaining date-only precision.

Production ingestion binds a synthetic account, discovers one chat and persists the messages. Production analysis claims the real queue job, validates/saves an **authored extraction checkpoint**, then completes an **authored Jev decision**. Provenance models are `authored-fixture/no-live-openai` and `authored-fixture/no-live-jev`, request ID `synthetic-authored-demo:no-upstream-request`; the provider discriminator is required by the shared persistence contract. The ordinary analysis decision hook creates a pending `Work in progress` recommendation, origin `jev`. This origin records the pipeline type; it is **not live Jev evidence**. Use a persistent caption: **Synthetic messages and authored AI decisions; actual database, canonical worker, HTTP approval and Vikunja.**

There is no control chat, so `control_chat_missing` is an honest pending-proposal condition. The demo uses the existing operator HTTP decision endpoint. It does not demonstrate live Telegram control correlation. Previously accepted actual installed-Hermes transcript evidence is separate; do not run a new model for this helper.

## Exact PM steps

Run from the release checkout after integrating this helper. The PM already booted the canonical stack once and stopped only backend; if needed the explicit command below repeats that stop on this project alone:

```sh
PM_DEMO_MANIFEST="$(cat /tmp/antseed-pm-demo-manifest-path)"
PM_DEMO_DIRECTORY="$(dirname "$PM_DEMO_MANIFEST")"
PM_DEMO_OVERRIDE="$(node -e 'const f=require("node:fs");console.log(JSON.parse(f.readFileSync(process.argv[1],"utf8")).override)' "$PM_DEMO_MANIFEST")"
PM_DEMO_AI_ENV="$(node -e 'const f=require("node:fs");console.log(JSON.parse(f.readFileSync(process.argv[1],"utf8")).aiEnv)' "$PM_DEMO_MANIFEST")"

# Only if not already stopped. Keep existing PG and Vikunja running.
AI_ENV_PATH="$PM_DEMO_AI_ENV" BACKEND_PORT=19180 VIKUNJA_PORT=19181 \
  docker compose -p antseed-pm-demo-20261017 -f compose.yaml \
  -f "$PM_DEMO_OVERRIDE" stop backend

node --import tsx tests/demo/cedar-demo.ts seed --manifest "$PM_DEMO_MANIFEST"
```

Compose commands above resolve the exact manifest `override` and `aiEnv` paths. The helper also reads those exact fields, never a guessed path. Its commands do not use the user's provider env file. The generated bundle is captured from the owned Vikunja container only in memory. Database binding is constrained to this manifest's loopback port. Expected seed result: one ticket **To be started**, stage0, one pending/not_requested proposal and zero mutations; the task ID can still be null because **the helper never projects or applies**.

Seed writes these artifacts in the PM manifest directory:

- `cedar-demo.json`: sanitized IDs/URLs, source label, follow-up date, expected initial state, paths to the next artifacts. No secret values/JWT/DB URL.
- `cedar-approval.json`: fixed public operator approval body, with a durable idempotency key.
- `vikunja-browser-login.private.json`: only Vikunja URL/username/password, **mode0600**, created exclusively without following symlinks. PM/browser may read privately; do not print, record, paste into logs or commit it. It contains no AI/TG credential.

Now restart only this demo backend using the same PM override and **the manifest's explicit empty aiEnv path**. If PM has the Compose environment from original launch, reuse it:

```sh
AI_ENV_PATH="$PM_DEMO_AI_ENV" BACKEND_PORT=19180 VIKUNJA_PORT=19181 \
  docker compose -p antseed-pm-demo-20261017 -f compose.yaml \
  -f "$PM_DEMO_OVERRIDE" up -d backend

node --import tsx tests/demo/cedar-demo.ts verify-pending --manifest "$PM_DEMO_MANIFEST"
```

`verify-pending` polls for up to20s (plus one in-flight production DB/adapter timeout) for **the actual canonical worker** to project the task. It requires real Vikunja bucket **To be started**, local stage0, pending/not_requested proposal, no mutation journal, two contacts, and actual remote description/context carrying the synthetic source boundary. It saves `cedar-pending-readback.json`. This readback is evidence of real PG/Vikunja/worker behavior; authored model outcomes remain stand-ins. Open the sanitized `urls.board` / `urls.context` / `urls.proposal` / `urls.status` from `cedar-demo.json`. The board URL uses the existing project/view binding; the Vikunja root URL is also supplied.

Only when PM explicitly wants to record approval, use the existing HTTP operation. Substitute the sanitized `urls.approval` value from `cedar-demo.json` (no credential/header required by this app):

```sh
# Read only sanitized manifest fields, never the private login artifact.
PM_DEMO_APPROVAL_URL="$(node -e 'const f=require("node:fs");console.log(JSON.parse(f.readFileSync(process.argv[1],"utf8")).urls.approval)' "$PM_DEMO_DIRECTORY/cedar-demo.json")"
curl --fail-with-body -sS -X POST "$PM_DEMO_APPROVAL_URL" \
  -H 'Content-Type: application/json' --data-binary "@$PM_DEMO_DIRECTORY/cedar-approval.json"

node --import tsx tests/demo/cedar-demo.ts verify-applied --manifest "$PM_DEMO_MANIFEST"
```

Approval itself queues the operation; the existing worker owns session locking, actual remote movement, readback and local commit. `verify-applied` requires Work in progress in real Vikunja, local stage1, approved/applied proposal and exactly one committed mutation journal. It saves `cedar-applied-readback.json`. Repeating the same approval body is idempotent; repeating the readback must stay at stage1/one journal. This establishes one **logical** application; the helper does not claim an independently counted HTTP/RPC request trace.

## Repeatability and limits

Seed has a durable demo marker/anchor and reuses the same account/chat/messages. A completed pending scenario is reused; it is never reset or moved back. A partially interrupted claim must expire before retry. A populated unrelated dataset, wrong project/ports, nonempty AI/TG credential file, running backend during seed, or modified fixture marker fails without clearing data. After approval use `verify-applied`; do not reseed/reset for a recording. For a fresh initial scene PM creates a new isolated project/volumes and a new explicit manifest. Cleanup belongs to PM and must target only its exact demo project and artifacts.

Local verification is `npm run typecheck` and `npx vitest run tests/demo/cedar.test.ts --maxWorkers=1`. It uses isolated PGlite + production queue/records/proposal logic and static inventory checks, **not** the PM stack, real PG network/Vikunja or live providers. PM must execute the above native steps before claiming actual demo success. Expected unconfigured AI/TG/readiness503 and missing control status remain honest; do not describe the fixture as a live provider success.

Owner validation on this helper commit: **3/3 local tests PASS, strict TypeScript/build PASS, missing-argument CLI exits1 with static usage, committed diff check PASS.** No command was executed against the PM Compose project: no Docker/PG/Vikunja request, seed, credentials capture or private login artifact creation by Builder B. The only PM manifest access was read-only to learn its explicit paths/ports. Native demo execution/readbacks and recording remain PM-owned.
