# Fathom contract fixture

`fathom-meeting.json` is synthetic data authored from Fathom's published
[List meetings contract](https://developers.fathom.ai/api-reference/meetings/list-meetings)
and [webhook guide](https://developers.fathom.ai/webhooks), checked 26 October 2026.
It contains no private recordings. Recording links are illustrative.

Fathom supplies transcript segments, a Markdown summary and action items with
assignees, completion state and recording timestamps. Its documented action-item
payload has no stable action ID or due-date field. Tests must not invent either
as upstream guarantees. A meeting is identified by `recording_id`, independently
of its title or start time. Optional content can be missing or null.
