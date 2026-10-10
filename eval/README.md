# E1 replay data

`node eval/generate.ts` writes exactly the five architecture 3.15 files in `eval/e1r/`:
`recording.jsonl`, `setup.json`, `script.jsonl`, `movement.jsonl`, `labels.json`.
There is no evaluator, scorer, E1-M set, model call, product substitute or acceptance test in E1.
`node --test 'eval/**/*.test.ts'` checks deterministic bytes, frozen schemas and every label/reference.

The fixture has 80 conversations, 1,294 logical messages (1,312 deliveries), two accounts,
16 companies, 65 outside contacts, three lanes with 3/4/2 stages, 78 cards, 100 expected
stage transitions, 485 nonwork messages (37.48%), 60 known-company mentions, 12 unknown
mentions and 24 injection strings. All ten media kinds occur. Fifteen company names
share the generic word `Group` to expose the frozen candidate saturation rule; no
matching rule is changed here. Variants include capitalization/legal suffixes, initials
and partial names. Contacts with neither company nor role evidence stay explicitly unknown.

`setup.json` is the separate below-one automatic fixture (`review_threshold: 0.8`,
`require_agreement: true`). `defaultScenario()` returns a fresh threshold-one setup
with the same 30-message grouped create/join recording. The active integration-owned
12-message default-one/HTTP acceptance/board/MCP spine remains the full gate. Confidence
values and distributions are synthetic fixture fields, never measured model accuracy.

## Runtime handoff to E2

Recording and script use the frozen `FixtureLine` and `ScriptLine` formats. Script
references are message keys, lane/stage names and user keys; no card/contact IDs are
invented. Every logical recording message has one script and one message label, including
explicitly older/not-included and later-withdrawn cases. The only repeated keys are
second-account sightings, reconnect delivery and the post-withdrawal drop attempt.
`labels.cards[*].chatKeys` contains both chats for the shared card.

Most movement lines are exact named `MovementReplayLine.answer` declarations. Nine raw
lines are complete Choice fixtures or deliberately defective versions of complete
fixtures. Each valid raw response answers movement, stay support and support for EVERY
offered destination (N+2). Shipping/Done chooses the shipping message m-070-002; the
selected Finance/Paid answer chooses the distinct finance message m-070-003. It cannot
use the Shipping support answer. Generated replay metadata is null, with no live model
version/request ID/token usage claim.

A raw response is inherently bound to actual request IDs, versions and evidence bundles.
E1 uses `structuralSnapshot()` to project configured setup and recording names into
explicit **eval-only** typed fixture identities. These static numbers are not product
allocations. E2 must rebuild raw cases with `rawChoices(actualRequest, case.mode)` before
injection into the actual adapter; the helper accepts supplied IDs and complete option
maps and is tested with different allocations. It is fixture construction, not a parser
or guard. Do not run the static raw lines as though their IDs were resolved against a
product database. A1/I1 own actual request construction, parsing and boundary validation.
The final full replay may use declared name-based answers while isolated adapter cases
consume the rebound raw envelopes. No consumer format, shared API or schema was added.

`MOVEMENT_CASES` declares 23 named structural/planned scenarios: destination-bound Finance;
confident stay; low-confidence stay with probability 0.4/confidence 0.1 and a generic
0.95 same-lane move; applicable support-review; movement review/conflicting evidence;
unselected support-review; invalid destination/distribution/missing/generic/extra answers;
unavailable/timeout/stale; old evidence after human override; strict equality; default-one
uncertainty; prospective create; open-proposal join; settled-proposal join; local
no-destination; contradictory Shipping/Finance; mismatched normalized target.

The following are E2 actions on **real** components in fresh runs/at marks, not fixture
pseudo-events and not E1 passes:

- Accept the first cross-chat offer before chat 002's next message, linking both chats.
  Accept the low-confidence new-card group after all 30 messages, or at the isolated
  settled-join case's boundary. All earlier joins name its opening message.
- Include ordinary chats at `setup`; include chat 076 only at `new-chat-visible` and chat
  078 only at `include-with-history`. Fetch the latter's newer history; assert the older
  personal greeting is excluded by seven-day look-back, rather than ignoring its label.
- Stop at `before-stop`, advance missed chat 077 messages, restart to initiate catch-up;
  assert one page stored and the configured `afterPages: 1, times: 1` failure. Restart
  the retained failed fetch at `catchup-failed` and resume through `after-restart`.
- Dismiss uncertain nonwork at `uncertain-dismiss` after ten messages. Its eleventh
  uncertain message is immediately next and must open a new group.
- The shared group has a new outside speaker after inclusion. Verify agreement becomes
  stale while ingestion continues. Respect owner-specific counts and two sightings.
- Baseline labels keep cross-lane movement in review. At `finance-review`, an isolated
  human acceptance run may move to Finance/Paid, with its own after-accept expectation.
  Do not compare that destructive branch with baseline Sales card labels unchanged.
- No-destination has **no scripted provider answer** at m-074-004. In its isolated run,
  archive the other lanes before snapshotting, supply a generic same-lane move and
  assert zero call/local no_destination without fabricated hosted confidence. A newly
  offered destination must invalidate that absence. The baseline still has three lanes.
- Make a real human correction at `before-human-override`, then replay old evidence.
  Open-join inherited-move clearing, stale-SOP/permission/evidence/settlement and normalized
  Finance+Shipping support mismatch require actual injected request/result boundary tests.
  The `invalid_response` replay line labels the expected mismatch outcome only; it does
  not prove that guard validation. Duplicate JSON keys require raw HTTP-byte fixtures.
- Withdraw chat 016 at `before-withdrawal`; the following repeated message must be dropped.
  Compare baseline labels before withdrawal and explicit remaining labels afterwards;
  scan SQLite/FTS/WAL for `E1R_WITHDRAW_ONLY_7QX`, including title/summary/company/log bytes.
  Stored edit/delete events occur at `stored-edit-delete`, with no version-2 decision
  script and no full R10 re-evaluation claim.

E2 still needs actual merged core/R31/backup/polling/stored-R10/measures and independent
MCP-client evidence; exact board/card-log equality, scoped text/graph/search, 2,000-card
render timing, rollback/purge and HTTP acceptance are unrun. A1/I1 supply complete
question-template request/response limits, overflow/zero-call, request correlation,
endpoint/redirect/cancel/retry and OpenAI envelope evidence. W1 supplies authenticated
human acceptance/change/dismiss/status. Integration owns the final report and spine
replacement. No [M] or [U] pass follows from these files.
