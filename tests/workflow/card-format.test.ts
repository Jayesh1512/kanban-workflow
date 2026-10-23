import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { cardDate, formatCard, type CardContext } from '../../src/workflow/card-format.js';
import { inputFixture, extractionFixture, jobId } from '../intelligence/fixtures.js';
import { workflowHarness } from './harness.js';

function context(): CardContext {
  const input = inputFixture(), extraction = extractionFixture();
  return { chat: input.chat, messages: input.messages, evidence: input.evidence,
    ticket: { id: randomUUID(), chatId: input.chat.id, kind: 'company', companyId: 'cedar', vikunjaTaskId: '42', lane: 'To be started', stageVersion: 0, previousActiveLane: null, workstream: 'Buyer', summary: 'API partnership discussion.', nextAction: null, followUpAt: null, etaAt: null, latestSubstantiveAt: null, blockers: [], contactIds: [], evidenceIds: [], actionsVersion: 0, actionsSource: 'inferred', trackingState: 'active' },
    company: { id: 'cedar', canonicalName: 'Cedar Labs', aliases: ['Cedar'], domains: ['cedar.example'], workstream: 'Buyer', summary: '', buyerIds: ['buyer-1'], providerIds: [], evidenceIds: [], version: 1 },
    contacts: [{ id: 'mira', telegramUserIds: ['7'], names: ['Mira'], usernames: ['mira'], phones: ['+11111111111'], emails: ['mira@cedar.example'], affiliation: 'external', evidenceIds: [], version: 1, roles: [{ contactId: 'mira', companyId: 'cedar', role: 'CTO', evidenceIds: [] }] }],
    facts: [{ ...extraction.facts[0]!, id: randomUUID(), version: 1, source: 'inferred', answersFactId: null }],
    outreach: { accountSelfId: '99', coverage: 'captured_messages', initiatedBy: 'antseed', lastOutgoingAt: '2026-10-17T12:00:00Z', lastIncomingAt: null, waitingForReply: true } };
}

