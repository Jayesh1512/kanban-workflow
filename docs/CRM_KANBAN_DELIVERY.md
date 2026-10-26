# Outreach integration delivery

Status: **implemented, deployed to the personal stack, and running against Supabase.**

The design remains in [CRM_KANBAN_INTEGRATION_PLAN.md](CRM_KANBAN_INTEGRATION_PLAN.md). The operating and recovery contract is in [CRM_OPERATIONS.md](CRM_OPERATIONS.md).

## Delivered behavior

- The original six-lane work board remains independent from a dedicated **AntSeed Outreach** Vikunja project.
- The commercial project has exactly five ordered stages: Lead / Prospect, Qualification, Negotiation, Deal Won, Archived. No sales stage marks the Vikunja task done.
- Telegram conversations reconcile into stable company relationships or contact prospects. A prospect keeps its relationship ID when its first confirmed company is learned. Equal names alone do not merge companies.
- Source enrollment, sales-stage proposals, decisions, accepted state, publication state and observed native state are separate and durable.
- One historical initial placement is permitted only by the stored 5 October Telegram policy. Email reports cannot inherit that permission. New groups at the stored boundary and every later sales-stage change require approval.
- The configured OpenAI Decisions `gpt-6-luna` rubric recommends one of the five sales stages or abstains. Low-confidence, malformed, stale and unavailable results remain held. It does not reuse operational work lanes as sales evidence.
- Telegram control messages route intake, work and commercial receipts to one owner. A commercial approval cannot move the work board, and an operational approval cannot change the sales board.
- Native publication uses per-resource request journals, immutable receipts, session locks and readback. Unknown outcomes quarantine only the affected card. Human native-stage drift requires an explicit reviewed restore/adopt decision.
- Cards use `Company / person — next AntSeed action` titles and structured contacts, actions, deadlines and source-evidence sections. Manual action and identity corrections retain audit/version history.
- Structured email reports preview and commit as attributed, pending report context. They are never presented as authenticated original mailbox messages.
- HTTP and the official Streamable HTTP MCP server share the same services. MCP discovery contains 36 tools, including nine commercial read/propose/update operations. Approval, direct movement, login, sending and raw-file import are not exposed through MCP.

## Live rollout — 26 October 2026

- The personal backend image with both additive CRM migrations was deployed without replacing its Telegram/runtime volumes or restarting Vikunja.
- A fresh consistent pre-rollout dump contains both the `antseed` and `vikunja` Supabase schemas. A private restore upgraded the ledger from six to eight migrations while preserving prior checksums and the work-board binding.
- Production reconciliation created 54 retained commercial relationships from the current Telegram read model plus the committed seven-thread, user-supplied email report.
- The separate native sales binding is ready at `http://localhost:19281/projects/3/12`; the work board remains at `http://localhost:19281/projects/2/8`.
- The first current Telegram relationship completed the real `gpt-6-luna` classification, historical-policy decision and native publication path. SQL accepted stage and native bucket both read back as Lead / Prospect; the task is not done and contains the structured card sections and managed marker.
- The imported email stages remain provisional/pending enrollment until reviewed. No email was sent and no mailbox was queried during rollout.
- The live aggregate status reported database, Vikunja, Telegram, sync, automatic intake, control, extraction, decisions and Outreach ready; the Telegram account remained bound.
- The original work project ID/view ID, all six bucket bindings and the persisted Telegram automatic/group-approval policy match the pre-rollout snapshot.
- Vikunja's applied `20260617153629` migration record existed but its expected unique `task_positions(task_id, project_view_id)` index was missing after the earlier Supabase move. With zero duplicate pairs verified, the exact v2.7 index was restored under a database lock. Native task creation and full CRM publication then passed.
- The Outreach dashboard fetches ten records per page. This keeps large Supabase reads bounded while preserving cursor pagination and CSV export.

## Verification

- Final bounded suite: **598 passed, 168 explicit opt-in/live skipped** across 58 passing test files; strict TypeScript and the production build passed.
- Targeted CRM acceptance passed across repository, workflow, HTTP, official MCP SDK, real PostgreSQL 17.11, real Vikunja 2.7.0 and controlled Telegram transport.
- Real native tests cover all five buckets, neutral done semantics, accepted-response/lost-response recovery, unrelated-card fairness, drift conflicts, detail preservation and typed control routing.
- The release image passed a network-isolated compiled-file/migration hash check against the verified host build.
- The configured credential byte scan found no credential values in changed source, tests, docs, deployment files or Compose configuration.
- Desktop and mobile browser review exercised report preview/commit, source detail, sales proposal approval and automation mode against an isolated synthetic stack with an empty console.
- Live official MCP SDK discovery returned 36 tools and `get_sales_status` succeeded without a model invocation.

## Current operating boundary

The CRM is live, but it does not guess stages in bulk. Historical Telegram relationships are processed in bounded turns; confident qualifying initial placements publish automatically under the stored policy. Uncertain cases and imported email context stay in review. New-group initial placement and every later sales-stage movement notify the configured Telegram control group and require the matching approval.

Rollback is forward-compatible: set CRM mode to `paused` and keep the eight-file migration manifest. Do not run an older six-migration image against the extended ledger and do not remove the live database, runtime or Telegram-session volumes.
