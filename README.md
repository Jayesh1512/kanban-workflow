# Kanban foundation

Local Node 26 / pnpm application. No build step. Install with `pnpm install --frozen-lockfile`. Gate: `pnpm typecheck`, `pnpm check`, `pnpm test`.

This foundation provides exact contracts and a bounded synthetic spine. Unbuilt features throw `AppError('invalid', 'not built: <name>')`. General cloud provider adapters and full movement guards are assigned to later streams. No real credentials or model calls are required for tests.

The active spine starts with an empty database and twelve synthetic messages at the default review threshold of 1. It creates a proposal, accepts it through a named teammate's HTTP session, checks the actual board HTML, and reads company contacts and roles through MCP. The recording and general script are in `test/fixtures/spine.ts`; replay movement stays in the initial lane. Separate support tests cover atomic rollback, authenticated session sealing, cancellation, restart and ingestion deduplication.

Offline replay uses the normal component assembly:

```sh
node src/cli.ts replay recording.jsonl setup.json script.jsonl
```

The setup contains `teammates`, `lanes`, `included` chats and `settings` as declared in the architecture. Replay uses an in-memory database and prints actual message, decision, card, review and contact counts. An optional sibling `movement.jsonl` supplies replay movement answers. The CLI does not accept reviews; at threshold 1 cards remain proposals until a teammate accepts them through the web route.

Foundation supports only the admitted happy path. Search, full guard and movement semantics, non-new-card review settlement, hosted provider adapters, catch-up, purge, backup and measurement remain not built.
