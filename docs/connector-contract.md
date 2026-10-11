# Connector contract

Exact copy of current final architecture section 3.3, including all fixture, Telegram session and authenticated terminal teardown requirements. Full C1 and its historical F1-F6 corrections were approved in round3; the newly admitted cold-logout repair is implemented for NEW independent whole C1 round4 review and parent main gate. Offline seams do not establish remote revocation. The approved compiler policy skips all .d.ts bodies without fixing or certifying them. Host durability, inclusion/notice enforcement, cursors/gaps, final component equivalence, and real-account/model observations remain later gates.

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

**Session handling — final owner amendment, 2026-10-10.** Accepted `decisions/2026-10-10-c1-review-r1-corrections-and-session-envelope.md` §§1–3 supersedes only the former literal raw SDK-session pass-through. The connector owns a private versioned envelope in the existing saved string; `ConnectorContext.session/saveSession`, `Connector`, `TelegramApi` and all shared declarations/schema/migrations remain unchanged. Host/auth alone seals and atomically replaces the whole string through the existing `saveSession` callback. Nothing of mtcute's is written to disk by the connector.

- **Private format and validation.** The string is the exact prefix `kanban:telegram-session:` followed by canonical `JSON.stringify({v:1,sdkSession,keys})`. `sdkSession` is a nonempty opaque string. `keys` is an array of exactly two-string tuples `[nativeId,firstSeenKey]`, sorted by nativeId using code-unit order, with no duplicate nativeId, even when duplicate values agree. Retain only common-box `u:<message id>` entries; channel-box numeric keys need no retained entry. Validate the exact object fields/version, tuple shape/order/uniqueness, native-ID form and key form `<sender id>:<unix seconds>:<16 lowercase hex>`, with numeric segments in the existing decoder's canonical finite-number spelling. Require the suffix to equal its canonical reserialization after strict validation, rejecting duplicate JSON fields, extra fields and noncanonical encodings. This is a connector-private validator using existing dependencies, not a shared schema. A tagged malformed/unsupported envelope fails with a fixed safe `AppError('invalid', 'Invalid saved connector session')` before SDK import or decoding; never fall back to legacy import, discard entries or repair/re-key it. Never include the saved value, tuple values, parser details or SDK errors in diagnostics.
- **Opaque import and restoration.** Validate the entire envelope and install its complete retained key map before any live new/edit or history decode, including a fresh connector/API whose first observation is an edit or edited history. Pass ONLY its `sdkSession` field to `api.importSession`; `api.exportSession` still returns the raw opaque SDK value. JSON escaping is only envelope serialization: preserve the inner string value exactly, without inspecting, parsing or re-encoding SDK authentication internals. Keep state per connector/account, never module-wide or shared across accounts.
- **Login, stop and legacy.** After successful login and after each successful `stop`, export the opaque SDK string and save an envelope with the complete current retained map; login is not reported done and stop is not reported successful if its required save fails. A nonnull saved value without the reserved prefix is legacy raw SDK data: import it unchanged and begin with no recoverable prior key state. Do not parse it as connector JSON or infer original content/keys from it. On the next successful save, wrap it with only the keys actually learned since restoration; report legacy-state absence by a fixed state/count/id diagnostic, without payload. A null saved value requires login. Successful logout saves null and clears the map; never carry old account keys into a new login. Preserve existing logout error propagation, generation invalidation, no-late-sink and five-second stop obligations.
- **Persist before delivery.** For each first-observed non-service common-box nativeId, compute the same existing first-seen key once. Stage a prospective map; synchronously save the whole envelope before installing that map and before invoking `sink.emit` for the message/edit or resolving its awaited TelegramApi callback as delivered. For history, stage all new keys of the next page, save them together, then install the map and yield that page; never yield first-observed rows before their save. Known keys are reused without hashing edited content; service events and deterministic channel-box keys add no entries. Reuse the latest successfully imported/exported opaque SDK value for key-only saves: no extra account RPC, SDK credential lookup or persistence destination. All storage writes use the existing `saveSession`, not a new host DB/API path.
- **Serialization and failure.** Serialize synchronous key learning, whole-envelope replacement and authoritative-state installation per instance across live delivery, history and lifecycle operations; observe asynchronous failure/destruction cleanup separately under the terminal protocol below. After an asynchronous SDK export, build the saved snapshot from the latest complete map at the serialized save point; a stale snapshot must never overwrite newer keys. Normal return from the existing synchronous void callback means the host completed one atomic sealed-string replacement; it must throw on failure, not start an unacknowledged asynchronous write. The connector cannot atomically combine session persistence with the later host message transaction. A crash after save but before delivery leaves a retained key and a harmless replay; a crash before save leaves no acknowledged event/page. On serialization/export/save failure, do not deliver/acknowledge the affected live message or yield the affected page, do not claim login/stop success, and never continue decoding with a silently reset map. Latch the failure, invalidate further live delivery and attempt only a safe disconnected status/ bounded cleanup; propagate a fixed safe failure through the awaited callback/history/lifecycle boundary. Keep the failed candidate keys in memory for an explicit retry of that same snapshot, or recreate from the authoritative saved string; no automatic re-key/retry loop. A host that commits then throws has an ambiguous result: assume no delivery acknowledgement and restore the complete old or new atomic value on recreation. Earlier yielded pages remain valid and their resume tokens retain their existing meaning.
- **Retention and content boundary.** Keep one tuple per distinct observed common-box nativeId for the life of the saved session, including observations whose content the host drops. No automatic eviction on age, count, exclusion, deletion, restart or stop; resource/serialization/storage exhaustion is a visible save failure before new delivery, never truncation or identity reset. The only growth is this necessary identity map. No original text, caption, media payload/unique-ID field, names, titles, phone numbers, update positions, event archive or unrelated metadata is retained outside the opaque SDK field. Derived first-seen hashes are private resume state, not host message records or a new shared feature. No envelope or key map enters logs, context, client output or fixtures containing real credentials. Host-only whole-string sealing and existing disconnect destruction remain unchanged.

