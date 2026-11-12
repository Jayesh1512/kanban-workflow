# Source contract: every source builds the same card

A source (Telegram, email, anything added later) only supplies raw material. The one shared
pipeline (`OutreachRepository.reconcileChat` and `prospectDisplayName`) builds the card, so a
source never sets card fields itself.

## A source must supply

| What | Rule |
|---|---|
| Chat row | One `chats` row per conversation, `kind` set, and an id that cannot collide with another source (email ids are negative and above 4×10^18). |
| `title` | The **counterparty**: the person or organisation on the other side, as a Telegram direct chat is named. Never a subject line, an id or the word "email". Our own side ("Antseed") may appear; the pipeline strips it. |
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

`counterpartyTitle` picks the first participant who is not the mailbox, by name, else address, and
falls back to the subject without `Re:`/`Fwd:`. The subject is kept in `email_threads.subject`
and shown beside the title on the intake prompt and Approvals tab. Threads pushed before this
rule keep their subject as the title.