it('leads with company and our sourced action, with structured contacts, tasks, dates and references', () => {
  const card = formatCard(context());
  expect(card.title).toBe('Cedar Labs — Send notes');
  for (const heading of ['At a glance', 'Contacts', 'Tasks for AntSeed', 'Waiting on the other party', 'Deadlines &amp; dates', 'Blockers', 'Sources &amp; references']) expect(card.description).toContain(`<h2>${heading}</h2>`);
  for (const detail of ['Mira', 'CTO', '@mira', '+11111111111', 'mira@cedar.example', '2026-10-18', 'date only', 'buyer-1']) expect(card.description).toContain(detail);
  expect(card.description).not.toContain('18 Oct 2026, 00:00');
});
it('uses Follow up for the first outbound unknown-company prospect without inventing a deadline', () => {
  const input = context(); input.company = null; input.chat.title = 'Harsh'; input.ticket.kind = 'contact_prospect'; input.ticket.companyId = null; input.facts = [];
  const card = formatCard(input);
  expect(card.title).toBe('Harsh — Follow up'); expect(card.description).toContain('Not identified yet'); expect(card.description).toContain('No follow-up deadline is assumed');
});
it('upgrades the identity on the same card and uses the manually set action first', () => {
  const input = context(); input.ticket.actionsSource = 'manual'; input.ticket.nextAction = 'Send the revised agreement';
  expect(formatCard(input).title).toBe('Cedar Labs — Send the revised agreement');
  input.company!.canonicalName = 'Cedar Network'; expect(formatCard(input).title).toBe('Cedar Network — Send the revised agreement');
});
it.each([
  ['Amos asks the reporting user to share logs with @kotevcode. Log submission is not confirmed.', 'Share logs with @kotevcode'],
  ['Ravi requested that Piyush append the pointers to the document. No confirmation is available.', 'Append the pointers to the document'],
  ['AntSeed will not send credentials until the agreement is signed.', 'Not send credentials until the agreement is signed'],
  ['AntSeed will not send credentials until the partner will confirm the agreement.', 'Not send credentials until the partner will confirm the agreement'],
])('turns reported task wording into a brief action while retaining restrictions: %s', (source, expected) => {
  const input = context(); input.facts[0]!.text = source;
  expect(formatCard(input).title).toBe(`Cedar Labs — ${expected}`);
});
it('keeps an external promise out of our title and separates unknown ownership and resolved tasks', () => {
  const input = context(), fact = input.facts[0]!; fact.actor = { party: 'external', contactId: 'mira', displayName: 'Mira' }; fact.text = 'Mira will send logs';
  input.facts.push({ ...fact, id: randomUUID(), actor: { party: 'unknown', contactId: null, displayName: null }, text: 'Confirm the owner' });
  input.facts.push({ ...fact, id: randomUUID(), actor: { party: 'antseed', contactId: null, displayName: 'AntSeed' }, state: 'completed', text: 'Send old pricing' });
  const card = formatCard(input); expect(card.title).toBe('Cedar Labs — Follow up');
  expect(card.description.split('<h2>Tasks for AntSeed</h2>')[1]!.split('<h2>Waiting on')[0]).not.toContain('Mira will send logs');
  expect(card.description).toContain('Owner unconfirmed'); expect(card.description.split('<h2>Completed &amp; closed items</h2>')[1]).toContain('Send old pricing');
});
it.each(['Completed', 'Archived', 'Blocked'] as const)('uses an appropriate %s fallback instead of an outreach follow-up', lane => {
  const input = context(); input.facts = []; input.ticket.lane = lane;
  expect(formatCard(input).title).toBe(`Cedar Labs — ${lane === 'Blocked' ? 'Resolve blocker' : lane}`);
});
it('retains negation, ambiguous dates, exact instants, and actual timezones', () => {
  const input = context(); input.facts[0]!.text = 'Do not send credentials until the agreement is signed';
  expect(formatCard(input).title).toContain('Do not send credentials');
  const date = input.facts[0]!.dates[0]!;
  expect(cardDate({ ...date, originalText: 'kal', precision: 'unresolved', localDate: null, ambiguous: true })).toContain('unresolved; clarification needed');
  expect(cardDate({ ...date, precision: 'instant', localDate: null, resolvedAt: '2026-10-18T04:30:00Z' })).toContain('10:00');
});
it('escapes all text and refuses executable source links while retaining readable evidence', () => {
  const input = context(); input.company!.canonicalName = '<script>alert(1)</script>'; input.contacts[0]!.names = ['<img onerror=alert(1)>'];
  input.evidence[0]!.excerpt = 'Use <b>markup</b> & "quotes"'; input.evidence[0]!.sourceUrl = 'javascript:alert(1)';
  const card = formatCard(input);
  expect(card.description).not.toMatch(/<script|<img|href="javascript:/); expect(card.description).toContain('&lt;b&gt;markup&lt;/b&gt;');
  expect(card.description).toContain('&lt;img onerror=alert(1)&gt;');
});
it('keeps all distinct task details beyond the former description cap and does not mutate domain input', () => {
  const input = context(); const original = input.facts[0]!;
  input.facts = Array.from({ length: 205 }, (_, i) => ({ ...original, id: randomUUID(), text: `Task ${i}: ${'sourced details '.repeat(15)}` }));
  const before = JSON.stringify(input), card = formatCard(input);
  expect(card.description.length).toBeGreaterThan(24000); expect(card.description).toContain('Task 204:'); expect(card.description.endsWith('</p>')).toBe(true); expect(JSON.stringify(input)).toBe(before);
});
it('reformats an existing remote card, pages past 200 facts and preserves card ID, stage and approvals', async () => {
  const h = await workflowHarness();
  try {
    await h.projector.project(h.ticket.id); const task = (await h.records.getTicket(h.ticket.id)).vikunjaTaskId!;
    const existing = [...h.tasks.values()][0]!; existing.description = 'Old unformatted card';
    await h.db.query('DELETE FROM app_settings WHERE key=$1', [`workflow:projection:${h.ticket.id}`]);
    await h.db.query(`INSERT INTO facts(job_id,ticket_id,kind,text,actor_party,state,source) SELECT $2,$1,'action','Manual task '||n,'antseed','open','manual' FROM generate_series(1,205) n`, [h.ticket.id, jobId]);
    await h.records.createContact({ idempotencyKey: 'other-company-contact', names: ['Jo'], telegramUserIds: [], usernames: ['jo'], phones: [], emails: ['jo@cedar.example'], affiliation: 'external', evidenceIds: [h.evidenceId], roles: [{ companyId: h.ticket.companyId!, role: 'Engineering lead', evidenceIds: [h.evidenceId] }] });
    const proposal = await h.propose();
    const before = await h.records.getTicket(h.ticket.id);
    await h.projector.project(h.ticket.id);
    const remote = (await h.vikunja.getTask(task))!;
    expect(remote.description).toContain('Manual task 205'); expect(remote.description).toContain('<h2>Contacts</h2>');
    expect(new Set(remote.description.match(/Manual task \d+/g)).size).toBe(205);
    expect(remote.description).toContain('jo@cedar.example'); expect(remote.description).toContain('Engineering lead');
    expect(await h.records.getTicket(h.ticket.id)).toEqual(before);
    expect((await h.proposals.list({ ticketId: h.ticket.id })).items.find(p => p.id === proposal.id)?.decision).toBe('pending');
    expect(h.moves()).toBe(0);
  } finally { await h.db.close(); }
}, 20_000);
it('rotates an already projected but deleted remote card out of the refresh queue head without recreating it', async () => {
  const h = await workflowHarness();
  try {
    await h.projector.project(h.ticket.id); h.tasks.clear();
    const before = (await h.db.query('SELECT updated_at::text AS stamp FROM app_settings WHERE key=$1', [`workflow:projection:${h.ticket.id}`])).rows[0]!.stamp;
    expect(await h.projector.projectBatch(1)).toBe(0);
    const saved = (await h.db.query('SELECT value,updated_at>$2::timestamptz AS advanced FROM app_settings WHERE key=$1', [`workflow:projection:${h.ticket.id}`, before])).rows[0]!;
    expect(saved.value).toMatchObject({ state: 'remote_unknown', code: 'conflict' }); expect(saved.advanced).toBe(true);
    expect(h.tasks.size).toBe(0); expect(h.moves()).toBe(0);
  } finally { await h.db.close(); }
});
it('never lets a failed old projection overwrite a newer ready result', async () => {
  const h = await workflowHarness();
  try {
    await h.projector.project(h.ticket.id);
    vi.spyOn(h.vikunja, 'getTask').mockImplementation(async () => {
      await h.db.query(`UPDATE app_settings SET value='{"state":"ready","hash":"newer-owner"}'::jsonb,updated_at=now() WHERE key=$1`, [`workflow:projection:${h.ticket.id}`]);
      throw new Error('Controlled old callback failure');
    });
    await h.projector.projectBatch(1);
    expect((await h.db.query('SELECT value FROM app_settings WHERE key=$1', [`workflow:projection:${h.ticket.id}`])).rows[0]!.value).toEqual({ state: 'ready', hash: 'newer-owner' });
  } finally { await h.db.close(); }
});
