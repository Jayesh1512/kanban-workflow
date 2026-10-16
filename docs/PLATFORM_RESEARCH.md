# Platform research — M0-P

Verified on 2026-10-17 (Asia/Kolkata), Builder A, branch `antseed/builder-platform`.
This is an implementation note, not an architecture contract. No domain code,
package configuration, migrations or composition changed. The architect/PM's
committed baseline remains the prerequisite for M1/M2.

## Findings that affect the baseline

- `@mtcute/node@0.32.4` exists. Its core and parser dependency ranges are
  `^0.32.4`; npm's latest node package is already `0.32.5`. Lock/override node,
  core, HTML parser and Markdown parser to `0.32.4`. Do not force packages such
  as wasm or TL runtime to a nonexistent matching patch: resolve their published
  compatible versions into the lockfile.
- `vikunja/vikunja:2.7.0` **actually exists**, was pulled and reports
  `Vikunja api version v2.7.0`. Docker Hub also exposes `2.7`, `2` and `latest`
  at the same digest at verification time; use the full patch tag plus digest.
- Vikunja 2.7.0 has both v1 and v2 APIs. Prefer v2 consistently: create with
  `POST`, replace with `PUT`, and read list results from `items`. Mixing these
  with v1's `PUT` create / `POST` update or bare arrays will break bootstrap.
- Kanban buckets belong to a **project view**. A created project already has
  default views and a manual Kanban view with To-Do, Doing and Done buckets.
  Reconcile those into the required six lanes; do not blindly append six more.
- mtcute excludes archived dialogs and disables missed-update catch-up by
  default. Explicitly use `archived: 'keep'` and `updates: {catchUp: true}`.
- Node `22.23.3` on Debian Bookworm slim passed a real ARM64 native install,
  SQLite read/write and mtcute prepare/destroy probe, including reopening in
  an entirely network-disabled container. No Telegram login or RPC was made.

## Verified artifacts and runtime

Registry observations are time-specific; the following digests are the actual
multi-platform index digests, not guessed version strings:

```text
vikunja/vikunja:2.7.0@sha256:e2204a1c1c6a81e833c2b3a5442be182ca2335b54c2e7e37578cc3fe12a27cfc
node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
```

Vikunja's index has Linux amd64, arm64, arm/v6 and arm/v7 images. The arm64
manifest is `sha256:bc3ba3be7049a01d8c576d82e7e7dc2a027125ecabe6bf7e5b3e105981f9ff75`;
amd64 is `sha256:3c4b1d34d99256f7cad14b4508e97d80de53e1f5859745c3c176d10c62c73fbf`.
The image label identifies revision `a16be96aa454671fdf213b0fbe411dd38a098418`.
Docker Hub's prior available stable patch tags include `2.6.0`, `2.5.0`,
`2.4.0`, `2.3.0` and `2.2.2`; no fallback is necessary for 2.7.0 availability.

The npm node 0.32.4 tarball has gitHead
`cef2ee57200e94e8f0383c7b07c3ac00dd5d75c7` and integrity:

```text
sha512-3rDa3r35kdeHCDNm2XNO6riTHYq0Y3fqtDwSEM5PTqZUHsQ0uUgnN7APknjeCcfEOBSCskhUchItkbDxUPMHyQ==
```

Its native dependency range is `better-sqlite3: ^12.10.0`. Exact 12.10.0 lists
Node `20.x || 22.x || 23.x || 24.x || 25.x || 26.x`. The actual probe used
Node `v22.23.3`, ABI `127`, Linux `arm64`, better-sqlite3 `12.10.0`, SQLite
`3.53.1`. Installation needed no compiler in this environment (prebuilt binary
available). Both ESM and CJS exports exist; the probe exercised ESM. AMD64
native execution and Alpine/musl were **not** tested.

Recommended container approach: same pinned Debian/Node base in build and run
stages; run `npm ci` against the agreed lockfile inside Linux. Never copy host
macOS/Node 26 `node_modules` into the image. If native compilation is needed,
install Python, make and a C++ compiler in the build stage, with compatible
runtime libraries in the final image. Avoid assuming Alpine compatibility.
The host's Docker client is 29.6.1; Engine is 29.4.0 on Linux ARM64.

## Exact mtcute 0.32.4 API

