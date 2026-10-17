# Lane classification repair — 17 October 2026

The captured reply “yes sure, pls share more info” completed analysis, but did
not create a proposal. GPT-6 Luna selected Work in progress with probability
0.83/confidence 0.81; the separate support predicate returned 0. Both gates
rejected the recommendation. This was a classification problem, not missing
Telegram ingestion or a failed control-group send.

The previous rules allowed engineering review for Work in progress but also
excluded “future engineering review” in the generic support question. The
support question did not state the actual current stage, and conflated evidence
for a business stage with whether a board write was warranted. Identity and
human-reviewed stage suggestions also shared the same confidence threshold.

The v3 rubric gives the lane question and evidence question consistent business
definitions, explicitly names the current stage, and separates classification
from approval. Native OpenAI choices now use the six real lane names. The adapter
maps those labels to historical compatibility keys without changing native
probabilities; raw native labels/distributions remain in diagnostics. Direct
conversation and sender attribution precede the storage context in the input.

| Evidence | Supported proposal |
| --- | --- |
| Own unanswered enquiry/follow-up; only ok/thanks/emoji | Keep To be started |
| Recipient interested, asks for details/pricing/docs, or engineering review | Work in progress |
| Actual implementation, pilot or testing underway | Integrations |
| Real blocking technical/payment/agreement dependency | Blocked |
| Blocker resolved and review/testing resumes | Work in progress / Integrations as evidenced |
| Explicit discontinuation or deliberate parking | Archived |
| Renewed evaluation after archiving | Work in progress |
| Achieved live production or agreed partnership/co-marketing outcome | Completed |
| Buyer ID alone, future testing/go-live/campaign, silence | No inferred advance/completion/archive |
| New explicit production outage after completion | Blocked; routine follow-ups do not regress completion |

Every proposed change still requires current business evidence (support >=0.90),
a dominant native lane (selected probability >=0.85, confidence >=0.80, margin
>=0.20), valid source identities/versions and business relevance. Company
identity matching keeps its >=0.90 distribution threshold. These numeric gates
are application policy, not a claim that model probabilities are calibrated.
No value is rounded up. Low-confidence/unsupported decisions remain uncertain,
now with the rejected gate identified in the stored reason. A source older than
every cited AntSeed message cannot satisfy the initial recipient-response guard.

The canonical replay endpoint/tool adds `includeCompletedDecisions: true`,
requiring one explicit `chatId`. It requeues only that chat's latest completed
decision with current policy/mapping/message snapshots, retains its extraction
checkpoint, and uses command idempotency. It does not approve or apply a move.
Existing pending proposals and notification intent remain deduplicated.

## Evidence

- Six representative live synthetic baseline checks all failed to produce the
  expected proposal. Intermediate changes and failures were retained in local
  `/tmp/antseed-lane-{baseline,repair-initial,repair-literal,matrix-v3,canonical-labels}.json`.
- Final **47/47** real GPT-6 Luna calls matched the authored business expectations
  across all six lanes. English/Hindi/Hinglish; interest, review, actual/future
  testing, negation, achieved/promised outcomes, blockers/resumption,
  archive/reopen, prior completion, silence, internal/forwarded/deleted/uncited
  messages, old social replies and prompt injection are covered.
- [Committed sanitized live results](../tests/fixtures/lane-evaluation-20261017.json)
  retain the exact native-derived lane distributions, support and request IDs.
- [Scenario sources](../tests/intelligence/lane-scenarios.ts) are synthetic;
  [the opt-in evaluator](../tests/intelligence/lane-scenarios-live.ts) uses actual
  Decisions calls and never connects to Telegram, PostgreSQL or Vikunja.
- Source/confidence unit regressions and all-six-target SQL notification-intent
  tests cover pending-only proposals, one outbox intent, repeated recovery and
  zero mutations before approval. Authored responses/SQL fixtures are not
  additional live model or Telegram evidence.
- Final bounded suite: **424 passed / 144 explicit opt-in skipped** across 64
  files; strict TypeScript and production build passed. The skipped native
  integration suites are not claimed as new passes.

## Personal deployment readback

Rebuilt and recreated only `antseed-personal`'s backend; its PostgreSQL/Vikunja
services and all volumes were retained. Running image:
`sha256:99a4d3e1da7472d82e3aa94224e1a79755e063407f7a214a2ac97b7169ff54a4`.
All eight reported service components recovered to ready.

One explicitly scoped canonical replay queued the affected chat's latest
completed job. Real extraction/native v3 decision completed at
2026-10-17T16:17:54Z: selected Work in progress probability/confidence 0.99,
business-stage support 1. The real proposal remains pending/not_requested;
the configured Approvals group's outbox receipt is sent, message ID 2, one
attempt, no error. Native Vikunja readback and local SQL agreed task 1 remained
To be started/stageVersion 0; the mutation journal had zero rows. No approval,
direct stage write, company-chat send, additional group creation, or other chat
replay was performed. These are actual personal runtime/Telegram receipt
observations, separately from the synthetic model matrix above.

This is a bounded evaluation, not exhaustive natural-language accuracy. The 35
independent original relationship fixtures remain unchanged. Dates/contact
validation and journal/approval safeguards continue to run in the regular suite.
The native question/answer format was checked against the
[official Decisions reference](https://developers.openai.com/api/reference/resources/decisions/methods/create).

To run the paid synthetic check explicitly:

```sh
LANE_EVAL_OUTPUT=/tmp/antseed-lane-eval.json \
  npx tsx tests/intelligence/lane-scenarios-live.ts
```

Set `LANE_EVAL_CASES` to comma-separated scenario IDs for a bounded subset. Keys
are loaded privately through the existing runtime config; never shell-source the
AI file. Live test results do not establish Telegram notification delivery;
that requires actual control-outbox receipt readback on the configured group.
