# Connector contract

Exact copy of final architecture section 3.3, including 3.3.1 and 3.3.2. Fixture, RecordedApi, the neutral Telegram connector and MemoryStorage MtcuteApi are implemented. The complete pinned installed-source audit and connection procedure exist. C1 remains blocked on Integration-owned external SDK declarations in the required typecheck gate; no whole-Scope review readiness, real-account verification, host storage or final component equivalence is claimed.

### 3.3 Connector contract — `src/contracts/connector.ts`

This is the document R7.3 asks for; `docs/connector-contract.md` is a copy of this subsection.

```ts
export interface ConnectorFactory {
  readonly channel: string;          // [a-z][a-z0-9_]*, unique; stored in chat.channel and identity.channel
  readonly label: string;            // shown in the UI
  readonly capabilities: { history: boolean; edits: boolean; deletions: boolean };
  /** The slowest the connector promises to be when asking the channel for chats or earlier messages. */
  readonly pace: { minRequestIntervalMs: number; pageSize: number };
  /** A statement the account's owner must confirm before login may begin, or null (R4.5). */
  loginNotice(config: Record<string, string>): { version: number; text: string } | null;
  create(ctx: ConnectorContext): Connector;
}

export interface ConnectorContext {
  accountId: Id;
  session: string | null;            // what this connector last passed to saveSession, or null
  config: Record<string, string>;    // this channel's settings, from AppConfig.connectors[channel]
  saveSession(session: string | null): void;   // host seals and stores it; null destroys it
  now(): Date;
  sleep(ms: number): Promise<void>;  // the only way a connector waits; tests pass an instant one
  log: OpLog;
}

export interface Connector {
  /** Interactive sign-in. Call with null to begin, then with the values of the fields last asked for. */
  login(input: Record<string, string> | null): Promise<LoginStep>;
  /** Begin live delivery. Requires a session. Resolves once connected. */
  start(sink: EventSink): Promise<void>;
  /** Stop live delivery within 5 s. After it resolves the connector makes no further sink calls. Keeps the session. */
  stop(): Promise<void>;
  /** End the session on the channel, then saveSession(null). Implies stop(). */
  logout(): Promise<void>;
  /** Every chat the account can see right now: name, kind, and where its newest message is. No content. */
  listChats(): Promise<ChatListEntry[]>;
  /** Messages of one chat, newest first, in pages. */
  fetchHistory(req: HistoryRequest): AsyncIterable<HistoryPage>;
}

export type LoginStep =
  | { kind: 'need_input'; fields: { name: string; label: string; secret: boolean }[]; hint: string }
  | { kind: 'done'; self: ParticipantRef }
  | { kind: 'failed'; message: string; retryable: boolean };

export interface EventSink { emit(event: ConnectorEvent): Promise<void>; }

export type ConnectorEvent =
  | { type: 'message'; chat: ChatRef; message: MessageRecord }
  | { type: 'edit'; chat: ChatRef; message: MessageRecord }            // same nativeId, new text, editedAt set
  | { type: 'delete'; nativeIds: string[]; deletedAt: IsoTime }
  | { type: 'status'; state: 'connected' | 'disconnected' | 'auth_lost' };

export interface ChatRef {
  key: string;        // identical for every account that sees this chat
  nativeId: string;   // this account's handle for the chat; passed back in HistoryRequest
  kind: 'direct' | 'group' | 'broadcast';
  title: string;
}
export interface ChatListEntry {
  chat: ChatRef;
  latestAt: IsoTime | null;       // time of the chat's newest message, if the channel says
  latestCursor: string | null;    // cursor of that message; equal to a stored live_cursor means nothing was missed
}
export interface ParticipantRef {
  userKey: string;    // identical for every account that sees this person on this channel
  displayName: string;
  handle: string | null;
}
export interface MessageRecord {
  key: string;        // identical for every account that sees this message; never changes on edit
  nativeId: string;   // unique within the account across all its chats
  cursor: string;     // position in this account's view of the chat; the host only tests cursors for equality
  sender: ParticipantRef;
  sentAt: IsoTime;
  text: string;       // message text, or the caption of a non-text message, or ''
  media: 'photo' | 'video' | 'voice' | 'audio' | 'document' | 'sticker' | 'location' | 'contact' | 'poll' | 'other' | null;
  replyToNativeId: string | null;
  editedAt: IsoTime | null;
}
export interface HistoryRequest {
  chat: ChatRef;
  after: string | null;    // only messages newer than this cursor
  since: IsoTime | null;   // only messages with sentAt >= since
  limit: number | null;    // at most this many messages in total, the newest ones
  resume: string | null;   // HistoryPage.resume of an interrupted fetch with the same chat, after, since and limit
}
export interface HistoryPage {
  messages: MessageRecord[];   // newest first within the page; pages run newest to oldest
  resume: string | null;       // pass back to continue below this page; null on the last page
}
```

**A connector must:**