These signatures were inspected in the **published 0.32.4 node/core tarballs**,
not inferred from the current online reference version. Methods below are
called on `TelegramClient`; the underlying standalone exports also take an
`ITelegramClient` first argument.

### Client, session and onboarding

```ts
import {TelegramClient, RpcError} from '@mtcute/node';

const tg = new TelegramClient({
  apiId, apiHash,
  storage: '/data/telegram/client.session',
  updates: {catchUp: true},
});
```

`apiId` is a number and `apiHash` a string. A string `storage` selects
`SqliteStorage`; the default is the relative file `client.session`.
`SqliteStorageDriver` uses better-sqlite3 and enables WAL unless `disableWal`
is supplied. Mount the **whole directory** so the database, `-wal` and `-shm`
files share persistence. Keep one active client owner for the session.
Application records/cursors belong in PostgreSQL, separately from this library
session/peer/update-state database.

- `prepare(): Promise<void>` initializes without connecting; this is what the
  offline probe called. `connect()` and RPC methods actually connect.
- `getMe(): Promise<User>` checks an existing authorization. On successful
  session resume, `notifyLoggedIn(me.raw)` restores the client's logged-in
  state; `start()` does this internally. Then start the update loop explicitly
  after handlers are attached.
- `sendCode({phone, futureAuthTokens?, codeSettings?, abortSignal?})` returns
  `SentCode | User`. `SentCode` has `phoneCodeHash`, `type`, `nextType`,
  `timeout`, `length` and optional `beginning`. Do not assume SMS delivery;
  Telegram app, email and other delivery modes are possible.
- `signIn({phone, phoneCodeHash, phoneCode, abortSignal?}): Promise<User>`.
  Handle `RpcError.is(error, 'SESSION_PASSWORD_NEEDED')` by asking for 2FA.
- `checkPassword(password)` or `checkPassword({password, abortSignal?})`
  completes 2FA. Login methods notify the client of authorization internally.
  `resendCode({phone, phoneCodeHash, ...})` is available; respect the advertised
  timeout rather than immediately resending.
- `start({phone, code, password, invalidCodeCallback, codeSentCallback,
  abortSignal, ...})` supports values or asynchronous callbacks. In the Node
  wrapper, omitted callbacks fall back to **terminal readline**. A web service
  should use explicit login steps or provide all callbacks; a bare `start()`
  must not hang waiting on container stdin.
- Keep pending code hash/phone associated with one login attempt; do not log
  codes or passwords. A lost in-memory attempt can safely require a new login
  attempt. Display invalid/expired code, password, revoked session and flood
  wait errors accurately; distinguish unavailable credentials from connection
  failures. Do not silently create a new Telegram account.
- `exportSession()` / `importSession(session, force?)` exist but are unnecessary
  for directory-backed persistence. Session strings grant account access.
  Graceful shutdown must call `destroy()` to stop timers/connections and close
  storage; do not call `logOut()` on a normal service restart.

### Dialogs, history, identities and source links

```ts
for await (const dialog of tg.iterDialogs({
  archived: 'keep', pinned: 'include', chunkSize: 100,
})) {
  // dialog.peer.id is the marked, stable chat identifier.
}

const page = await tg.getHistory(chatId, {
  limit: batchSize, offset: savedOffset, // offset = {id: number, date: number}
});
// page is an array with .total and .next, not {messages: [...]}.
```

`iterDialogs()` defaults to infinite total limit and chunks of 100. It supports
`offsetDate`, `offsetId`, `offsetPeer`, `limit`, `folder`, `filter`, and archived
`keep | exclude | only`. A title or username is mutable and unsuitable as the
selection key. Store marked IDs losslessly (decimal strings at application
boundaries are convenient); validate conversion before passing a JS number to
mtcute. Access hashes are not the stable identifier: preserve the library's
peer cache/session. Discovery finds account-accessible cloud dialogs, not
secret-chat history or every historical chat the account ever left.

`getHistory(chatId, {limit=100, offset?, addOffset?, minId?, maxId?, reverse?})`
returns `ArrayPaginated<Message, {id, date}>`. `.next` comes from the last
returned message and uses **raw seconds**, while `Message.date` is a JS `Date`.
Use the returned cursor, not an invented numeric offset. Commit ingested rows
and the cursor together; a replay after a crash must deduplicate. For bounded
jobs prefer explicit pages; `iterHistory` defaults to **Infinity**, supports
`chunkSize`, and wraps these same pages. Reverse traversal changes cursor
semantics; always supply a known offset for forward catch-up rather than
depending on undocumented default behavior. Cap requested chunks at 100 unless
a later Telegram-specific test establishes a larger safe limit.

