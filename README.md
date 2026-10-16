<img src="assets/icon.svg" width="64" height="64" alt="">

# AntSeed Kanban

Created in [T3 Code](https://t3.codes).

A personal relationship board backed by Telegram MTProto, Vikunja, PostgreSQL,
OpenAI extraction and Vercel Jev classification. Nous Hermes accesses the same
backend through MCP. Lane recommendations remain pending until an operator
approves them.

Start the complete stack from this directory:

```sh
docker compose up
```

Open [setup and status](http://localhost:3000/) and
[Vikunja](http://localhost:3456/). Compose mounts the configured AI environment
file read-only and generates persistent service credentials automatically.
Complete Telegram phone/code/2FA onboarding on the setup page; the application
uses its own persisted session. See [deployment and onboarding](deploy/README.md)
for port/configuration overrides, board access and volume persistence.

The MCP endpoint is `http://localhost:3000/mcp`. See
[Hermes configuration and tool behavior](src/hermes/README.md).

For local development:

```sh
npm ci
npm run check
npm start
```

`/health/live` reports process health; `/api/status` describes connections,
workflow and providers; `/health/ready` stays503 while required components are
unavailable. The recorded Vercel Jev credit restriction currently pauses Jev work
durably; successful live Jev inference and authenticated Telegram acceptance
remain unverified. M4 independent review and final acceptance/video are pending.
See [delivery evidence](docs/DELIVERY_STATUS.md),
[architecture](docs/ARCHITECTURE.md) and [project brief](docs/PROJECT_BRIEF.md).