1. Never do anything on the channel that another person could observe: no sending, editing, deleting, reacting, marking as read, typing or online status.
2. Await `sink.emit` before treating an event as delivered. If `emit` rejects, stop delivering and emit `status: disconnected`.
3. Supply `key`, `userKey` and `ChatRef.key` values that are the same from every account. This is what makes a group message seen by two teammates one row (R6.3).
4. **Pace itself (O4, R6.6).** Across `listChats` and `fetchHistory` for one account, send the channel at most one request every `pace.minRequestIntervalMs`, each for at most `pace.pageSize` items, waiting only through `ctx.sleep`. When the channel answers "wait N seconds", wait N seconds and then double the interval for the rest of that call. If the channel asks for more than 600 seconds, throw; the host records a gap and retries later.
5. Make `fetchHistory` resumable: every page carries a `resume` token, and a call given that token continues below that page without asking again for what was already returned. It may throw at any point; the pages already yielded stay valid.
6. Skip service events (joins, pins, title changes). Only messages a person or bot wrote become `MessageRecord`.
7. Call `ctx.log` with ids, counts and state names only. Never message text, chat titles, names or raw channel payloads.
8. Keep everything it needs to resume a session in the one string it gives to `saveSession`.

**A connector may assume:**

1. The host calls its methods for one account from one process, and never runs two of `listChats` and `fetchHistory` for the same account at once.
2. Events for chats that are not included are dropped by the host. The connector does not filter.
3. Duplicate events are harmless. The host stores a message once.
4. `sink.emit` may be slow.

**What a connector with a missing capability does:** `history: false` makes `fetchHistory` yield nothing; the host then cannot catch up after downtime and opens a gap that stays (R6.4). `edits: false` and `deletions: false` mean those events never arrive.

**What a restart costs the channel (R6.6).** The host asks `listChats` once per account, then calls `fetchHistory` only for included chats whose `latestCursor` differs from the stored `live_cursor`. In requests: `ceil(chats the account has / pageSize)` for the list, plus `ceil(missed messages / pageSize)` and at least 1 for each included chat that has missed messages. An included chat with nothing missed costs nothing beyond the list. The same pass runs on a reconnect, at most once every 5 minutes per account.

`src/connectors/registry.ts` is the only file that names connectors:

```ts
export function buildConnectors(config: AppConfig): ConnectorFactory[];   // those whose channel is a key of config.connectors
```

#### 3.3.1 Fixture connector — `src/connectors/fixture/`

```ts
export function createFixtureConnector(source: { path: string } | { lines: FixtureLine[] }):
  { factory: ConnectorFactory; control: FixtureControl };
export interface FixtureControl {
  /** Emit every line up to the named mark (or 'end') to all started accounts; resolves when the sink has accepted them. */
  advanceTo(mark: string): Promise<void>;
  /** Every request a real connector would have sent, in order: { account, op: 'listChats' | 'fetchHistory', chatKey, atMs }. */
  calls: { account: string; op: string; chatKey: string | null; atMs: number }[];
}
```

`channel: 'fixture'`, `capabilities: { history: true, edits: true, deletions: true }`, `pace: { minRequestIntervalMs: 0, pageSize: 100 }`, `loginNotice` returns null. Login asks for one field, `account`. There is no module-level registry of recordings: whoever creates the connector holds the `control`. `buildConnectors` creates it from `config.connectors.fixture.PATH` and, outside tests, calls `control.advanceTo('end')` on start.

Recording: JSON Lines, one object per line, read in order. `FixtureLine` is the union of these shapes.

```jsonc
{"t":"config","pageSize":10}
{"t":"account","account":"alice","self":{"userKey":"u-alice","displayName":"Alice","handle":"alice"}}
{"t":"chat","account":"alice","chat":{"key":"chat-1","nativeId":"chat-1","kind":"direct","title":"Bob"}}
{"t":"message","account":"alice","delivery":"live","chatKey":"chat-1","message":{ /* MessageRecord */ }}
{"t":"edit","account":"alice","chatKey":"chat-1","message":{ /* MessageRecord, editedAt set */ }}
{"t":"delete","account":"alice","nativeIds":["n-17"],"deletedAt":"2026-09-01T10:00:00.000Z"}
{"t":"history_error","account":"alice","chatKey":"chat-1","afterPages":1,"times":1}
{"t":"mark","name":"before-restart"}
```

- `config` (optional, first line) sets the page size `fetchHistory` uses, so a small recording can span several pages.
- A `chat` line makes the chat appear in `listChats` from that point on. `latestAt` and `latestCursor` are those of the chat's last `message` line the replay has reached, whatever its delivery.
- `delivery`: `live` is emitted to the sink when the replay reaches the line. `missed` is never emitted; `fetchHistory` returns it (a message that arrived while the product was stopped). `history` is never emitted and is returned by `fetchHistory` (a message older than the connection). A message repeated on two `live` lines models a reconnect.
- `history_error`: the next `times` calls of `fetchHistory` for that chat throw after yielding `afterPages` pages. With `afterPages: 0` and no `times`, every call throws. This is how "fails after its first page, then a restart" is replayed (R6.5, O8).
- `cursor` in fixture recordings is the zero-padded line number of the message. Message keys are unique across the whole recording.

