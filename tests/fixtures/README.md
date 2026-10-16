# Synthetic relationship conversations

`relationship-cases.json` contains 35 independent semantic cases for [QA_PLAN.md](../../docs/QA_PLAN.md). All people, companies, numeric Telegram-like IDs, conversations and `.invalid` addresses are invented. AntSeed is the required internal-team name. No account connection, provider call or external message is needed to read these fixtures. Passing these cases cannot prove live Telegram, Jev, Vikunja or Nous Hermes behavior.

This is a QA data format, not a product schema, API contract, MCP catalog or model response. Adapt it to the architect's committed contracts later; preserve the independent expectations and report any disputed semantics rather than deriving the oracle from production code.

- `seed_evidence`, `companies` and `participants` are explicit synthetic setup facts. Known affiliation comes from these facts or explicit statements, never group membership. Every case uses the one fictional `account_fixture_id`; do not load into a real account dataset.
- Each case supplies a stable `chat_id`, ordered source events and context. Message identity is `(account_fixture_id, chat_id, message_id)`, so repeated message ID `101` in different chats is intentional. Revisions of one message keep its ID and original `sent_at`; `observed_at` models delivery/import/edit/delete observation. `evidence_id` is globally unique for each source revision. A deletion has `text: null` and cannot restore its earlier claim.
- Context is pre-existing setup, including lane/workstream, mapping, prior proposal and participant identity. Case timestamps are fixed; delayed evaluation is intentional. Seeded tickets already exist where `ticket_exists` is true. Unresolved/ambiguous cases have no ticket and must not fabricate one. Cases 026/027 are the one linked pair: evaluate together to verify two chat tickets with one company/contact directory; all other cases reset state independently.
- `expected` is a semantic oracle: supported movement, forbidden targets, mapping/candidates, evidence, uncertainty and optional contact/date/action checks. `relevant` concerns the relationship, not mere mention of a company. `propose` means a durable suggestion only; `no_change` means no supported lane change; `uncertain` means insufficient reliable evidence to select a movement. Empty `uncertainty` lists no additional ambiguity required by the fixture, rather than asserting universal model confidence. `null` means unknown/not applicable, never permission to invent a value. No exact model wording, numeric confidence threshold or product field name is prescribed.
- Every case has no approval and requires `board_must_remain_unchanged_before_approval: true`, zero automatic lane writes, the unchanged `lane_after_analysis`, and zero external messages. Even a supported Completed/Archived proposal cannot move/delete a ticket. Historical proposals in edit/delete cases remain unapproved and become stale; their invalidated evidence is not current support.
- Dates use Asia/Kolkata and original message time. At `2026-10-17T18:29:00Z` local time is Oct 17 23:59; tomorrow is Oct 18. At `18:31:00Z` local time is Oct 18 00:01; tomorrow is Oct 19. Exact local 10:00 resolves to 04:30 UTC. Ambiguous `कल` remains unresolved; date-only commitments retain a date without an invented time or UTC instant. Punctuation-only edits do not reset a commitment's original timestamp.

Coverage: 001–003 future engineering review; 004–006 actual testing; 007–009 and 016 negation; 010–012 blocker/approved resumption; 013–014 buyer ID without usage; 015 live agreed outcome; 017–018 completed versus promised co-marketing; 019–020 explicit archive versus silence; 021–022 incidental/forwarded company mentions; 023–024 aliases/domain and ambiguous mapping; 025 internal/external/unknown participants; 026–027 shared contacts and distinct chat tickets; 028 and 034 source edit/delete invalidation; 029–032 original-message-relative IST dates, ambiguity and delayed processing; 033 untrusted approval instructions; 035 date-only granularity. Each case also carries machine-checkable coverage tags.

From the repository root, validate structure and coverage without importing product code:

