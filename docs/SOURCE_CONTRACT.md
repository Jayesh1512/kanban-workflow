# Source contract: every source builds the same card

A source (Telegram, email, anything added later) only supplies raw material. The one shared
pipeline (`OutreachRepository.reconcileChat` and `prospectDisplayName`) builds the card, so a
source never sets card fields itself.

## A source must supply

| What | Rule |
|---|---|
| Chat row | One `chats` row per conversation, `kind` set, and an id that cannot collide with another source (email ids are negative and above 4×10^18). |
| `title` | The **counterparty**: the company on the other side, else the person, else their address. Never a subject line, an id or the word "email". Our own side ("Antseed") may appear; the pipeline strips it. |
| Messages | Rows in `messages` with a stable `sender_id` per person. Email maps each address to a stable pseudo id (`emailUserId`); our own mail uses the connected account's id so it counts as outbound. |
| Approval | The normal `chat_intake_requests` approval, before any content is analysed. |

## The pipeline then derives, for every source alike

Card name, workstream, Buyer or Provider marker, summary, next step, company link and contact
roles come from the analysis and the existing card function. Do not set them from a source.

Existing data is never rewritten: a card that has been placed or edited (`identity_version > 0`)
keeps its name, summary and workstream, whatever a source's title later becomes.

## Adding a source

1. Create the chat, messages and approval as above.
2. Add one sample to `sources` in `tests/platform/source-contract.test.ts`.
3. That test then checks the new source produces the same card shape, name rule and next step.

## Email specifics

`counterpartyTitle` names the thread after the counterparty's **company**, then the person, then the address:

1. A directory company (`companies.domains`) that owns the counterparty's domain, spelled as the directory has it. Two owners is ambiguous and is skipped.
2. Else the name read off the counterparty's own business domain (`riya@mail.chatprd.ai` → `chatprd`), using the subject's casing when the subject spells it (`ChatPRD`), otherwise capitalised.
3. Else the person's name, else their address. Our own domain and free-mail domains (gmail, outlook, ...) never name a company.
4. If the mailbox is the only participant, the subject without `Re:`/`Fwd:`.

The subject is kept in `email_threads.subject` and shown beside the title on the intake prompt and
Approvals tab. Threads pushed before this rule keep their subject as the title. Once analysis runs,
the confirmed company replaces a prospect's name through the usual company link.
