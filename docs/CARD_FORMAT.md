# Kanban card format

Titles show **Company or person — AntSeed's next action**. For example,
`Cedar Labs — Send pricing` or `Harsh — Follow up`. A sourced company name
replaces the contact prospect identity on the same card when it becomes known.

The description uses Vikunja's native rich-text HTML, with these sections:

- At a glance: company/person, conversation, current stage, workstream, next action, follow-up and ETA.
- Next action and relationship summary.
- Contacts: names, company roles, affiliation, Telegram handles, emails and visible phone numbers.
- AntSeed tasks and external commitments in separate lists.
- Deadlines with owners, lifecycle state, original date wording, timezone and precision.
- Blockers, open questions and tasks whose owner is unconfirmed.
- Captured conversation activity, completed items, company details and source references.

An explicit manual next action takes precedence. Otherwise open AntSeed actions
and commitments supply the title; external promises and completed tasks do not.
A prospect awaiting a captured reply defaults to **Follow up** when no specific
AntSeed task is recorded. Completed, Archived and Blocked have appropriate
fallbacks. Missing deadlines remain **Not set**; ambiguous dates stay unresolved.
Relative dates from task evidence are kept in the dated detail section rather
than presented as a perpetually new “tomorrow” in the title.

The projector pages through all current facts and company contacts and includes
older evidence referenced by those facts. It does not truncate the whole
description at the old 24,000-character boundary. Text and URLs are escaped;
message/model content cannot supply executable HTML.

The same renderer handles initial projection and later refreshes. Formatting
uses the existing ticket lock and descriptive Merge Patch; it does not decide
proposals, move lanes or alter deadlines. Deleted upstream cards are not
recreated. Failed refresh entries advance fairly without overwriting a newer
projection result, so deleted cards cannot starve updates to other cards.

Validation: `tests/workflow/card-format.test.ts` covers outbound follow-up,
manual precedence, owner separation, contact upgrades, date precision,
escaping, complete task pagination, preservation and refresh-queue recovery.

The 23 October 2026 deployment refreshed and verified all 38 visible cards.
Before/after comparison confirmed unchanged business records, lanes, labels,
positions, deadlines and approvals; six soft-deleted cards remained unchanged.
Native Vikunja rendering was checked for the title and rich-text section
headings. The release suite passed 566 tests, with 157 external-integration
tests explicitly skipped; typechecking and the production Docker build passed.
