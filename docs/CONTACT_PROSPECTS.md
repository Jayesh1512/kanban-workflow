# Contact prospects and live analysis

An outbound business enquiry may be meaningful before the recipient's company is
known. These conversations now appear as contact prospects in **To be started**,
with a title such as “Harsh — company unknown”. Personal messages and uncertain
outreach do not qualify. A prospect is a ticket with `kind=contact_prospect` and
`companyId=null`; `context.company` is null. No placeholder company is inserted,
and the chat's company mapping remains unresolved or ambiguous.

Migration `202610170003_contact_prospects.sql` preserves existing company tickets,
adds the explicit ticket kind, and permits null company IDs only for contact
prospects. Company-linked tickets still require a real company FK. The unique
chat ticket and unique remote task invariants remain. Confirming a company updates
the same ticket/task, preserving its lane, stage version and manual actions. Source
correction, exclusion/reinclusion, evidence versions and stage approvals apply to
both kinds. An explicit non-company mapping cannot produce an active prospect.

Native decision rubric `openai.decisions.antseed.v2` adds an independent outbound
enquiry predicate; the Vercel compatibility rubric is `jev.antseed.v2`. A probability
of at least 0.9 and current cited nonforwarded messages from the bound account are
required to create a new contact prospect. A missing company is independent of the
business-enquiry classification. Native probabilities are preserved; no general
model substitution or company affiliation is fabricated. Existing v1 provenance
remains readable and valid historical data. Stage recommendations still create
pending proposals and never directly authorize movement.

The canonical replay operation accepts optional `includeCompletedUnmapped=true`
with one explicit `chatId` to reassess an older completed, unmapped chat that has no
ticket. The flag cannot run unscoped and cannot reset existing company/prospect
tickets. Source-policy/message fences and idempotency remain; saved current
extraction is reused, while stale extraction is recomputed. This operation can
make paid provider calls. HTTP and all existing MCP tools keep the same catalog;
there is no new approval or arbitrary-send tool.

The workflow runs one reserved live analysis slot for fresh outbound conversations
and their replies, plus one general slot. Live slots never take historical work
or consume the general queue's durable fifth-slot FIFO reservation. General and
live claims share immutable tokens and SQL ownership fencing. Projection, proposal
application and control delivery run separately from provider requests. Every
loop verifies the exact migration ledger before domain work. Shutdown aborts,
stops new scheduling and drains both analysis slots alongside transport/control
work before the database closes.

Validation includes source-backed creation with no company, uncertain/personal/
forwarded/foreign-source rejection, explicit scoped replay, company upgrade using
the same ID, policy/mapping corrections, held-history/live-slot separation and
full shutdown drainage. The opt-in real integration suite is:

```sh
PROSPECT_TEST_PROJECT=antseed-prospects-check-<run> \
PROSPECT_TEST_PG_PORT=<owned-loopback-port> \
PROSPECT_TEST_VIKUNJA_URL=http://127.0.0.1:<owned-loopback-port> \
npx vitest run --maxWorkers=1 tests/workflow/contact-prospects.live.test.ts
```

It requires an explicitly owned synthetic Compose project and generated test
credentials, captures them only in memory, and cleans its random schemas and
marked remote projects. Its actual PostgreSQL/Vikunja movement uses authored
inference plus an explicit synthetic operator approval; it is not real Telegram
or model-quality evidence. Personal deployment verification is recorded separately
in `DELIVERY_STATUS.md`.
