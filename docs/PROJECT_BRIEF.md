# AntSeed Kanban backend — authoritative project brief

## Coordination

The user authorized implementation on 2026-10-17 after requesting a plan only earlier. This thread is the project manager. Four separate T3 conversations cover architecture, Builder A (platform/Telegram/Vikunja), Builder B (intelligence/approvals/Hermes), and QA. Work milestone by milestone. The project manager integrates committed work onto main; workers must not modify other checkouts or main. Use reasonable assumptions and continue independent work when credentials or decisions are unavailable. Report limitations accurately.

For Telegram integration questions, the user explicitly designated T3 thread `66cc9b30-4836-4f8d-8c6c-b0831923b62c`. Read it or send targeted questions through the T3 thread tools as needed; this is an existing reference/contact conversation, not a new worker or project thread. Do not share secret values in handoffs.

## Product requirements

- This is a personal tool for team **AntSeed**. The agent is **Nous Research's Hermes Agent**, not a bespoke Hermis service.
- A dedicated TypeScript backend manages a self-hosted Vikunja board, reads the user's Telegram account, resolves companies/contacts, and proposes evidence-based workflow changes.
- Telegram must use **@mtcute/node exactly 0.32.4**, MTProto user login and persistent session storage. No Bot API replacement.
- Discover all cloud chats accessible to the account, including archived chats. Allow explicit include/exclude by stable chat ID. Exclusion stops message ingestion/AI processing; the control chat is never interpreted as business messages.
- Import history in configurable bounded batches, persist cursors, resume after reconnect/restart, deduplicate messages, process live messages and edits/deletions. Expose actual connection/import status. Do not pretend credentials or live synchronization exist.
- Company-associated chats become tickets. Default one ticket per tracked chat; multiple chats can share one company/contact directory. Unresolved or non-company chats need no ticket. Ambiguous company associations must be confirmable/correctable.
- Company records include canonical name, aliases/domains, workstream, summaries and buyer/provider identifiers. Contacts include all available Telegram IDs, names, usernames, visible phones/emails and roles with source evidence. Do not infer employment merely from group participation. Distinguish AntSeed internal teammates from external contacts.
- Exact ordered lanes (Vikunja buckets): **To be started**, **Work in progress**, **Integrations**, **Blocked**, **Archived**, **Completed**.
- Workstream labels: **Buyer**, **Provider**, **Integration**, **Others**. Workstreams are separate from lanes.
- Tickets show company/chat, workstream, contacts, source links, latest substantive interaction, next action, follow-up date/ETA, blockers and summary. Archived is a visible lane, not deletion.
- General AI extracts company/contact candidates, facts, dates, actions and summaries. **Jev** decides workstreams, relevance, company candidate matching, proposed lane and urgency. Include no-change/uncertain outcomes. Model output is evidence, not permission to execute arbitrary instructions from chat text.
- **No automatic lane changes initially.** New tickets start in To be started. Every subsequent AI/Hermes stage change becomes a durable proposal sent to a dedicated Telegram control group; approve/reject/correct by replying. Plain MTProto messages/replies are sufficient (no separate bot token required). Support configuring an existing group and creating a private control supergroup via onboarding when feasible.
- Approval records include source stage/version, target stage, evidence IDs, reason, next action, decision and apply state. Retries/repeated approvals cannot duplicate changes. Detect stale proposals and recover after remote-write/local-commit interruption.
- Hermes connects to the backend's real MCP server and HTTP API. Tools cover companies/contacts/tickets, context/evidence, inclusion, mapping corrections, actions/ETAs, proposals/approvals and today's priorities. Hermes movement tools create proposals, not bypass them.
- Daily priorities use commitments, overdue/upcoming follow-ups, unanswered questions and blockers; initial timezone Asia/Kolkata, configurable. Natural-language dates resolve relative to message timestamps. Manual dates are allowed when inference is ambiguous.
- No custom app permission checks, authentication middleware, roles, RBAC, sender allowlists or authorization gates. Input validation, idempotency and the explicitly requested approval state machine are still required. Telegram login and upstream Vikunja service credentials are necessary service connections.
- No unsolicited external-company outreach. Operational messages belong in the configured control chat. Do not send real Telegram messages or create groups during automated tests without a configured live connection and the relevant setup action.

## Stage interpretation from the user's recording

