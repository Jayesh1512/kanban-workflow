# Connect Telegram

The installed-source audit of **@mtcute/node 0.32.4 and @mtcute/core 0.32.4** found no automatic chat sending, editing, deletion, reaction, read mark, typing or online-status request in the selected connection, login, listing, history and update chains. It did find automatic authorization/configuration/update-difference requests, protocol acknowledgements, reconnects and retransmissions. The adapter selects MemoryStorage, disables default RPC retry/wait middleware, and exposes the frozen read-only TelegramApi. The SDK itself has broader capabilities.

The complete source inventory, file:line evidence, versions and exclusions are in the canonical research record `/Users/jys/Documents/Projects/hello/.context/research/2026-10-10-connectors-c1-installed-source-audit.md`. Relevant transitive versions are file-id/tl-runtime/wasm 0.32.0, @fuman/io/net/node/utils 0.0.21, long 5.3.2 and better-sqlite3 12.11.1. SQLite is imported by the package but never selected; its unused native build remains disabled. The source review preceded this procedure. Earlier first-pass and blocked audits remain historical evidence.

Source findings are medium-high confidence for the selected reachable chains, including dynamic request envelopes and Node storage/transport, not a formal library or WASM security proof or a captured wire trace. They cannot establish Telegram's server-side online/read behavior, notification delivery, account restriction rate, live restoration across DC changes, or socket cleanup under actual OS failure. The adapter observes RPC authorization errors before the update manager can swallow them; real revocation/reconnect behavior still needs observation. Offline tests use synthetic data and a transport that cannot connect. **R4.6 source evidence is not a [U] pass or permission from Telegram.**

This is the future owner-operated R4.4/R4.7 procedure. C1's required typecheck is presently blocked by external SDK declarations; H1 host storage/notice enforcement/cursor/gap gates and the complete product connection flow must also pass before following it. It authorizes no account action by an implementation agent. No real account has been connected or tested in C1.

## Before login

Use the established account of the project's owner, alone, with **one or two included chats for one week before inviting teammates** (Q7). A throwaway account is not established as safer. Read-only use can still lead to restrictions at an unknown rate. Q8's statement describes our implementation; it is not Telegram permission or a read-only Telegram credential.

The human registration owner obtains API credentials through Telegram's application-registration process. Configure `connectors.telegram.API_ID`, `API_HASH` and `APP_OWNER`; `APP_OWNER` must name the teammate whose phone number registered the application. Enter secrets through the approved local configuration mechanism; do not paste API_HASH, login codes, passwords, session exports or the host sealing key into reports or logs. Keep the host's sealing key available across restarts and protect the database and key separately. This adapter reads only its supplied context configuration and does not create a credential store.

Before the host requests a login code, confirm the **version 1 login notice** naming that registration owner and all three facts:

1. The stored session gives full control of the account. Telegram provides no read-only credential.
2. Telegram puts unofficial-client accounts under observation and may restrict them; the rate for read-only use is unknown.
3. The application is registered under APP_OWNER's phone number. Telegram notifies that account, and its remedy ends access for every teammate.

The host must record that exact version and confirmation before allowing login, including after a notice-version change. Stop if the notice is absent, its owner is wrong, or confirmation is bypassed. This enforcement is H1 evidence, not established by a connector's notice function alone.

## First connection and actual storage check — R4.4 [U]

