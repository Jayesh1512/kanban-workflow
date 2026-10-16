# Partnerships workflow

The workflow is opt-in. An active teammate explicitly calls `configureWorkflow(ctx)` (the web setup form does this through a guarded POST). It creates one Enterprise & partnerships lane and preserves existing lanes, cards, archive state and global `review_threshold=1`. Repeated setup returns the same workflow. It never resets or seeds user data. Workstream is a ticket field: Buyer, Provider, Integration, or Others, including internal tasks.

Create known leads before outreach with `createWorkflowTicket`. Optional metadata defaults to Others and null. An included chat can be linked at creation; inclusion alone does not create a deal. Unlinked substantive work can produce a grouped lead review. Later evidence joins the ticket or suggestion rather than creating one card per message.

Stages:

- To be started: seeded leads and outreach alone.
- Work in progress: substantive interest, active discussion or engineering assessment.
- Integrations: actual test/integration commands run, rather than plans to test.
- Blocked: explicit blocker, reason and next action or follow-up.
- Completed: confirmed integrated/live usage as a message or user assertion. Buyer ID is a reference, never proof of a transaction or externally verified usage.
- Archive: the existing archived card state, changed only by an explicit operator/scoped command. Restore requires an explicit destination.

Sending outreach does not prove engagement. Silence can warrant a follow-up, never automatic archive, loss, blocking or regression to an earlier stage. Manual stage overrides require further operator action; field overrides remain locked. Writes require the current ticket version and stale writes fail with conflict without mutation. Changes through older card APIs also invalidate workflow versions. Cross-existing-lane movement retains human approval.

Stage order changes presentation only. Every default creation path, including native import, MCP and review acceptance, uses the configured To be started identity. Configured stage identities, names and criteria stay intact when editing their order; unrelated generic lanes retain their normal stage controls. Pending proposal joins and accepted proposal results resolve their actual offered identity before workflow classification. Acceptance can apply a proposed stage only with retained Jev authority and current native review evidence; failed or unsupported judgments remain grouped reviewable leads starting in To be started.

Setup enables a separate workflow automation threshold of 0.85. Confidence and every selected support answer must be **strictly greater**. Jev uses the existing configured Vercel System One route and bounded `choice` questions for stage, workstream, action, date and buyer-reference candidates, plus independent support for each offered target. General OpenAI extraction supplies titles/summaries and existing contact extraction; it cannot supply fallback stage/workstream/action judgment. Invalid/failed/missing-evidence results create actual reviews. Message direction prevents outgoing outreach from establishing customer engagement. Paid Vercel access remains an external prerequisite; synthetic tests do not establish live model access or quality.

Follow-up timestamps are ISO8601 and normalize to UTC. Priorities group overdue, due today, blocked and upcoming active tickets using Asia/Kolkata. Completed and archived tickets are excluded. Dates are follow-up dates, not promised completion ETAs. ISO dates and weekdays in messages are offered as candidates; Jev must identify actual follow-up intent and cite that message. Relative weekdays resolve from the message timestamp in the workflow timezone, never the process clock. A date without a time uses start of that local day; ambiguous dates require review. No scheduler, Telegram message send or automatic reminder has been added.

Generated fields store their complete producing-input message/chat support, including inherited metadata context and unknown support. Native withdrawal cancels inference, clears affected generated metadata and placement, removes copied history, and keeps protected human values on surviving cards. Text-scoped readers can inspect quoted blocker evidence; readers without message scope receive a blocker notice and no copied workflow history.

The optional existing authenticated `/mcp` endpoint retains `get_company` and adds `get_board`, `list_tickets`, `get_ticket`, `get_daily_priorities`, `create_ticket`, `update_ticket`, `move_ticket`. Existing credentials remain read-only; new `scopeWrite` defaults false, and every write checks live scope, revocation and active issuer. Credential actions are attributed to that credential. Retained SDK tests use synthetic credentials and the official MCP client with modern protocol negotiation. External Hermis connection and setup are deferred by user instruction; no external client readiness is claimed.

Run the ordinary repository gates, then the focused changed-owner suites:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm check
pnpm test
node --test src/board/workflow.test.ts src/mcp/workflow.test.ts test/workflow-pipeline.test.ts
```

Tests use synthetic included-chat fixtures and injected production protocol transports. They exercise actual database mutations, reviews, MCP SDK calls, cancellation and physical withdrawal. They make no real provider or Telegram-account requests.
