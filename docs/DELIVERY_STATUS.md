# AntSeed delivery coordination

This is the project-manager checkout. The user explicitly authorized architecture, implementation and QA in separate T3 conversations. Continue autonomously through the milestones in PROJECT_BRIEF.md; credential-dependent work must not block independently testable work. Do not introduce extra workers.

## Team

- Project manager: `675d7f86-acfd-4669-b9af-91caf5a8ee02`, main checkout `/Users/jys/.t3/projects/kanban`, branch `main`.
- Architecture Builder: `mcp:c651aaa3-8edd-4561-8b4b-2cb7e1aebef3`, branch `antseed/architecture`.
- Builder A — Platform & Telegram: `mcp:b09bccca-9a2a-45ad-8ac4-b2539566c557`, branch `antseed/builder-platform`.
- Builder B — Intelligence & Hermes: `mcp:b8112e15-d80a-4a32-97bb-c3e32184de07`, branch `antseed/builder-intelligence`.
- QA — Integration & Acceptance: `mcp:82337154-d4c0-4457-a433-cd2d6f210695`, branch `antseed/qa`.

These are ordinary top-level T3 chats requested by the user, not delegate_task children. Continue them using t3_thread_send (stable clientRequestId for each assignment), inspect with t3_thread_read, and retain all IDs. Each worker reports completed commits back to the PM using t3_thread_send, which wakes the PM. Do not duplicate work or launch monitors.

## Current assignments

- M0 architecture/contracts/foundation — baseline `25d66b8` integrated as `9b9b823`; PM clean install/check PASS (strict TypeScript, 14 tests, production build) and native SQLite open/read/close PASS. Independent QA in progress. Architect assigned a small additive correction so sender/peer snapshots are typed in analysis/context messages and discovery defaults to included.
- M0-P verify mtcute/Vikunja deployment and actual APIs — complete and integrated from `0a11825`; docs/PLATFORM_RESEARCH.md. M0-P2 draft review complete; no product edits. M1/M2 pending corrected baseline.
- M0-I verify Jev/OpenAI/Hermes contracts — complete and integrated from `25b3170`; docs/INTELLIGENCE_RESEARCH.md. M0-I2 draft review complete; no product edits. M3/M4 pending corrected baseline.
- M0-Q independent acceptance plan — complete and integrated from `156e14d`; docs/QA_PLAN.md defines 35 acceptance scenarios and M0–M5 gates.
- M0-Q2 independent multilingual conversation corpus — complete and integrated from `7155e1c`; 35 cases / 38 source revisions. PM independently reran the embedded validator successfully (18 English, 9 Hindi, 8 Hinglish) and diff whitespace check. Fixture validation is not a product/live test.
- M0-Q3 additional critical draft-contract review — complete, no edits/commit. QA found forwarding provenance missing from normalized/persisted message and analysis context; PM accepted and assigned a forwarded/source-kind marker plus nullable origin information and a distinguishing contract example. Executable M0 review follows committed baseline.
- M0-Q4 independent executable baseline review — QA running on integrated `9b9b823`; clean install/check14/native SQL checks pass so far; snapshot-bearing analysis input correction pending.
- M1 implementation — Builder A running on `9b9b823` contracts: configuration, PostgreSQL migrations, real Vikunja adapter/bootstrap, Docker/Compose, truthful setup/status; M2 Telegram implementation follows.
- M3.1 implementation — Builder B running on `9b9b823` contracts: records/contact/facts/ticket persistence, real OpenAI/Vercel Jev adapters and durable analysis/checkpoints/replay. M3.2 proposal/apply and M4 HTTP/MCP follow bounded handoff.

## PM progression protocol