##### Authenticated terminal logout and absolute method-entry deadline

Accepted durability/teardown authority: `decisions/2026-10-10-h1-design-r2-ruling-and-owner-amendment.md`, incorporating the exact complete r2 candidate and closed debate04 qualifications. These current sections supersede the earlier reply/origin/logout/audit details only; public declarations, PRD criteria, message-key algorithm, ownership and later gates are unchanged. This is accepted design, not implemented or reviewed repair.

C1 owns existing logout/private session/adapter helpers and adjacent tests, with no ConnectorContext/Connector/TelegramApi/Host/saveSession signature change. Host only unseals/passes the full opaque saved string; it never parses C1 JSON, calls login(null), or accepts a nonnull lifecycle save after removal. H1 synchronously removes local access and prohibits such saves before invoking logout; its existing50,000-ms wrapper stays a final bound, not evidence of SDK cancellation.

At logout METHOD ENTRY capture t0 using injected ctx.now. One shared terminal operation has absolute preparation deadline t0+45,000ms and final deadline t0+50,000ms. Concurrent repeated logout shares this original operation/deadline. The preparation allowance includes ALL prior queue admission/fault cleanup, validation/restore, SDK import and RPC; no timer starts after waiting on the queue or resets per stage. A prior5s cleanup leaves at most40s preparation. Final destruction/local null get at most5s and only the time remaining to t0+50s. All waiting uses injected ctx.now/sleep; check clock AND generation after every await and immediately before auth.logOut.

Entry installs a terminal generation barrier immediately: stop/detach delivery and updates, invalidate startup/login/history/key-learning/export/nonnull-save work and cancel further admission. Snapshot the last successfully saved authoritative session and the first substantive persistence fault. Do not use stale ctx.session or a failed candidate. The private teardown accessor may validate/read that authoritative state despite a latched fault; it must not reset fault health for ordinary operations. Preserve F6 fault-before-cancellation precedence.

Refactor the PRIVATE session queue so its serialized lane covers synchronous save replacement/authoritative-state installation, while asynchronous onFailure/destruction cleanup is observed separately and deduplicated. Latch fault/candidate synchronously BEFORE launching that cleanup; failure remains authoritative even if cleanup is pending. At terminal entry invalidate tokens on ALL previously queued jobs, then establish a terminal tail that is not chained behind an unbounded prior asynchronous cleanup. Every old job must check its enqueue token before callback/effect and after awaits; after a synchronous callback it must check again before installing saved/map state, including a callback that reenters stop/logout. Terminal null runs on a microtask/serialized tail AFTER already-running synchronous callbacks return. No old save callback may start after the barrier and no old continuation may restore a candidate/fault/map into a fresh generation.