#### 3.3.2 Telegram connector — `src/connectors/telegram/`

`channel: 'telegram'`, `capabilities: { history: true, edits: true, deletions: true }`, `pace: { minRequestIntervalMs: 3000, pageSize: 100 }`. Config keys `API_ID`, `API_HASH`, `APP_OWNER` (the name of the teammate whose phone number registered the application). Login steps: `phone`, then `code`, then `password` if the account has one.

`loginNotice` returns version 1 of the three facts R4.5 lists, with `APP_OWNER` named in the third: what is stored is full control of the account; Telegram puts accounts that log in through unofficial clients under observation and may restrict them, at an unknown rate; the application is registered under `APP_OWNER`'s number, Telegram notifies that account, and its remedy ends access for every teammate.

**Why 3 seconds and 100 (O4).** Telegram publishes no limits, so these are chosen, not derived. They make the costs small and statable: the look-back at inclusion (200 messages) is 2 requests; a restart with 300 chats in the account and 50 included chats that all missed messages is 3 + 50 = 53 requests over about 160 seconds; with nothing missed it is 3 requests. If Telegram answers with a wait, the connector obeys it and slows down (rule 4).

The connector talks to Telegram only through this port. It has no operation that writes to Telegram other than asking for a login code.

```ts
// src/connectors/telegram/api.ts
export interface TelegramApi {
  importSession(session: string): Promise<void>;
  exportSession(): Promise<string>;
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;   // Telegram delivers a login code to the account's owner
  signIn(a: { phone: string; phoneCodeHash: string; code: string }): Promise<TgUser | 'password_needed'>;
  checkPassword(password: string): Promise<TgUser>;
  getMe(): Promise<TgUser>;
  dialogs(o: { offset: string | null; limit: number }): Promise<{ dialogs: TgDialog[]; next: string | null }>;
  history(peer: TgPeer, o: { minId: number; maxId: number; limit: number }): Promise<TgMessage[]>;  // newest first; 0 means unbounded
  startUpdates(h: {
    onNew(m: TgMessage): Promise<void>; onEdit(m: TgMessage): Promise<void>;
    onDelete(d: { ids: number[]; channelId: number | null }): Promise<void>;
    onState(s: 'connected' | 'disconnected' | 'auth_lost'): void;
  }): Promise<void>;
  logOut(): Promise<void>;
  destroy(): Promise<void>;
}
export class TgFloodWait extends Error { seconds: number; constructor(seconds: number) { super('flood wait'); this.seconds = seconds; } }
export interface TgUser { id: number; displayName: string; username: string | null }
export interface TgPeer { type: 'user' | 'group' | 'supergroup' | 'channel'; id: number }
export interface TgDialog { peer: TgPeer; title: string; lastMessageId: number | null; lastMessageDate: number | null }
export interface TgMessage {
  id: number; peer: TgPeer; sender: TgUser; date: number /* unix seconds */; text: string;
  media: MessageRecord['media']; mediaUniqueId: string | null;
  replyToId: number | null; editDate: number | null; isService: boolean;
}
```

Two implementations: `MtcuteApi` (wraps `TelegramClient` from `@mtcute/node` with `MemoryStorage`) and `RecordedApi` (replays a synthetic session file written in the types above, and appends `{ op, atMs }` for every call to `calls`). The session file format is the Telegram stream's own. R4.1, R4.2 and R6.6 are checked against `RecordedApi`: they check our code above the library and nothing below it (PRD 3.2).

Session handling: after login and after each `stop`, the connector calls `saveSession(await api.exportSession())`. On `start` it calls `importSession`. The host stores the string sealed. Nothing of mtcute's is written to disk.

How the Telegram connector fills the contract's keys. Telegram numbers messages per account in one-to-one chats and basic groups, and per chat in supergroups and channels (the "common message box" and "channel message box" of https://core.telegram.org/api/updates, accessed 2026-10-10; mtcute's `DeleteMessageUpdate.channelId` is `number | null` **[tested]**).

| Field | one-to-one | basic group | supergroup, channel |
|---|---|---|---|
| `ChatRef.key` | `u:<lower user id>:<higher user id>` | `g:<chat id>` | `c:<channel id>` |
| `ChatRef.kind` | `direct` | `group` | `group` for supergroup, `broadcast` for channel |
| `nativeId` | `u:<message id>` | `u:<message id>` | `c<channel id>:<message id>` |
| `MessageRecord.key` | `<sender id>:<date>:<first 16 hex of sha256(text + "\n" + mediaUniqueId)>` | same as one-to-one | `<message id>` |
| `cursor` | `<message id>` | `<message id>` | `<message id>` |
| `userKey` | `<user id>` for all | | |

`key` is computed from the text the connector first sees and is not recomputed on edit.

