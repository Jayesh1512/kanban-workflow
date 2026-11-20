# HTTP and Hermes MCP transports

`createWorkflowModule(platform.services)` registers these transports before any workers start. Both use the existing workflow repositories and the same platform ChatService; transport files contain no SQL, provider clients, scheduler or lane mutation logic.

The canonical catalog is `src/shared/api.ts`: 44 domain HTTP operations and 38 MCP tools. Platform owns all six `/api/chats` HTTP bindings. Workflow owns the other 38 and exposes all 38 tools at `/mcp`, including the six chat tools. Six HTTP-only operations have no MCP tool: proposal decisions, email-report imports, mode changes, and operator card creation. Stage recommendations create pending proposals; no MCP approval, direct move, arbitrary Telegram send or login tool exists.

`/mcp` uses the pinned official MCP SDK Streamable HTTP server, stateless JSON responses. POST handles initialize, notifications, tools/list and tools/call; GET/DELETE return 405 with `Allow: POST`. Each request gets its own SDK server/transport. Supported protocol negotiation and malformed-envelope errors come from the SDK. Tool failures return `isError: true` and the canonical error object in text and structured content. Successful text content is the same JSON value HTTP returns; arrays are wrapped as `{items: value}` in structured content because MCP requires an object there.

All inputs are strict objects. Path IDs, decimal query limits, UUIDs, enums, optimistic versions and shared evidence/date schemas are validated before domain dispatch. HTTP mapping source is `http`; MCP source is `mcp`; proposal origin is respectively `manual`/`hermes`. Explicit contradictory provenance is rejected. Company/contact input validation mirrors the owning repository's private input schemas. Domain services retain durable idempotency, evidence fencing, manual precedence and optimistic conflict behavior. Mutation idempotency keys are JSON fields. `ensure_ticket` is a legacy operation and rejects creation in CRM-first mode. Use `propose_crm_work` with a concrete action, approved source chat and current CRM evidence revision; the ticket is created only after a reply to its matching Telegram approval message. CRM and Work data edits also return pending proposals, and decisions are Telegram-only in this mode.

Business calls require the exact checksum-validated migration ledger. Initialize/tool discovery and onboarding/status remain reachable while initialization is pending or drifted. Domain errors use the shared HTTP status/error mapping; unexpected errors have a fixed sanitized message. No app authentication or permission layer is added.

Workflow augments the existing successful GET `/api/status` response in a `preSerialization` hook. It preserves platform fields and components, replacing extraction/Jev entries with status from its own existing provider instances and adding workflow state. Reading status does not start a worker, load credentials again or call a provider. Missing tables/database failure produce sanitized component states. Shutdown rejects new service calls, closes active MCP transports and awaits in-flight domain calls before platform DB cleanup; the one workflow scheduler and control subscriber remain owned by the workflow module.

An installed Hermes profile can connect with:

```yaml
mcp_servers:
  antseed:
    url: http://127.0.0.1:3000/mcp
    enabled: true
    timeout: 20
```

Use the installed `hermes -p <isolated-project-profile> mcp test antseed` to check discovery. Restrict an agent demo to `-t antseed` and a small turn/time budget. Never replace the user's unrelated servers or profile. `replay_analysis` is explicitly documented as recovery that can permit future paid provider calls; discovery/read operations do not clear the Jev pause.

## Scoped connections with personal keys

`src/hermes/scoped.ts` adds two more stateless MCP endpoints on the same server (both roles, including `APP_ROLE=web`). They accept only personal keys (`Authorization: Bearer ask_…`), created on **Connections → MCP connections**. Keys are random 32-byte values; only their SHA-256 hash, prefix, owner, level and last use (written at most once a minute) are stored in `mcp_keys`. Each request rechecks revocation, the member's enabled flag and current role.

- `/mcp/crm`: `search_deals`, `get_deal`, `follow_ups_due`, `pipeline_summary`, plus `move_deal`, `edit_deal` and `add_note` for non-viewers. At level `propose` (every member's default) changes become pending proposals in Approvals/Telegram (`details` is the proposal kind for notes/workstream). At level `full` with an admin or CRM-manager role they save directly through the audited web code. Viewers are read-only.
- `/mcp/tasks`: pinned to the `WORKSPACE_ADMIN_EMAIL` member. `list_tasks`, `get_task`, `due_today_overdue`; level `full` adds `create_task`, `update_task`, `complete_task`, `delete_task` and `update_work_ticket`. Only an admin creates Tasks keys (`full` for Hermes, `read` to share).
- `/mcp` (admin catalog) still accepts an admin's Supabase token and also `admin` keys. A non-admin requests one (or full CRM level for an existing key) on Connections. The admin is emailed Approve/Deny links to `/mcp-approval` (signed-in admin, same-origin POST, single-use token, 48h expiry); requests also appear in Approvals. Email uses Resend when `RESEND_API_KEY` is set (`MCP_EMAIL_FROM` optional); otherwise the request is kept and shown as "email not configured".

Every MCP mutation writes `workspace_audit` with the key's member as actor and `source: mcp`.

```yaml
mcp_servers:
  antseed-crm:
    url: https://<app>/mcp/crm
    headers:
      Authorization: "Bearer ask_…"
    enabled: true
    timeout: 20
```
