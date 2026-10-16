# Local install

Use Node 26+ and pnpm 11.10.0. The app, database and Telegram connector run locally; OpenAI and Jev inference runs in the cloud. No local model or GPU is needed.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm check
pnpm test
```

Keep dependency lifecycle scripts disabled. The app uses `node:sqlite` and mtcute MemoryStorage, so mtcute's unused better-sqlite3 build is unnecessary. See [parts and licences](parts-and-licences.md). Tests use injected provider and connector transports and make no paid inference calls.

Copy `.env.example` to a private `.env` and restrict its permissions (`chmod 600 .env`). Generate a 32-byte sealing key locally:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Save that value as `KANBAN_SECRET_KEY`. Keep the key across restarts: changing it prevents the app from restoring sealed Telegram sessions. Set `KANBAN_DATA_DIR` to a persistent private directory. Do not commit the file, key or database. The app reads its process environment; `pnpm start` does not automatically load `.env`.

Create the first teammate, then start the server with the same configuration:

```sh
node --env-file=.env src/cli.ts teammate:add alice
node --env-file=.env src/main.ts
```

Provide the display name at the prompt and retain the once-shown initial password. Sign in at http://localhost:8787. There is no open signup. Before binding beyond localhost, use a TLS proxy and an HTTPS `KANBAN_ORIGIN`; passwords and MCP credentials otherwise travel unencrypted.

For Telegram, follow [Connect Telegram](connect-telegram.md). If personal application registration is unavailable, set `TELEGRAM_APPLICATION_PROFILE=tdl` and remove the three custom `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and `TELEGRAM_APP_OWNER` lines entirely, including empty values. Confirm the matching account notice in Settings, then complete phone/code/password login yourself and explicitly include the chats to process. Keep `require_agreement=true`. Inclusion imports permitted messages; it does not unconditionally create a card for every chat.

For general AI, set `MODEL_PROVIDER=openai`, `OPENAI_API_KEY` and `OPENAI_MODEL`. Choose a model that supports Responses strict structured output; the app has no fallback model. For movement recommendations, independently set `MOVEMENT_PROVIDER=jev` and `JEV_API_KEY`; `JEV_MODEL` defaults to `jev-latest` and the endpoint is fixed to `https://api.typesafe.ai/v1/systemone`. Restart after configuration changes. Each provider can be explicitly turned off with `disabled`. Missing required provider configuration leaves AI blocked while ingestion and human operations remain available. Settings shows provider readiness and safe failure information; readiness alone does not prove a successful live inference.

Keys stay in server configuration. Do not paste them into chat, browser forms, fixtures, logs or source control. The app does not reuse coding-agent credentials. [Outbound boundaries](outbound.md) describes exactly which message context goes to each service. Including a chat permits its bounded context to reach configured cloud providers; excluded chats must remain outside that processing scope.

New work-related message proposals appear in **Review** at the default `review_threshold=1`. Inspect the evidence, then accept, change or dismiss the proposal. Accepting a new-card proposal creates the card. Jev recommendations to move across lanes always require human review. Jev failure or uncertainty does not authorize an OpenAI movement fallback. Keep the default threshold while evaluating model behavior; no model quality, confidence calibration, latency or cost claim follows from offline tests.

For an offline replay, run `node src/cli.ts replay recording.jsonl setup.json script.jsonl`. It uses the actual fixture/model/app factories, an empty in-memory database and an explicit script; optional sibling `movement.jsonl` supplies movement replay (`MOVEMENT_REPLAY_PATH` overrides it). No cloud request is made. Threshold 1 still requires human acceptance. Replay evidence and tests do not establish live Telegram or provider success.

These instructions cover the delivered local workflow. Whole-product acceptance, measured model tuning and the remaining backup, metrics, edit/re-evaluation and wider workstreams retain their separate project gates.
