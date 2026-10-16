# Withdraw an included chat

Open Settings → Your connected accounts → Choose chats. For an included chat,
expand **Withdraw chat and delete imported data**, read the explanation, check
its explicit confirmation, and submit. The server requires a signed-in account
owner, the exact configured Origin, the included chat, and `confirm=withdraw`.
GET, missing confirmation, bearer credentials, MCP, and other owners cannot
perform this action. Repeating a completed withdrawal does not erase anything
else or add another withdrawal event.

Withdrawal stops the shared chat through every connected account. It removes
imported app messages and their versions, sightings, pending replies, request
and gap state, search entries, and derived copies. **Telegram messages are not
deleted.** Agreement and withdrawal history retain actor, time, and identifiers.
Reinclusion requires the account owner to explicitly select Include chat again.
No participant-agreement statement or checkbox is required, and inclusion does
not create a participant confirmation record. Other account owners see who
withdrew the shared chat and when.

Cards with remaining messages keep their lane and stage. Generated text on a
dependent or unknown-source card, including cards linked only to other chats,
becomes `(title removed)` with an empty summary. The same
next actual pipeline attachment supplies fresh title and summary; a manual text
edit also clears the refill flag. Withdrawal starts no inference. Human card
text and retained human contact/company values survive. Graph retention keeps
companies with remaining evidence or references and deletes eligible sole-chat
companies and aliases.

The confirmation beside the button explicitly discloses **app-wide cleanup across
other chats**: saved agent decisions, movement audits, reviews, pending mentions,
generated action history and human explanations for moves and reviews are lost.
Generated card titles/summaries and contact roles are cleared wherever they used
the withdrawn chat or their source is unknown. This applies even without a direct
message attachment or citation. Current human-written card text, contact roles
and company values remain protected. The checkbox confirms this broader cleanup.

Before deleting decision/review provenance, the coordinator discovers current
outputs. The current spine stores host-written, content-free input/context IDs
and actual output-write log IDs in its existing private decision JSON. It carries
transitive generated-input context and marks missing legacy context as unknown;
attachments and role citations never establish complete input coverage. Board
clears discovered generated text with `needs_text`; Graph resets discovered agent
roles, including outside this chat. Complete genuinely unrelated output support
is retained as content-free provenance, while raw model/reason payloads disappear.
Company retention follows the existing explicit Graph rules.

The current pipeline has incomplete durable context provenance for legacy raw
decisions, movement audits, pending mentions, and mixed/settled reviews. A
nonempty withdrawal therefore clears those opaque copies conservatively across
chats. It keeps decision identity/version/outcome and processed-version fences.
Action history clears affected selectors, correction descendants, all agent
payloads and unscoped movement/review feedback (including human explanations).
Unrelated human non-movement history and current human fields remain. Empty-chat
withdrawal still runs the authorized global log cleanup. This does not implement
or certify the separately planned full Agent or new feedback schemas/producers.

The synchronous coordinator validates authority before mutation and uses one
`Db.tx` (`BEGIN IMMEDIATE`). Its first SQL enables deferred foreign keys, then it
calls Host → Agent → Board → Graph → Log → message deletion → one content-free
`chat.withdraw` audit. Real callback, log and deferred-FK failures roll everything
back. Registered Agent dependency aborts are delivered after the actual outer
commit or verified rollback; late success/rejection cannot restore copies.

Success is returned only after a post-commit WAL TRUNCATE checkpoint reports
`busy=0`. An external reader can prevent truncation after the logical withdrawal
has committed. In that case the server explicitly reports **Withdrawal committed;
database cleanup is waiting for an active reader** and does not report success.
Retire that reader and run `PRAGMA wal_checkpoint(TRUNCATE)` on the same database;
do not treat another withdrawal request as a cleanup retry. The synthetic tests
exercise this boundary. Raw DB/WAL/SHM scans establish removal of planted bytes
from those files, not erasure of backups, filesystem snapshots, storage hardware,
remote provider data or Telegram.

## Synthetic verification

Run the ordered gates documented in the verification record. Focused suites:

```sh
node --test 'src/purge/**/*.test.ts'
node --test src/agent/forget.test.ts src/log/withdrawal-erasure.test.ts src/web/withdrawal.test.ts
```

All fixtures are synthetic and invoke the real application and callbacks.
Physical tests plant distinct copies before erasure and scan DB/WAL/SHM plus FTS
after full callback success and truncation. Faults at every owner/log/FK boundary
restore complete logical rows, pending/origin/provenance data and usable fresh
Host scheduling. Held general and movement calls cover commit/reinclusion and
rollback with both late outcomes. The accounts UI is also checked through actual
HTTP session/Origin/owner/confirmation validation.

The developer handoff supplies an outside-repository `preview.ts` executable for
parent browser verification on `http://localhost:8788`. It uses the actual App,
fixture connector, disabled model, private temporary database, and synthetic
`alice`/`bob` login (`synthetic-password`), with shared cards and two included
chats. The parent starts and retires it; no developer preview server is left
running and no real Telegram connection is used. Check desktop/mobile confirmation,
search `SYNTHETICERASE` before/after, retained `SYNTHETICRETAIN` results and Board
state. Stop with Ctrl-C to close all handles and remove the synthetic database.