1. Read and verify each worker's reported commit and results. Integrate bounded handoffs onto main with cherry-pick; do not alter workers' checkouts. Record evidence and SHA here.
2. Architecture M0 is the implementation dependency. Review its schema/interfaces and test foundation; resolve material gaps with the architect. Send research findings to architecture as they arrive.
3. Once M0 is integrated, send both builders the exact main baseline SHA and agreed module ownership. They merge that baseline into their own branches, then build their assigned modules. Keep root package/composition ownership explicit; PM resolves integration changes.
4. Builder A owns M1 platform/Compose/Vikunja and M2 Telegram/persistence/operational transport. Builder B owns M3 extraction/Jev/company/contact/approval service and M4 HTTP/MCP/Hermes/priorities. They may progress in parallel where contracts permit and report bounded commits at each milestone.
5. QA reviews the architecture baseline, then merges integrated milestones from main and tests independently. QA creates tests/reproducers in its own branch, reports severity and exact evidence, and returns test commits for integration. Product fixes go back to owners; PM verifies before marking a milestone passed.
6. Run actual Docker builds and clean/repeated Compose bootstrap, persistent restart and MCP/API exercises. Synthetic providers prove workflow behavior only; separately record real AI/Vikunja probes and any untested Telegram login-dependent actions.
7. Deliver with exact start/login instructions, verified checks and remaining material limitations. Do not declare success while required implementation or reproducible QA failures remain.

## Milestone status

- M0: baseline integrated and PM executable checks pass; independent QA final review and additive snapshot correction pending.
- M1: implementation running on committed M0.
- M2: pending M1 handoff; interfaces committed.
- M3: M3.1 implementation running in parallel with M1; real Jev success externally blocked by Gateway credits.
- M4: pending M3 interfaces/implementation handoff.
- M5: acceptance plan/corpus integrated; independent M0 QA running, product acceptance awaits implementation.

## M0 review disposition

PM sent architecture a bounded consolidated fix list before contract freeze: explicit single-account Telegram dataset binding; separate durable live/history checkpoints, ownership/CAS and pre-message delete tombstones; sender/peer snapshots; subscriber-before-catchUp and nonblocking/degraded onboarding lifecycle with complete cleanup; durable idempotent control setup/reconciliation; verified Vikunja bootstrap/view semantics; HTTP-only operator decisions excluded from Hermes MCP catalog; durable extraction checkpoint before Jev; structured extracted company attributes; action/question actors/resolution and date-only granularity; contact role read/create consistency; separate typed provider/question diagnostics; mapping correction reason/evidence audit. These are shared-contract/schema refinements, not an instruction to implement domain modules in M0. QA must review the corrected committed baseline.

## Evidence

- Initial requirements committed as `bf76f1b`.
- Docker Engine 29.4.0 responds on host; Node 26.4.0 and npm 11.17.0 available.
- AI configuration exists at the private path in PROJECT_BRIEF.md; keys were not printed or copied into the repository.
- User explicitly reaffirmed the supplied AI env file and mandated Vercel AI Gateway for Jev. Requirement sent to all four chats.
- Builder A reports live registry verification of vikunja/vikunja:2.7.0 for amd64/arm64 and identified caret dependencies beneath @mtcute/node 0.32.4; exact native/API probes remain underway.
- Builder B reports a successful synthetic OpenAI gpt-6.1-sol strict-schema Responses API request (HTTP 200), but Vercel Gateway Jev returned HTTP 403 `no_providers_available` / `RestrictedModelsError`, saying paid Gateway credits are required; no provider call was attempted. A final private configured-credential selection check is assigned. No direct TypeSafe fallback is authorized. Implementation/QA continue independently, preserving queued analysis and exposing provider unavailability honestly.
- Credential selection check complete: JEV_API_KEY is empty; AI_GATEWAY_API_KEY is populated and was correctly used. No alternate nonempty key or second entitlement request. Ensure configuration ignores blank values. Live Jev success is externally blocked by the Gateway credit restriction; it is not a code permission check.
- Both research documents reviewed by PM and integrated. Platform research includes actual Vikunja CLI/API reconciliation/task/label/readback and ARM64 native SQLite persistence probes; PostgreSQL Compose/restarts and live Telegram still unverified. Intelligence research confirms local Nous Hermes v0.21.3 availability; actual MCP/Hermes end-to-end remains pending implementation.