Message getters include `id`, `chat`, `sender`, `text`, `date`, `editDate`,
`isOutgoing`, `replyToMessage`, `entities` and `media`. Keep service messages
and empty text distinct from substantive business text. Users expose `id`,
`firstName`, `lastName`, `username`, `usernames` and visible `phoneNumber`;
there is no generic guaranteed email field or employment relationship.
Participation alone is not employment evidence.

`message.link` generates a public `https://t.me/<username>/<id>` or private
supergroup/channel `https://t.me/c/<unmarked-channel-id>/<id>` URL. The getter
**throws** for unsupported peer types such as ordinary private chats. Store a
nullable source link with stable chat/message IDs; do not fabricate public
links to private DMs or assume a link gives its reader access.

### Live updates and recovery

```ts
tg.onNewMessage.add(onMessage);
tg.onEditMessage.add(onEdit);
tg.onDeleteMessage.add(onDelete);
tg.onConnectionState.add(onConnectionState);
tg.onError.add(onError);
await tg.startUpdatesLoop(); // after successful login/session resume
```

Remove handlers with `.remove(theSameFunction)` when disposing. These are
`@fuman/utils` emitters, not Node `.on('event', ...)`. **Emission is synchronous
and does not await async listeners.** Catch rejected persistence work and use
an application queue; registering an async handler does not make Telegram's
update-state advancement atomic with a PostgreSQL commit.

Connection states are `offline | connecting | updating | connected`; offline
is emitted for the platform network callback, not a comprehensive service
status. Catch-up runs in the background, so returning from `startUpdatesLoop`
does not prove synchronization complete. Expose auth, network, import cursor,
queued work and recent successful ingestion separately.

`updates.catchUp` defaults to **false**. With true, the library restores its
PTS/QTS/SEQ/date and channel state from storage and downloads missed updates.
Unclean close can replay duplicates. `updates.onChannelTooLong(channelId,
update)` is available when a channel difference cannot be efficiently restored;
schedule bounded application reconciliation. Do not inflate `channelPtsLimit`
beyond ordinary-user ranges to pretend all gaps are covered.

`DeleteMessageUpdate.messageIds` is `number[]`; `.channelId` is a marked channel
ID **or null**. For a channel, scope tombstones by that chat and message ID.
For null, resolve through the account's local **non-channel common-mailbox**
index; never delete matching IDs across all channels. Unresolved delete IDs
need an explicit unresolved/reconciliation path. `getMessagesUnsafe(ids)` is
for PM/legacy-group messages; `getMessages(chatId, ids)` handles scoped lookup.
Re-fetching known messages can discover missing/deleted records, but one absent
history page is not proof that every older message was deleted.

Application recommendations: register listeners before starting catch-up;
deduplicate by account/chat/message and content/edit revision; serialize work
per chat; apply include/exclude and control-chat routing before business
ingestion, then recheck policy before queued AI work. Reconnect should replay
from the application high-water mark with overlap, update recent edits, and
resume unfinished history pages. mtcute catch-up plus bounded reconciliation
does not establish lossless recovery of **all arbitrarily old** edits/deletes
after an unlimited outage. Report remaining reconciliation work honestly.

### Control group and outbox transport

- Existing group: resolve via `getChat(chatId)` / `resolvePeer(chatId)` and
  persist the marked ID. Do not use its title as the routing key.
- Creation API exists: `createSupergroup({title, description?, forum?,
  ttlPeriod?}): Promise<Chat>`. Its implementation calls
  `channels.createChannel` with `megagroup: true`, no username assignment.
  Use `forum: false` for a plain private control supergroup. Only invoke from
  the explicit onboarding action; account restrictions/flood limits can fail.
  There is no creation idempotency key in this helper. Journal attempts and
  reconcile uncertain outcomes before offering a retry that could duplicate a
  group. Configuring an existing group remains a supported path.
- `sendText(controlChatId, text, {replyTo?, mustReply?, randomId?,
  disableWebPreview?: true})` returns `Message`. `replyTo` takes a message ID
  or `Message`; `randomId` takes a `long` **Long**, not a JS number/string.
  The implementation forwards it to `messages.sendMessage.random_id`.
