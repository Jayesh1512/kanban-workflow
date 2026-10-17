# Local operating handoff

This checkout has an ignored `.env` containing nonsecret project/port settings.
It selects the persistent `antseed-personal` Compose project, backend19280 and
Vikunja19281. Provider keys stay in the read-only external AI file; no key values
were copied into this `.env` or the repository.

From this directory, start or resume the personal stack with:

```sh
docker compose up
```

Use `docker compose up --build` to rebuild after source changes. The ordinary
portable defaults, without this local `.env`, are backend3000/Vikunja3456.

Open [personal setup](http://localhost:19280/) to enter Telegram phone/code/2FA.
Enter those only on the local page. This is a fresh personal dataset/session;
the synthetic recording and QA projects are separate. Discovery includes cloud
and archived chats by default; individual chats can be excluded. Configure an
existing operational control group or explicitly create one on the same page.
The application adds no custom permission/RBAC gate.

[Personal Vikunja](http://localhost:19281/) uses its generated service account.
See [private local UI access](../deploy/README.md#private-local-vikunja-ui-access)
for the user-run credential command. Do not expose its output in recordings.

The dedicated installed Hermes profile `antseed` connects to this personal
instance at `http://127.0.0.1:19280/mcp`. Configuration/discovery succeeded
without invoking a model; the original default config and `.env` were unchanged.
Launch it with:

```sh
hermes -p antseed chat -t antseed
```

Try asking for today's priorities or requesting a sourced lane-change proposal.
MCP exposes27tools. A proposal stays pending until an explicit operator/control
decision; Hermes has no direct approval or lane-move tool. The existing agent's
configured model is preserved. No messaging bot/gateway was restarted.

Local code/integration and final canonical deployment checks passed independently;
reports are linked in [delivery status](DELIVERY_STATUS.md). The
[narrated demo](../artifacts/demo/README.md) uses explicitly labelled synthetic
source/model inputs with actual backend/SQL/Vikunja/HTTP operation.

Telegram login and synchronization are now connected in the personal dataset;
full live control delivery awaits an operational group. OpenAI extraction has
reported timeouts. The selected decision layer is now native **gpt-6-luna** via
OpenAI's Decisions API using the existing private `OPENAI_API_KEY`. Set
`MOVEMENT_PROVIDER=openai`, `JEV_ENDPOINT=https://api.openai.com/v1/decisions`, and
`JEV_MODEL=gpt-6-luna` in the local Compose `.env`, then recreate only the backend.
Extraction remains on its separately configured OpenAI model. No OpenRouter key
is needed. The historical Vercel entitlement pause remains in history and does
not carry over to the deliberately changed decision endpoint/model.

Live native GPT-6 Luna synthetic request completed successfully in841ms; this is
transport/contract evidence, not a classification-quality benchmark. Proposals
still require explicit human approval and an operational control group remains
to be configured. Failed provider work and saved extraction remain replayable.

Personal services and data volumes are retained. The separate demonstration
project is `antseed-pm-demo-20261017` (19180/19181/19432), and QA projects retain
their own synthetic volumes. Do not point a real Telegram account at those
synthetic datasets or remove unrelated volumes. For the personal dataset, use
the same project settings for subsequent commands and back up its dependent
volumes together.
