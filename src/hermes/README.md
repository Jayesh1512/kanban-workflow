# HTTP and Hermes MCP transports

`createWorkflowModule(platform.services)` registers these transports before any workers start. Both use the existing workflow repositories and the same platform ChatService; transport files contain no SQL, provider clients, scheduler or lane mutation logic.

The canonical catalog is `src/shared/api.ts`: 28 domain HTTP operations and 27 MCP tools. Platform owns all six `/api/chats` HTTP bindings. Workflow owns the other 22 and exposes all 27 tools at `/mcp`, including the six chat tools. HTTP-only proposal decisions have no MCP tool. Stage recommendations create pending proposals; no MCP approval, direct move, arbitrary Telegram send or login tool exists.

`/mcp` uses the pinned official MCP SDK Streamable HTTP server, stateless JSON responses. POST handles initialize, notifications, tools/list and tools/call; GET/DELETE return 405 with `Allow: POST`. Each request gets its own SDK server/transport. Supported protocol negotiation and malformed-envelope errors come from the SDK. Tool failures return `isError: true` and the canonical error object in text and structured content. Successful text content is the same JSON value HTTP returns; arrays are wrapped as `{items: value}` in structured content because MCP requires an object there.

All inputs are strict objects. Path IDs, decimal query limits, UUIDs, enums, optimistic versions and shared evidence/date schemas are validated before domain dispatch. HTTP mapping source is `http`; MCP source is `mcp`; proposal origin is respectively `manual`/`hermes`. Explicit contradictory provenance is rejected. Company/contact input validation mirrors the owning repository's private input schemas. Domain services retain durable idempotency, evidence fencing, manual precedence and optimistic conflict behavior. Mutation idempotency keys are JSON fields. `ensure_ticket` uses the existing natural unique company-chat key; it has no invented idempotency-header contract.

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