- Persist one random ID before a durable control-message attempt and reuse it
  on retries. Save returned message ID with proposal/outbox state. Include a
  stable proposal marker in text so uncertain-send recovery can reconcile
  replies/history; do not promise indefinite remote exactly-once delivery.
- Incoming decisions correlate `(controlChatId, message.replyToMessage?.id)`
  to the proposal message. Preserve `isOutgoing` messages: the same user
  account can approve from another Telegram client. Our own operational sends
  need explicit receipt recording; send methods normally suppress dispatch of
  their own returned messages unless `shouldDispatch: true` is requested.
- Plain text/replies require no Bot API token or bot keyboard. Separate parsing
  and durable proposal decision/apply handling from transport. No sender
  allowlist or new authorization layer is introduced.

## Vikunja 2.7.0 bootstrap and adapter

### Stock image and account setup

The pulled image's entrypoint is `/app/vikunja/vikunja`, working directory
`/app/vikunja`, UID `1000`; it is based on **scratch**, with no shell/curl/wget.
Default SQLite location is `/db/vikunja.db`. A first disposable launch failed:

```text
Could not init file handler: failed to create file storage directory at /app/vikunja/files: mkdir /app/vikunja/files: permission denied
```

Provide a UID-1000-writable files volume from first boot. PostgreSQL mode uses
`VIKUNJA_DATABASE_TYPE=postgres`, `..._HOST`, `..._USER`, `..._PASSWORD`,
`..._DATABASE`; keep its database/user separate from backend-owned tables.
Also configure `VIKUNJA_SERVICE_PUBLICURL` to the URL the user opens, and persist
the service secret. The exact source uses `service.secret`, exposed as
`VIKUNJA_SERVICE_SECRET`; `service.jwtsecret` is a deprecated compatibility
alias. Without an explicit stable value the source generates one at startup.
The binary migrates the database on startup. Check the actual `/health`,
`/api/v2/health` or `/api/v1/info` response from another container for readiness;
a scratch-image healthcheck must not invoke a nonexistent shell.

No default account exists. The actual CLI works with public registration
disabled (`VIKUNJA_SERVICE_ENABLEREGISTRATION=false`):

```sh
/app/vikunja/vikunja user list --email "$BOOTSTRAP_EMAIL"
/app/vikunja/vikunja user create --username "$BOOTSTRAP_USERNAME" \
  --email "$BOOTSTRAP_EMAIL" --password "$BOOTSTRAP_PASSWORD"
```

Pass required flags to avoid interactive input. `user list` emits a human table,
not JSON; it has an exact email filter and no username/JSON flag in this image.
Duplicate username creation exits **1**, so blindly rerunning create is not
repeatable bootstrap. An image wrapper/one-shot setup can call the binary
before serving and create only when the configured identity is absent; after
creation/known-existing state, the backend must confirm login. Do not swallow
every CLI failure as “already exists”. A wrapper needs a shell-capable base
or its own compiled launcher; the stock image cannot execute `sh -c`.
Alternatively, a setup executable can directly exec the stock binary; keep the
architecture's process ownership explicit. Do not require the user to run a
manual shell bootstrap after `docker compose up`.

`POST /api/v2/login` with `{username, password}` returned HTTP 200 and a `token`;
use `Authorization: Bearer <token>` for upstream service credentials. The short
lived access JWT requires refresh/re-login handling; do not cache it forever.
`POST /api/v2/register` returned 404 while registration was disabled.
`POST /api/v2/tokens` also worked with `{title, permissions, expires_at}` and
returns the clear token only on creation. `GET /api/v2/routes` returns capability
groups such as `projects`, `projects_views`, `tasks`, `tasks_labels`, `labels`;
permission keys still use legacy names, e.g. `views_buckets_tasks`, even when
calling v2. Discover them instead of inventing names from HTTP verbs. A real
created API token successfully read buckets, moved a task and read it back.
The final choice of persistent token versus login/refresh is left to M1.

### Exact v2 paths verified against the image

All following paths are relative to `/api/v2`. Writes return a single object;
lists use `{items, total, page, per_page, total_pages}` (and may include
`$schema`). Paginate project/task/label searches with `page` and `per_page`;
do not assume the first page contains all records.

