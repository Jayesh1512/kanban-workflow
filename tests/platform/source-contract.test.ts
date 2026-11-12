import { afterEach, describe, expect, it } from 'vitest';
import { OutreachRepository } from '../../src/outreach/repository.js';
import { counterpartyTitle, cleanSubject, emailThreadSchema } from '../../src/email/ingest.js';
import { fixtureDatabase } from '../workflow/database.js';

// Every source adds a chat whose title is the counterparty; the shared pipeline builds the card.
// To add a source, append a sample here: this test then holds it to the same card standard.
const email = (extra = {}) => emailThreadSchema.parse({ mailbox: 'me@antseed.com', threadKey: 't', subject: 'Re: Fwd: Cedar integration',
  messages: [{ messageKey: 'm', from: { email: 'riya@cedar.com', name: 'Riya Shah' }, sentAt: '2026-11-01T09:00:00Z', body: 'Hello' }], ...extra });
const sources = [
  { name: 'telegram direct chat', chat: { id: '1009', kind: 'user', title: 'Riya Shah' } },
  { name: 'email thread', chat: { id: '-4000000000000000001', kind: 'email', title: counterpartyTitle(email()) } },
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
  it.each(sources)('$name: named after the counterparty, unplaced prospect with the standard fields', async ({ chat }) => {
    const h = await fixture(); const c = await card(h, chat);
    expect(c.displayName).toBe('Riya Shah');
    expect(c).toMatchObject({ kind: 'contact_prospect', companyId: null, acceptedStage: null });
    expect(c.nextStep).toMatch(/^Next: Review initial placement · ETA: /);
  });
  it('all sources produce cards with exactly the same fields', async () => {
    const shapes: string[][] = [];
    for (const { chat } of sources) { const h = await fixture(); shapes.push(Object.keys(await card(h, chat)).sort()); }
    expect(shapes[1]).toEqual(shapes[0]);
  });
  it('a placed or edited card is never renamed by a later rebuild', async () => {
    const h = await fixture(); const c = await card(h, sources[1]!.chat);
    await h.db.query("UPDATE outreach_relationships SET display_name='Edited by a person',identity_version=1 WHERE id=$1", [c.id]);
    await h.db.query('UPDATE chats SET title=$2 WHERE id=$1', [sources[1]!.chat.id, 'Someone Else']);
    await h.repo.reconcileChat(sources[1]!.chat.id);
    expect((await h.repo.list({})).items[0]!.displayName).toBe('Edited by a person');
  });
});

describe('email counterparty title', () => {
  it('uses the other person, by name, else address; never the mailbox', () => {
    expect(counterpartyTitle(email())).toBe('Riya Shah');
    expect(counterpartyTitle(email({ messages: [{ messageKey: 'm', from: { email: 'riya@cedar.com' }, sentAt: '2026-11-01T09:00:00Z', body: '' }] }))).toBe('riya@cedar.com');
  });
  it('our own outbound mail is titled after the recipient', () => {
    expect(counterpartyTitle(email({ messages: [{ messageKey: 'm', from: { email: 'ME@antseed.com' }, to: [{ email: 'lena@celo.org', name: 'Lena H' }], sentAt: '2026-11-01T09:00:00Z', body: '' }] }))).toBe('Lena H');
  });
  it('falls back to the subject without Re:/Fwd: prefixes', () => {
    expect(counterpartyTitle(email({ messages: [{ messageKey: 'm', from: { email: 'me@antseed.com' }, sentAt: '2026-11-01T09:00:00Z', body: '' }] }))).toBe('Cedar integration');
    expect(cleanSubject('RE: re: Fwd: Hedra <> Ant Seed | intro')).toBe('Hedra Ant Seed | intro');
  });
});
