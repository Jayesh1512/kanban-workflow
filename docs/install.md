# Local install — I1 checkpoint

This is shared infrastructure plus the approved synthetic foundation spine. Full hosted adapters, account host, MCP tools and web flows arrive in later checkpoints. These instructions do not claim final R27.1 fresh-checkout or complete-product acceptance; I4 supplies that evidence.

Use Node26+ and pnpm11.10.0. No inference server, model download, Ollama, GPU or paid call is required. From a fresh checkout:

```sh
export npm_config_ignore_scripts=true
pnpm install --frozen-lockfile
pnpm typecheck
pnpm check
pnpm test
```

The exported setting keeps dependency lifecycle scripts disabled, including mtcute's unused better-sqlite3 native build. Do not approve builds. The product uses node:sqlite and mtcute memory storage. Dependencies and notices: [parts and licences](parts-and-licences.md). Dependency acquisition uses registry.npmjs.org separately from offline product checks. Tests inject provider/connector boundaries and make no cloud calls.

Generate a32-byte key locally (`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`), export KANBAN_SECRET_KEY on the server and retain it securely. Do not commit it. `.env.example` documents variables; it is not loaded automatically. Choose KANBAN_DATA_DIR for the local database. To run the current admitted local spine server without an unbuilt hosted factory, set MODEL_PROVIDER=disabled and CONNECTORS=fixture, and set FIXTURE_PATH to a local recording. Future A1 adds explicit blocked status when OpenAI key/model are absent; currently its hosted factory remains exact not-built. Create the first teammate locally with `node src/cli.ts teammate:add alice`; provide display name at the prompt and retain the once-shown random initial password. There is no open signup. Then `pnpm start`, reachable at http://localhost:8787 by default. Later W1 supplies full teammate/settings forms.

Replay independently of server credentials with `node src/cli.ts replay recording.jsonl setup.json script.jsonl`. It uses the actual fixture/model/app factories, an empty in-memory store, explicit scripted source and optional sibling movement.jsonl (MOVEMENT_REPLAY_PATH overrides that source). No provider request is made. Counts are actual stored rows; threshold1 leaves proposals for explicit human acceptance. The setup specifies teammates/accounts/lanes/stages/included chats/settings. Complete E1-R acceptance is later E2/I4; twelve-message/default1 HTTP acceptance remains the active gate.

Before registering a Telegram API application: the person whose number registers it at my.telegram.org is the person Telegram notifies, and that person's remedy can end access for every teammate. Q7 account risk remains escalated and unaccepted; no real-account use is authorised here. C1 supplies the complete installed-source audit and connection/second-device procedure before any account is connected. Preserve the per-chat statement of agreement (`require_agreement=true`); Q8/defaults and real-user Q2–Q6 still require confirmation.

Before setting KANBAN_HOST beyond localhost: passwords and MCP credentials travel unencrypted unless a TLS proxy is placed in front. Configure an HTTPS KANBAN_ORIGIN with that proxy before exposure. No deploy is part of this checkpoint.

Server credentials are supplied later through OPENAI_API_KEY and configurable OPENAI_MODEL; no OpenAI model ID is selected. MODEL_PROVIDER=openai is the production default; disabled explicitly turns it off. Jev is separate: MOVEMENT_PROVIDER=jev, canonical JEV_ENDPOINT=https://api.typesafe.ai/v1/systemone, JEV_MODEL=jev-latest, and server JEV_API_KEY. Unset/disabled movement is unavailable, with no general-provider fallback. Keys never belong in chat, browser forms, fixtures, action/operational logs or source control. [Outbound](outbound.md) specifies context/destinations. SDK infrastructure is installed; hosted judgment/guards are A1-owned and not yet built.

Automatic actions start off at review_threshold1; require_agreement starts true. Future W1's settings form lowers the threshold. First inspect **review items accepted unchanged, changed and dismissed by kind SINCE INSTALL, both counts and shares**, in docs/measures.sql (I3 not built yet). For measured tuning use a separately labelled E1-M tuning set with the actual configured OpenAI/Jev models; it does not exist yet. Lowering without measurement accepts unmeasured model self-confidence/error risk. Threshold1 turns every proposal into human review and the board banner states that automatic actions are off. No model quality or threshold calibration has been measured.

Backup CLI/docs await I2 after withdrawal; measures CLI/SQL await I3 after stored edits. Final five-part build report/fresh-checkout proof await I4. R8/R9/full R10 re-evaluation/R22/R25/R28/R7.4/R17/R23 remain absent or exact not-built.