```sh
python3 -m json.tool tests/fixtures/relationship-cases.json >/dev/null
python3 - <<'PY'
import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

d = json.loads(Path('tests/fixtures/relationship-cases.json').read_text())
cs = d['cases']
assert d['synthetic'] is True and len(cs) >= 20
assert d['lanes_in_order'] == ['To be started', 'Work in progress', 'Integrations', 'Blocked', 'Archived', 'Completed']
assert d['workstreams'] == ['Buyer', 'Provider', 'Integration', 'Others']
assert len({c['case_id'] for c in cs}) == len(cs)
assert len({c['chat']['chat_id'] for c in cs}) == len(cs)
assert {c['language'] for c in cs} >= {'en', 'hi', 'hinglish'}
tags = {t for c in cs for t in c['coverage_tags']}
required = {'engineering_review', 'actual_testing', 'negation', 'blocker', 'resumption', 'buyer_id_without_usage', 'live_use', 'co_marketing', 'explicit_archive', 'silence', 'incidental_company', 'forwarded_company', 'alias_domain', 'ambiguous_mapping', 'internal_external', 'shared_contacts', 'source_edit', 'source_delete', 'relative_date', 'ist_before_midnight', 'ist_after_midnight', 'ambiguous_date', 'date_only', 'approval_invariant'}
assert required <= tags, required - tags
seeds = {x['evidence_id'] for x in d['seed_evidence']}
eids = [m['evidence_id'] for c in cs for m in c['messages']]
assert len(seeds) == len(d['seed_evidence'])
assert len(eids) == len(set(eids)) and not seeds.intersection(eids)
people = {p['participant_id'] for p in d['participants']}
companies = {c['company_id'] for c in d['companies']}
def refs(x, allowed):
    if isinstance(x, dict):
        for k, v in x.items():
            if k == 'evidence_ids' or k.endswith('_evidence_ids'):
                assert set(v) <= allowed, (k, v)
            else:
                refs(v, allowed)
    elif isinstance(x, list):
        for v in x:
            refs(v, allowed)
for c in cs:
    ctx, e = c['context'], c['expected']
    local_ids = {m['evidence_id'] for m in c['messages']}
    refs(c, seeds | local_ids)
    assert set(ctx['participant_ids']) <= people
    assert set(ctx['company_mapping']['company_ids']) <= companies
    assert ctx['current_lane'] in [None] + d['lanes_in_order']
    assert ctx['current_workstream'] in [None] + d['workstreams']
    assert ctx['ticket_exists'] == (ctx['current_lane'] is not None)
    assert e['board_must_remain_unchanged_before_approval'] is True
    assert e['automatic_lane_write_count'] == e['outbound_external_messages'] == 0
    assert e['lane_after_analysis'] == ctx['current_lane']
    assert set(e['evidence_ids']).isdisjoint(e.get('invalidated_evidence_ids', []))
    move = e['movement']
    assert move['kind'] in {'propose', 'no_change', 'uncertain'}
    assert move['target_lane'] in [None] + d['lanes_in_order']
    assert (move['target_lane'] is not None) == (move['kind'] == 'propose')
    assert move['target_lane'] not in move['forbidden_targets']
    seen = set()
    for m in c['messages']:
        key = (m['message_id'], m['revision'])
        assert key not in seen and m['sender_id'] in people
        seen.add(key)
        assert datetime.fromisoformat(m['sent_at']) <= datetime.fromisoformat(m['observed_at']) <= datetime.fromisoformat(ctx['evaluated_at'])
    for date in e['dates']:
        source = next(m for m in c['messages'] if m['message_id'] == date['anchor_message_id'])
        assert date['anchor_sent_at'] == source['sent_at']
        if date['granularity'] == 'date':
            assert date['local_time'] is None and date['instant'] is None
        else:
            dt = datetime.fromisoformat(date['instant']).astimezone(ZoneInfo(date['timezone']))
            assert dt.date().isoformat() == date['local_date'] and dt.time().isoformat() == date['local_time']
print('PASS:', len(cs), 'cases;', len(eids), 'unique source revisions;', dict(Counter(c['language'] for c in cs)))
PY
```

Before committing, privately compare fixture bytes with nonempty secret values from the configured private env; report only a pass/fail or match count, never the values. This validation is fixture QA, not a product test or upstream/live success claim.