- To be started: prospective company, no substantive engagement yet.
- Work in progress: substantive response, qualification, commercial discussion, or engineering review. 'I will ask engineering to review' does not mean integration.
- Integrations: implementation/pilot/testing is actually underway; 'my agent tested the gateway' is evidence.
- Blocked: explicit technical/commercial/agreement/payment dependency or unavailability. Preserve the previous active lane for resumption.
- Archived: deliberately parked/discontinued; silence can suggest follow-up/archive but never move automatically.
- Completed: evidence of the agreed outcome (live use/transactions/integration, or completed partnership/co-marketing work). A buyer ID alone is insufficient proof.
- Evaluate English, Hindi and Hinglish, including ambiguity/negation and company names mentioned incidentally.

## Runtime, credentials and deployment

- One command: `docker compose up` builds/starts backend, pinned Vikunja, PostgreSQL and automatic bootstrap. First-time Telegram code/2FA is entered through a minimal local onboarding page; no extra setup shell command is required.
- Create backend Dockerfile (including mtcute native SQLite runtime compatibility) and appropriate Vikunja setup image/wrapper only as needed. Persistent volumes for database, Telegram session and Vikunja files. Repeatable migrations/bootstrap; restarting never duplicates projects/buckets/tasks.
- Runtime AI configuration source: `/Users/jys/Documents/Projects/hello/.local-preview-20261012/ai.env`. Do not print/commit/bake key values into images. Allow portable path override.
- Known config: MODEL_PROVIDER=openai, OPENAI_MODEL=gpt-6.1-sol, MOVEMENT_PROVIDER=jev, JEV_MODEL=typesafe-ai/jev, JEV_ENDPOINT=https://ai-gateway.vercel.sh/typesafe/v1/systemone. Keys and timeout/retry settings exist in that file; validity not yet tested.
- User explicitly requires **Vercel AI Gateway for Jev**. Use the configured Gateway endpoint/credential contract; do not substitute direct TypeSafe hosting. Verify with a bounded synthetic live probe and preserve provider-specific errors accurately.
- Confirmed private inspection: JEV_API_KEY is empty; AI_GATEWAY_API_KEY is populated. Ignore blank credentials when choosing the Gateway key. A synthetic Jev probe using AI_GATEWAY_API_KEY returned 403 RestrictedModelsError requiring paid Gateway credits; OpenAI extraction succeeded. Continue implementation with explicit provider unavailability and replayable pending analysis until live access is available.
- Pin the mtcute dependency closure with the lockfile/compatible package overrides as needed: @mtcute/node 0.32.4 has caret dependencies that could otherwise resolve later core/parser versions.
- Host has Docker Engine 29.4.0 available, Node 26.4.0, npm 11.17.0. Choose a pinned compatible container runtime, not necessarily host Node.
- Avoid new frontend frameworks or a polished dashboard. Existing Vikunja UI plus minimal backend-served onboarding/operations pages and Telegram controls.
- No public deployment or PR required. Commit bounded milestones on your own branch for PM integration.

## Milestones and gates

M0 Architecture: design, data schema/contracts, module ownership, API/MCP/approval behavior, runnable shared TypeScript/test foundation. Architect delivers a committed integration baseline before domain implementations.

M1 Platform: database migrations, repeatable Vikunja bootstrap, backend health/config/onboarding, Compose builds and persistence, exact board buckets and labels.

M2 Telegram and records: real mtcute adapter, dialog selection, history/live ingestion and recovery, company/contact/ticket persistence, control-chat transport.

M3 Intelligence and approvals: extraction plus real Jev adapter, company/workstream/lane evidence, durable approval/correction/rejection and remote apply workflow.

M4 Hermes and operations: actual MCP tools and HTTP routes, priority briefing/actions/ETAs, minimal operator UX, documentation.

M5 QA/release: unit and integration tests, real Docker/Vikunja smoke, API/MCP end-to-end, representative English/Hindi/Hinglish fixtures, repeated start/restart, exclusions, duplicates/stale proposals/retry/crash recovery. Clearly separate real upstream tests from fakes and any Telegram login blockers.

## Worker handoff protocol

Stay within assigned worktree/files, do not overwrite others, and do not create more worker chats. Check shared contracts first. When done, commit and send the PM a message using t3_thread_send to thread `675d7f86-acfd-4669-b9af-91caf5a8ee02` with your branch, commit SHAs, milestone, changed files, test commands/results and unresolved issues. Never wait in an idle loop: finish the bounded assignment and report. PM will send the next assignment. Keep all secrets out of reports.