```text
GET    /projects
POST   /projects                                      {title, description?, ...}
GET    /projects/{p}/views
POST   /projects/{p}/views                             {title, view_kind:"kanban", bucket_configuration_mode:"manual", ...}
GET    /projects/{p}/views/{v}
PUT    /projects/{p}/views/{v}                          full merged view
GET    /projects/{p}/views/{v}/buckets
POST   /projects/{p}/views/{v}/buckets                  {title, position, limit:0}
PUT    /projects/{p}/views/{v}/buckets/{b}              merged {title, position, limit, ...}
DELETE /projects/{p}/views/{v}/buckets/{b}
POST   /projects/{p}/tasks                             {title, description?, ...}
GET    /projects/{p}/tasks
GET    /tasks/{t}
PUT    /projects/{p}/views/{v}/buckets/{b}/tasks        {task_id:t}
GET    /labels
POST   /labels                                        {title, hex_color?, ...}
GET    /tasks/{t}/labels
POST   /tasks/{t}/labels                               {label_id:id}
```

Project/view creation alternatives and bucket deletion were source/OpenAPI
verified; the probe reused the automatically created view and renamed buckets,
so it did not need those additional write operations. The source and live
OpenAPI also provide `PATCH /tasks/{t}` and view PATCH for partial changes;
bucket PATCH does **not** exist because buckets have no read-one route.
For full replacement, GET/list then merge; omitted zero fields can otherwise
clear filters, position, limits or default/done configuration.

v1 remains available under `/api/v1`, but creates use PUT and updates POST;
bucket move is **POST** at the same nested suffix. v1 buckets GET returned a
bare array in the probe. Do not copy v1 examples into a v2 adapter.

### Repeatable board reconciliation

1. Serialize bootstrap using the agreed PostgreSQL lock/journal. Resolve the
   managed project by persisted remote ID; recover an uncertain creation via a
   unique managed marker, not a loose title search across unrelated projects.
2. Read/reuse its manual Kanban view. Source creates default List/Gantt/Table/
   Kanban views and To-Do/Doing/Done buckets. On the newly managed board rename
   these to To be started / Work in progress / Completed, preserving IDs.
   Create missing Integrations, Blocked and Archived buckets.
3. Set ascending positions `100, 200, 300, 400, 500, 600` for exactly:
   **To be started**, **Work in progress**, **Integrations**, **Blocked**,
   **Archived**, **Completed**. Persist the title-to-ID mapping per view.
   Unexpected/duplicate populated buckets require reconciliation, not deletion
   on every restart. Deleting a bucket can relocate its tasks to the default.
4. After buckets exist, merge-update the view with `default_bucket_id` set to
   To be started and `done_bucket_id` to Completed. The source clears supplied
   bucket IDs during view creation because the view has no owned buckets yet.
5. Ensure labels **Buyer**, **Provider**, **Integration**, **Others** and keep
   label IDs distinct from bucket IDs. `Integration` label is singular;
   `Integrations` lane is plural. Attach via `/tasks/{t}/labels`.
6. New tickets use the default To be started lane. Archived is a bucket, not
   `project.is_archived` and not task deletion. Real moves into Completed set
   `task.done=true`; moves out clear it. A default view filter excluding done
   tasks could hide Completed: explicitly inspect/configure the managed view's
   filter so the completed lane remains visible (probe used `filter: null`).
7. For task creates persist an external operation marker and reconcile
   uncertain responses before retrying. No generic Idempotency-Key handler was
   found in the relevant pinned routes/models. Bucket moves are idempotent in
   the source and repeated identical move requests passed readback. Check remote
   current state/version and the durable mutation journal before committing an
   approved proposal locally after a timeout/crash; do not issue a fresh create.

## Probe evidence and limits

Only public registry/docs/source reads and isolated synthetic containers were
used. Temporary files were under `/tmp/antseed-m0p-research`; containers were
named/labeled `antseed-m0p-*` / `antseed.probe=m0p`, with no existing service
volumes, credentials or networks mounted. No Telegram code was sent, login
attempted, history fetched, group created or message sent. No AI secrets were
read as part of this research.

Verification commands/results:

- `npm view @mtcute/node@0.32.4 --json`; `npm view better-sqlite3@12.10.0 engines
  --json`; `npm pack @mtcute/node@0.32.4 @mtcute/core@0.32.4` — exact published
  metadata/tarballs inspected. `npm ls ... --all` showed node/core/parsers
  deduplicated at 0.32.4 and better-sqlite3 at 12.10.0.
