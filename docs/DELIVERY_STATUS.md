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

- M0 architecture/contracts/foundation — Architecture Builder, running.
- M0-P verify mtcute/Vikunja deployment and actual APIs — Builder A, running; docs/PLATFORM_RESEARCH.md only.
- M0-I verify Jev/OpenAI/Hermes contracts — Builder B, running; docs/INTELLIGENCE_RESEARCH.md only. Start confirmed.
- M0-Q independent acceptance plan — QA, running; docs/QA_PLAN.md only.

## PM progression protocol

1. Read and verify each worker's reported commit and results. Integrate bounded handoffs onto main with cherry-pick; do not alter workers' checkouts. Record evidence and SHA here.
2. Architecture M0 is the implementation dependency. Review its schema/interfaces and test foundation; resolve material gaps with the architect. Send research findings to architecture as they arrive.
3. Once M0 is integrated, send both builders the exact main baseline SHA and agreed module ownership. They merge that baseline into their own branches, then build their assigned modules. Keep root package/composition ownership explicit; PM resolves integration changes.
4. Builder A owns M1 platform/Compose/Vikunja and M2 Telegram/persistence/operational transport. Builder B owns M3 extraction/Jev/company/contact/approval service and M4 HTTP/MCP/Hermes/priorities. They may progress in parallel where contracts permit and report bounded commits at each milestone.
5. QA reviews the architecture baseline, then merges integrated milestones from main and tests independently. QA creates tests/reproducers in its own branch, reports severity and exact evidence, and returns test commits for integration. Product fixes go back to owners; PM verifies before marking a milestone passed.
6. Run actual Docker builds and clean/repeated Compose bootstrap, persistent restart and MCP/API exercises. Synthetic providers prove workflow behavior only; separately record real AI/Vikunja probes and any untested Telegram login-dependent actions.
7. Deliver with exact start/login instructions, verified checks and remaining material limitations. Do not declare success while required implementation or reproducible QA failures remain.

## Milestone status

- M0: running; no architecture baseline delivered yet.
- M1: pending M0.
- M2: pending M0/M1 interfaces.
- M3: pending M0; provider research underway.
- M4: pending M0/M3 interfaces.
- M5: acceptance plan underway; integrated implementation not available yet.

## Evidence

- Initial requirements committed as `bf76f1b`.
- Docker Engine 29.4.0 responds on host; Node 26.4.0 and npm 11.17.0 available.
- AI configuration exists at the private path in PROJECT_BRIEF.md; keys were not printed or copied into the repository.
- User explicitly reaffirmed the supplied AI env file and mandated Vercel AI Gateway for Jev. Requirement sent to all four chats.
- Builder A reports live registry verification of vikunja/vikunja:2.7.0 for amd64/arm64 and identified caret dependencies beneath @mtcute/node 0.32.4; exact native/API probes remain underway.
