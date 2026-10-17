# Fresh replies on active cards — 17 October 2026

The user sent “Auth keeps failing every request.” from the other Telegram
account while the existing card was Work in progress. Telegram captured it at
2026-10-17T17:18:49Z, within the same second as its source timestamp. It had no
analysis attempt and therefore no proposal or control-outbox message.

The reserved live analysis slot required an AntSeed-authored message in the
same chat during the previous hour. The original outreach was older than that,
so this genuinely new reply on an active tracked card was treated as historical
work. The general worker was occupied by slow historical extraction. The
configured approval group was ready; no notification delivery had failed.

The queue now qualifies a recent sourced message for live capacity when either:

- the chat has a recent direct AntSeed-authored message (existing prospecting
  behavior), or
- the chat already has an active tracked ticket, including a company-unknown
  contact prospect (new reply behavior, independent of when outreach began).

Eligibility still requires a current included non-control chat, matching
policy/mapping/message versions, a fresh source timestamp, an eligible retry
deadline/attempt count, and a valid per-attempt lease. Suspended cards and old
history do not reserve live capacity. The live slot does not advance the durable
general FIFO phase; every fifth general claim still serves the oldest eligible
job. No extra workers, model changes, permission gates, migrations or lane-write
paths were introduced.

Verification:

- 99 focused checks passed: queue ordering/fairness, active company and contact
  prospect replies after two-hour-old outreach, stale/suspended exclusion,
  exact-checksum readiness and real workflow scheduling with held synthetic
  historical extraction. Shutdown still aborts and awaits both analysis slots.
- Three additional real GPT-6 Luna synthetic checks passed: short repeated auth
  failure from Work in progress => Blocked proposal; auth how-to question => no
  move; a single resolved transient failure => no move. These are actual
  classifier calls with authored synthetic extraction, not Telegram evidence.
- Strict TypeScript, production build, target Docker build and diff checks
  passed. The prior 424-test full run and 47-case live matrix belong to the
  preceding classification repair and are not claimed as fresh full reruns here.

Recreated only the personal backend, retaining all database/session/board
volumes. Its image is
`sha256:315e212c0c9d91d5dd38412212975ce823e607aa1157a0ace25c6558af5bd242`.
The already-captured message was claimed at 17:22:36Z on its first attempt,
without a resend, replay or manual queue mutation. Analysis completed at
17:22:56Z with a Blocked proposal. The real Telegram receipt is sent, message ID
4, one attempt, no error. SQL and native Vikunja readback agree that task 1 still
remains Work in progress/stageVersion 1. The new Blocked proposal is
pending/not_requested and has zero mutation rows. No human approval was performed
by this repair.
