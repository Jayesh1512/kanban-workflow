# Email ingestion (Hermes → MCP)

Hermes reads a mailbox and pushes threads to the existing `/mcp` endpoint with `ingest_email_thread` (HTTP: `POST /api/email/threads`). No mailbox credentials live in this app.

```json
{ "mailbox": "me@antseed.com", "threadKey": "<gmail thread id>", "subject": "Cedar integration",
  "messages": [{ "messageKey": "<gmail message id>", "from": { "email": "riya@cedar.com", "name": "Riya Shah" },
    "to": [{ "email": "me@antseed.com" }], "cc": [], "sentAt": "2026-11-01T09:00:00+05:30", "body": "…", "sourceUrl": "https://mail.google.com/…" }] }
```

## How it reaches the system

1. A thread becomes a chat (`kind='email'`, negative ID outside Telegram's range). It starts `undecided`; its messages are held in `email_messages.pending`, not in `messages`.
2. The normal intake request goes to the Telegram control group (“Add this email thread to AntSeed CRM?”) and appears on the Approvals tab → Intake. The prompt carries the subject only, never the body.
3. **approve** → held messages are written to `messages` and analysis is queued, exactly as for an approved Telegram chat. From there everything is the existing flow: extraction, company/contact directory, CRM relationship, stage and Work proposals, each needing its own Telegram/Approvals-tab approval.
4. **reject** → held content is dropped; later pushes for that thread are discarded.

Pushing again is safe: a repeated `messageKey` is a no-op; new messages on an approved thread go straight to analysis. `threadKey` is namespaced by `mailbox`.

## Identity

Each sender address maps to a stable pseudo user ID (`emailUserId`, ≥ 2^60, clear of Telegram IDs), so the same address is one contact across threads and shows its email in the Directory. Messages `from` the `mailbox` itself use the connected Telegram account's ID: our outbound mail counts as outbound, and the owner appears on the AntSeed team page.

## Limits

- Needs the Telegram account bound and a control group: approvals are Telegram-first.
- Intake sends at most one new prompt per 30 s and five unanswered at a time, so push only the mail you want considered (e.g. a Gmail label).
- A person on both Telegram and email is two contacts until merged by hand.
- CRM sources for email still carry the internal kind `telegram` (chat-backed); only the chat kind says `email`.
