# Hourly reply agent

The reply agent reads Telegram groups for the connected account and tells the
operator when a message needs a reply. It drafts the reply. It never sends to the
source group.

This feature is independent of CRM intake, proposals, approvals and the board. It
uses the Telegram port and PostgreSQL only.

## What one run does

1. It runs every `REPLY_AGENT_INTERVAL_MS` (default one hour).
2. It selects up to `REPLY_AGENT_MAX_CHATS` groups, newest activity first.
3. For each group it reads the newest 60-100 messages from Telegram.
4. It builds the context from two sets:
   - the last `REPLY_AGENT_CONTEXT_MESSAGES` messages (default 15), and
   - all messages in the last `REPLY_AGENT_WINDOW_MINUTES` (default 60).
5. It marks fresh messages:
   - first run: incoming messages in the last hour,
   - later runs: incoming messages above the stored cursor.
6. It sends the context and fresh IDs to OpenAI.
7. If the answer is relevant, it stores one draft in `reply_suggestions`.
8. It sends one combined digest for the run to Saved Messages.

Own messages never trigger a draft. Direct messages and channels are not scanned.
After a restart, the worker waits for the remaining time in the interval. It does
not scan twice.

## Relevance rule

Relevant: a direct question, a mention, a decision the owner must make, a request
for owner-only information, a commitment or deadline aimed at the owner, or a
thread that is blocked without the owner.

Not relevant: announcements, forwards, small talk between others, links without a
request, spam, and threads that can continue without the owner.

The model returns `relevant=false` with an empty draft when it is unsure. It must
not invent facts, prices, dates or commitments. Message text is treated as
untrusted data, never instructions.

## Storage

`reply_scans` keeps one cursor row per group:

- `last_scanned_message_id`: highest message ID already considered,
- `last_scanned_at` and `last_run_at`,
- `last_error`.

`reply_suggestions` keeps the draft:

- the triggering incoming message ID,
- the first and last context message IDs and the message count,
- `addressed_to`, `urgency` and the relevance reason,
- `suggested_text`,
- delivery state (`delivered_at`, `delivery_message_id`, `delivery_error`).

The unique key `(chat_id, trigger_message_id)` makes repeated runs idempotent.

## HTTP

All routes need the normal workspace session. In native mode they also need CRM
management permission.

- `GET /api/reply/suggestions?limit=50&before=<ISO time>` lists drafts, newest first.
- `GET /api/reply/status` shows the last result and the effective settings.
- `POST /api/reply/scan` runs one scan now and returns the counts. The `web` role
  answers 403 because it does not own the Telegram worker.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPLY_AGENT_ENABLED` | `true` | Turns the hourly worker on or off |
| `REPLY_AGENT_INTERVAL_MS` | `3600000` | Time between scans |
| `REPLY_AGENT_MAX_CHATS` | `25` | Groups checked per scan |
| `REPLY_AGENT_CONTEXT_MESSAGES` | `15` | Last messages added to the context |
| `REPLY_AGENT_WINDOW_MINUTES` | `60` | Time window added to the context |
| `REPLY_AGENT_OWNER_NAMES` | `Ravi,Ravikant` | Names the model treats as the owner |
| `REPLY_AGENT_DIGEST_CHAT` | `self` | `self` = Saved Messages, `off` = no send, or a chat ID |

The model and API key come from the existing extraction settings:
`OPENAI_MODEL` and `OPENAI_API_KEY`.

## Failure behavior

- A transport or provider error keeps the cursor and stores `last_error`. The next run retries.
- A rejected or unparseable model answer stores `last_error` and moves the cursor past those messages, so the agent does not loop on the same input.
- A per-group Telegram error is recorded and does not stop other groups.
- A digest failure is recorded per suggestion. The suggestions stay readable in
  the API.
- The agent waits for the `reply_scans` table before it runs. It does not block
  the web listener.
- Only the primary process runs the worker. `APP_ROLE=web` reports ready and
  skips the schedule.

## Bounds

- One Telegram history call per group per run, at most 100 messages.
- At most 80 messages in the model context.
- Each message text is cut to 1000 characters.
- One digest message per run, at most 4000 characters.
- One in-flight scan. A manual scan joins the running scan.
- A run that finds more than 100 new messages in a group reads the newest 100
  and advances the cursor. Older unseen messages in that group are not recovered.