Detaching the old queue is insufficient by itself: bound or cancel prior SDK cleanup within preparation, and never import into a mutable SDK instance an older destructor can still affect. Destruction captures a specific SDK client/generation; prior fault/stop/logout share one destruction per client generation. Existing immediate abort/close occurs BEFORE asynchronous cleanup; old continuations only touch their captured detached client and are otherwise inert. If safe reuse/import cannot be admitted before preparation deadline, abort and issue no late RPC. A newly created/imported SDK is a distinct generation with its own deduplicated destruction, not protected by an old client's already-settled promise. Fresh login remains barred until terminal state settles and ALL older effects are fenced, even if their observed promises later settle.

Strictly validate the authoritative saved envelope under accepted C1 rules. Reserved tagged malformed/unsupported state yields exact AppError('invalid', 'Invalid saved connector session'), with no raw fallback/import. Valid canonical state imports ONLY nonempty inner sdkSession; valid legacy raw state imports intact through existing api.importSession. No host parser, SDK-internals parser, getMe, login, startUpdates, export/wrap/resave or nonnull persistence is introduced in logout. Pinned SDK unforced import is local/no-op when already authorized, and restores a fresh/stopped SDK before api.logOut. Current auth evidence must be tied to actual successful SDK import/auth in that client generation, invalidated by destroy/auth loss. Cached self after destroy is insufficient. If save failed after actual auth, current-generation auth may still permit best-effort logout, but a failed candidate is not authoritative saved state.

Null with no currently authenticated SDK performs local cleanup/null only, without fake login/import/RPC or remote-success claim. Valid saved auth or actual current SDK auth permits import as applicable, then checked api.logOut. Import/RPC errors become fixed safe Connector logout failed (owned unauthenticated classification may remain); timeout/cancellation becomes fixed Connector logout timed out/cancelled. Never expose parser/SDK/session details. First substantive safe persistence error retains F6 precedence over cancellation/cleanup. Acknowledgment of an authenticated local RPC seam is not real remote revocation.

At timeout/stop cancellation immediately invalidate remaining terminal work and invoke api.destroy to abort/close, rather than racing a still-effective promise. Stop during logout shares/cancels terminal cleanup and makes NO nonnull lifecycle save. Handle late import/RPC/export/prior-cleanup resolve AND reject inertly: no late RPC, session replacement, sink, connected/done or newer-generation null. During final cleanup invoke deduplicated destroy immediately for abort/close, then attempt generation-checked synchronous saveSession(null) on the terminal serialized tail BEFORE awaiting destruction, without awaiting held old cleanup. Thus null does not sit behind a cleanup timeout at the final deadline. Await/observe destruction only within min(cleanup-entry+5s,t0+50s); the adapter's existing5s bound is inside this allowance, not an additional stage. Normal callback return installs null/clears private map/candidate/auth/self for this generation; a throw preserves authoritative failed-save behavior, is safely surfaced and is not automatically retried. Local cleanup/null is attempted even after malformed/import/RPC failure. Retain first substantive safe error rather than masking it with a later cleanup error.

The synchronous void saveSession contract cannot promise a wall-clock bound for an arbitrarily blocking callback/event loop; production callback is the existing synchronous atomic host replacement, with no async wait introduced. Deadline tests use that contract. Once terminal settles and old effects are fenced, a new generation may start; stale null/cleanup cannot corrupt it. Ordinary successful restored login and ordinary stop OUTSIDE terminal teardown still export/save the FULL latest canonical envelope and surface mandatory persistence errors. F1–F6 are retained in full, not traded away for teardown speed.

Host removal faults remain fixed local-removal/restoration/remote-logout failures with account access removed/session null; no reopening/retry credential is introduced. Offline failure, process crash between local deletion and RPC, or timeout cannot certify remote revocation. StrictRecordedApi authentication checks and a separate actual pinned SDK auth-key/no-transport seam are future required fixtures, not permissions to use real accounts.

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

**Identity boundary retained.** The envelope preserves a previously learned and successfully saved common-box key across fresh instances, for live-edit-first and edited-history-first recovery. An account first seeing an already edited message, a legacy raw session without retained keys, loss of the saved string, or explicit logout has no original first-seen content/key to recover. The unchanged text/media hash algorithm cannot guarantee the public same-key-across-accounts rule when accounts first observe different revisions; this pre-existing unconditional-contract limit is recorded, not an approved weakening or a claim of recovery. Stronger original/cross-account recovery would require a separately accepted identity/state design; this amendment permits no extra RPC, shared lookup or algorithm change.

