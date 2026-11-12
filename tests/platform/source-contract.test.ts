import { afterEach, describe, expect, it } from 'vitest';
import { OutreachRepository } from '../../src/outreach/repository.js';
import { counterpartyTitle, cleanSubject, emailThreadSchema } from '../../src/email/ingest.js';
import { sourceLabel } from '../../src/outreach/card-format.js';
import { fixtureDatabase } from '../workflow/database.js';

// Every source adds a chat whose title is the counterparty; the shared pipeline builds the card.
// To add a source, append a sample here: this test then holds it to the same card standard.
const email = (extra = {}) => emailThreadSchema.parse({ mailbox: 'me@antseed.com', threadKey: 't', subject: 'Re: Fwd: Cedar integration',
  messages: [{ messageKey: 'm', from: { email: 'riya@cedar.com', name: 'Riya Shah' }, sentAt: '2026-11-01T09:00:00Z', body: 'Hello' }], ...extra });
// A source names its chat after the counterparty: the company when known, else the person.
const sources = [
  { name: 'telegram direct chat', expected: 'Cedar', chat: { id: '1009', kind: 'user', title: 'Cedar' } },
  { name: 'email thread', expected: 'Cedar', chat: { id: '-4000000000000000001', kind: 'email', title: counterpartyTitle(email()) } },
];

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const db = await fixtureDatabase([new URL('../../db/migrations/202610250001_outreach_core.sql', import.meta.url), new URL('../../db/migrations/202610260002_stable_outreach_sources.sql', import.meta.url)]);
  cleanup.push(() => db.close());
  return { db, repo: new OutreachRepository(db, { now: () => new Date('2026-11-01T12:00:00Z') }) };
}
async function card(h: Awaited<ReturnType<typeof fixture>>, chat: { id: string; kind: string; title: string }) {
  await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES($1,$2,$3,'included')", [chat.id, chat.kind, chat.title]);
  await h.db.query("INSERT INTO tickets(chat_id,kind) VALUES($1,'contact_prospect')", [chat.id]);
  await h.db.query(`INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state,decided_message_id,decided_at)
    VALUES($1,0,'approved',-1001,5,'sent',6,now())`, [chat.id]);
  await h.repo.reconcileChat(chat.id);
  return (await h.repo.list({})).items.find((i) => i.displayName === chat.title || i.displayName.includes(chat.title))!;
}

describe('every source builds the same kind of card', () => {
  it.each(sources)('$name: named after the counterparty company, unplaced prospect with the standard fields', async ({ chat, expected }) => {
    const h = await fixture(); const c = await card(h, chat);
    expect(c.displayName).toBe(expected);
    expect(c).toMatchObject({ kind: 'contact_prospect', companyId: null, acceptedStage: null });
    expect(c.nextStep).toMatch(/^Next: Review initial placement · ETA: /);
  });
  it('all sources produce cards with exactly the same fields', async () => {
    const shapes: string[][] = [];
    for (const { chat } of sources) { const h = await fixture(); shapes.push(Object.keys(await card(h, chat)).sort()); }
    expect(shapes[1]).toEqual(shapes[0]);
  });
  it.each([
    { ...sources[0]!, link: 'tg://openmessage?user_id=1009', chatKind: 'user', label: 'Telegram' },
    { ...sources[1]!, link: null, chatKind: 'email', label: 'email thread' },
  ])('$name: opens and labels its source truthfully (no Telegram link for non-Telegram sources)', async ({ chat, link, chatKind, label }) => {
    const h = await fixture(); const c = await card(h, chat);
    const source = (await h.repo.get(c.id)).activeSources.concat((await h.repo.get(c.id)).pendingSources)[0]!;
    expect(source).toMatchObject({ telegramUrl: link, chatKind });
    expect(sourceLabel(source)).toBe(label);
  });
  it('a placed or edited card is never renamed by a later rebuild', async () => {
    const h = await fixture(); const c = await card(h, sources[1]!.chat);
    await h.db.query("UPDATE outreach_relationships SET display_name='Edited by a person',identity_version=1 WHERE id=$1", [c.id]);
    await h.db.query('UPDATE chats SET title=$2 WHERE id=$1', [sources[1]!.chat.id, 'Someone Else']);
    await h.repo.reconcileChat(sources[1]!.chat.id);
    expect((await h.repo.list({})).items[0]!.displayName).toBe('Edited by a person');
  });
});

describe('email counterparty title: company first, then person, then address', () => {
  const msg = (from: string, name?: string, extra = {}) => ({ messageKey: 'm', from: { email: from, ...(name ? { name } : {}) }, sentAt: '2026-11-01T09:00:00Z', body: '', ...extra });
  const one = (from: string, name?: string, subject = 'Intro', known: { name: string; domains: string[] }[] = []) =>
    counterpartyTitle(email({ subject, messages: [msg(from, name)] }), known);
  it('names the company from the sender domain, using the subject casing when it has one', () => {
    expect(one('anna@chatprd.ai', 'Anna Lee', 'ChatPRD: Comparing inference providers')).toBe('ChatPRD');
    expect(one('riya@cedar.com', 'Riya Shah')).toBe('Cedar');
    expect(one('x@mail.wynd.xyz', 'X')).toBe('Wynd');
    expect(one('a@acme.co.uk')).toBe('Acme');
  });
  it('prefers the directory spelling when a company owns the domain; two owners is ambiguous, so the person is used', () => {
    expect(one('sam@hedra.com', 'Sam', 'Intro', [{ name: 'Hedra Labs', domains: ['Hedra.com'] }])).toBe('Hedra Labs');
    expect(one('sam@hedra.com', 'Sam', 'Intro', [{ name: 'A', domains: ['hedra.com'] }, { name: 'B', domains: ['hedra.com'] }])).toBe('Sam');
  });
  it('uses the person, then the address, for free-mail and our own domain', () => {
    expect(one('jo@gmail.com', 'Jo Park')).toBe('Jo Park');
    expect(one('jo@gmail.com')).toBe('jo@gmail.com');
    expect(one('teammate@antseed.com', 'Team Mate')).toBe('Team Mate');
  });
  it('titles our own outbound mail after the recipient\'s company, and never the mailbox', () => {
    expect(counterpartyTitle(email({ messages: [msg('ME@antseed.com', undefined, { to: [{ email: 'lena@celo.org', name: 'Lena H' }] })] }))).toBe('Celo');
  });
  it('falls back to the subject without Re:/Fwd: prefixes', () => {
    expect(counterpartyTitle(email({ messages: [msg('me@antseed.com')] }))).toBe('Cedar integration');
    expect(cleanSubject('RE: re: Fwd: Hedra <> Ant Seed | intro')).toBe('Hedra Ant Seed | intro');
  });
});