- `gh api repos/go-vikunja/vikunja/releases/latest` and release source archive;
  Docker Hub tags API; `docker buildx imagetools inspect` for both pinned images;
  `docker pull vikunja/vikunja:2.7.0`; `docker run --rm --network none
  vikunja/vikunja:2.7.0 version` — available version/digests verified.
- Disposable Node container: exact-package install, `new Database(...)`,
  CREATE/INSERT/SELECT, `new TelegramClient(...)`, `prepare()`, `destroy()` —
  PASS. Second `docker run --rm --network none` reopened the same synthetic
  SQLite row and empty/no-authorization mtcute storage — PASS. This verifies
  native storage and crypto initialization, **not** a logged-in session.
- Disposable Vikunja with writable tmpfs `/db` and `/app/vikunja/files`, public
  registration disabled and random loopback host port: CLI user create/list
  PASS, duplicate create exit 1; `/api/v1/info` reports v2.7.0; `/health` and
  `/api/v2/health` 200; `/api/v2/openapi.json` 200 / OpenAPI 3.1.0 / 136 paths.
- Synthetic CLI account + Python HTTP probe: login, project reuse/create,
  view discovery, six ordered buckets, four labels, one task, label attachment,
  repeated move, Completed done flag and Archived preservation — PASS.
  Repeated complete reconciliation retained project 2, view 8, six buckets,
  four labels and task 1, with no duplicates. Separate API-token read/move/read
  also PASS. Probe scripts and synthetic data are disposable, not domain code.

The Vikunja route probe used SQLite tmpfs to isolate API behavior. PostgreSQL,
Compose startup/restart/volume persistence, a setup wrapper, crash injection,
native AMD64 execution, and live Telegram behavior remain M1/M2/M5 checks.
No restart-persistence claim is made from tmpfs. A future real Telegram smoke
requires configured credentials and explicit relevant onboarding actions.
Respect PM's Jev requirement: Vercel transport only; permanent entitlement
failures must appear in operations status and pause/requeue analysis without
losing ingested messages or busy retrying. This assignment did not probe Jev.

## Primary sources

- [Exact node registry metadata](https://registry.npmjs.org/@mtcute/node/0.32.4),
  [node tarball](https://registry.npmjs.org/@mtcute/node/-/node-0.32.4.tgz),
  [core tarball](https://registry.npmjs.org/@mtcute/core/-/core-0.32.4.tgz).
  Key files: node `client.js`, `sqlite/driver.js`; core `highlevel/methods/`
  `auth/{start,send-code,sign-in,check-password}`, `dialogs/iter-dialogs`,
  `messages/{get-history,iter-history,send-text}`, `chats/create-supergroup`,
  `highlevel/client.types.d.ts`, `highlevel/updates/{manager,types}` and
  `highlevel/types/updates/delete-message-update.d.ts`.
- [mtcute sign-in guide](https://mtcute.dev/guide/intro/sign-in),
  [Telegram update recovery](https://core.telegram.org/api/updates),
  [Telegram random_id/sendMessage contract](https://core.telegram.org/method/messages.sendMessage).
  Guides are supporting context; exact package contents determine signatures.
- [Vikunja v2.7.0 release](https://github.com/go-vikunja/vikunja/releases/tag/v2.7.0),
  [Docker Hub tags API](https://hub.docker.com/v2/repositories/vikunja/vikunja/tags?page_size=30),
  [exact image tag metadata](https://hub.docker.com/v2/repositories/vikunja/vikunja/tags/2.7.0),
  [Docker walkthrough](https://vikunja.io/docs/docker-walkthrough/),
  [API v2 guide](https://vikunja.io/docs/api-v2/).
- Pinned Vikunja source: [Dockerfile](https://github.com/go-vikunja/vikunja/blob/v2.7.0/Dockerfile),
  [CLI user setup](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/cmd/user.go),
  [v2 bucket routes](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/routes/api/v2/buckets.go),
  [v2 task move](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/routes/api/v2/task_bucket.go),
  [view/default bucket behavior](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/models/project_view.go),
  [v2 list shape](https://github.com/go-vikunja/vikunja/blob/v2.7.0/pkg/routes/api/v2/types.go).