1. Start the locally gated product with the normal empty local database and unchanged default proposal count **1**. Begin Telegram connection, confirm the notice, and enter your phone number. Telegram delivers the login code to you; asking for that code is the accepted effectful login operation. Enter the code, then the account password only if requested. No chat action is available through the connector port.
2. Expect Telegram's new-login alert on the account's normal devices. Verify that its timing and application/device details match this login. Record its presence without copying account credentials. Treat an unexplained alert as a separate security incident; do not dismiss it as this test.
3. List chats and include only the chosen one or two. Listings contain title/kind/latest date/cursor, not message content; inclusion and allowed ingestion are enforced by the host. Leave all other chats excluded. The source adapter may receive account-wide updates; exclusion is a product storage boundary, not a Telegram permission boundary.
4. In Telegram on your **phone**, send one identifiable test message in an included chat. Have the chat's human participant send one incoming test message there. These are manual phone actions, not product-generated sends. Verify both exact messages in actual host storage and the normal product view: correct chat, author, text/caption, direction, time, reply/media placeholders if applicable, native IDs and cursor; no duplicate rows. Record only redacted evidence or test labels, not private conversation content. Verify excluded-chat messages are not stored. Synthetic adapter events alone do not meet this check.
5. Stop the product normally. Verify the host saved the opaque exported session as a **sealed** credential, not plaintext; do not print or copy that credential to prove it. Restart with the same database and sealing key, without entering a new code/password. Verify the account reconnects, the phone's outbound and incoming test messages remain stored once, and another manual incoming/phone-sent pair is ingested. Confirm catch-up resumes from saved cursors. An included chat with a latest service-only event must advance its saved live cursor after an empty catch-up; repeated fetching of that same service cursor is a failure.
6. Check gap behavior with the host's controlled offline fixture gates before relying on real downtime recovery. Errors after a yielded history page must preserve that page, resume below it, and expose a gap rather than imply complete history. Do not induce a flood wait on a real account to test this. H1 owns real seal/cursor/gap handling; H2 owns stored edit/delete effects.
7. When disconnecting through the product, verify transport delivery stops and the host destroys the stored session (`saveSession(null)`), account references and account-owned subscriptions according to H1. A failed remote logout must remain visible; do not equate local credential removal with proven remote revocation. Confirm the product cannot reconnect using the removed stored credential. Do not copy the session into a separate SDK script.

## First second-device observation — R4.7 [U]

During the owner's first connection, keep Telegram on a second device signed into the **same account** and observe for **at least one full day**. Keep the product running; note periods when phone/second-device foreground use itself could change read or presence state. Use an agreed human observer in the one chosen chat to observe the owner's online status where needed; a same-account device cannot independently establish how another person sees presence. Product agents perform none of these actions.

Record start/end times, product uptime, manual Telegram actions and these observations:

- **Online status:** no online presence change attributable to the product while the owner's Telegram devices are idle. Separate foreground-device activity from product activity in the record.
- **Read marks:** new incoming messages remain unread on the phone/second device until the owner deliberately reads them there. The product must not advance those marks when it ingests or displays a message.
- **Phone notifications:** expected incoming notifications still arrive while the product runs; record missing/delayed notifications and the device's notification/background settings.
- **Phone-sent ingestion:** messages sent manually from the phone appear once in actual host storage and the product, including after the normal session restart above.
- **New-login alert:** the expected first login alert is present. A restart using the saved session should not require a new code; record any unexpected alert or login prompt rather than assuming restoration succeeded.

Any unexplained online/read/notification behavior, restrictions, repeated authorization/reconnect errors or missing phone-sent ingestion fails the observation. Stop the product, retain redacted timestamps/state/counts for diagnosis, and defer teammates. Do not keep retrying login or increase concurrency to get past a failure. Complete the one-week owner-only period before teammate onboarding; one day of observation does not replace that period.

## Limits and costs

The connector shares one request clock across listing/history for each account: one application request per 3000 ms, pages of at most 100. A flood response up to 600 seconds waits through the host-provided sleep and doubles that call's interval; a larger wait throws for the host to record a gap and retry later. These numbers were chosen because Telegram publishes no safe limit. They are **not a Telegram safety guarantee** and do not count automatic SDK protocol/config/update/auth requests or retransmissions.

Synthetic R6.6 checks show 300 dialogs/50 included chats each missing one page cost 3 listing + 50 history = **53 application requests**, about 160 seconds; when no included chat missed anything, only the 3 listing requests occur. A 200-message inclusion look-back costs two history requests. Host catch-up runs on restart/reconnect at most once per five minutes per account. Peer caches are rebuilt by listing before history; they are not copied into a second credential store. Unavailable-message holes fail visibly rather than truncate history silently.

Offline [F] evidence covers fixtures/RecordedApi, real SDK MemoryStorage session import/export without sockets, actual adapter synthetic seams, field fidelity, pacing, resumable pages, cancellation, callback rejection and bounded cleanup. H1 actual storage/notice/seal/cursor/gap, H2 stored edits/deletes, final R7.2 component scans, full stand-in-to-card/MCP equivalence, account [U] observations and later model [M] quality gates remain separate. None is implied by source inspection or the synthetic 53-request calculation.
