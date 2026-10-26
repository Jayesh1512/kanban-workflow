import { afterEach, describe, expect, it } from 'vitest';
import { OutreachRepository } from '../../src/outreach/repository.js';
import { SALES_STAGES } from '../../src/shared/outreach-domain.js';
import { fixtureDatabase } from '../workflow/database.js';

const company = '00000000-0000-4000-8000-000000000101';
const person = '00000000-0000-4000-8000-000000000102';
const evidence = '00000000-0000-4000-8000-000000000103';
const fact = '00000000-0000-4000-8000-000000000104';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
export async function outreachFixture() {
  const db = await fixtureDatabase([new URL('../../db/migrations/202610250001_outreach_core.sql', import.meta.url), new URL('../../db/migrations/202610260002_stable_outreach_sources.sql', import.meta.url)]);
  const repo = new OutreachRepository(db, { now: () => new Date('2026-10-25T12:00:00Z') });
  return { db, repo };
}
async function setup() {
  const h = await outreachFixture(); cleanup.push(() => h.db.close());
  await h.db.query('INSERT INTO companies(id,canonical_name) VALUES($1,\'Cedar Fixture\')', [company]);
  await h.db.query("UPDATE chats SET mapping_status='confirmed',company_id=$1 WHERE id=-1001", [company]);
  const ticket = (await h.db.query('INSERT INTO tickets(chat_id,company_id) VALUES(-1001,$1) RETURNING id', [company])).rows[0]!.id as string;
  return { ...h, ticket };
}

describe('persistent commercial read model (actual local PostgreSQL engine, synthetic data)', () => {
  it('adds exactly five sales stages without changing six operational lanes; invalid stages reject', async () => {
    const h = await setup();
    expect((await h.db.query('SELECT label FROM outreach_stage_definitions ORDER BY position')).rows.map((r) => r.label)).toEqual(SALES_STAGES.map((s) => s.label));
    expect((await h.db.query('SELECT name FROM lane_definitions ORDER BY position')).rows.map((r) => r.name)).toEqual(['To be started', 'Work in progress', 'Integrations', 'Blocked', 'Archived', 'Completed']);
    await h.repo.reconcile(); const r = (await h.repo.list({})).items[0]!;
    await expect(h.db.query("UPDATE outreach_relationships SET accepted_stage='Completed' WHERE id=$1", [r.id])).rejects.toThrow();
    expect((await h.db.query('SELECT lane,stage_version FROM tickets')).rows).toEqual([{ lane: 'To be started', stage_version: 0 }]);
  });
  it('groups confirmed company chats; repeated sweep/repository reconstruction retains identity and versions', async () => {
    const h = await setup();
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES(-1002,'supergroup','Cedar second room','included','confirmed',$1)", [company]);
    await h.db.query('INSERT INTO tickets(chat_id,company_id) VALUES(-1002,$1)', [company]);
    await h.repo.reconcile(); const first = (await h.repo.list({})).items;
    expect(first).toHaveLength(1); expect(first[0]).toMatchObject({ sourceCount: 2, pendingSourceCount: 2, acceptedStage: null, displayStage: null, stageBasis: 'unknown' });
    const restarted = new OutreachRepository(h.db, { now: () => new Date('2026-10-25T12:00:00Z') });
    await restarted.reconcile(); expect((await restarted.list({})).items).toEqual(first);
    const detail = await restarted.get(first[0]!.id); expect(detail.activeSources).toEqual([]); expect(detail.pendingSources).toHaveLength(2);
  });
  it('keeps source revisions stable across discovery and board bookkeeping, but detects actual content edits', async () => {
    const h = await setup(); await h.repo.reconcile();
    const before = (await h.repo.list({})).items[0]!;
    const source = (await h.db.query('SELECT source_revision FROM outreach_telegram_inputs')).rows[0]!.source_revision;
    await h.db.query("UPDATE chats SET updated_at=now()+interval '1 hour'");
    await h.db.query("UPDATE tickets SET updated_at=now()+interval '1 hour',vikunja_task_id=42,lane='Completed',stage_version=stage_version+1");
    expect((await h.db.query('SELECT source_revision FROM outreach_telegram_inputs')).rows[0]!.source_revision).toBe(source);
    await h.repo.reconcile();
    expect((await h.repo.get(before.id)).relationship.evidenceRevision).toBe(before.evidenceRevision);
    await h.db.query("UPDATE messages SET text='New business information',version=version+1");
    expect((await h.db.query('SELECT source_revision FROM outreach_telegram_inputs')).rows[0]!.source_revision).not.toBe(source);
  });
  it('prioritizes an unlinked ticket even when the rotating cursor has already passed its chat', async () => {
    const h = await setup(); await h.repo.reconcile();
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-2000,'group','New room','included')");
    await h.db.query("INSERT INTO tickets(chat_id,kind) VALUES(-2000,'contact_prospect')");
    await h.db.query("INSERT INTO app_settings(key,value) VALUES('outreach:reconcile-cursor','{\"after\":\"9000\"}') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
    await h.repo.reconcile(1);
    expect((await h.db.query('SELECT chat_id FROM outreach_source_threads WHERE chat_id=-2000')).rows).toHaveLength(1);
  });
  it('records one broken source and continues linking the rest of the batch', async () => {
    const h = await setup();
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(1009,'user','Healthy contact','included')");
    await h.db.query("INSERT INTO tickets(chat_id,kind) VALUES(1009,'contact_prospect')");
    const reconcile = h.repo.reconcileChat.bind(h.repo);
    h.repo.reconcileChat = async id => { if (id === '-1001') throw new Error('Synthetic source failure'); await reconcile(id); };
    await h.repo.reconcile();
    expect((await h.db.query('SELECT chat_id FROM outreach_source_threads')).rows).toEqual([{ chat_id: 1009 }]);
    expect((await h.db.query("SELECT value FROM app_settings WHERE key='outreach:reconcile-error:-1001'")).rows).toHaveLength(1);
    h.repo.reconcileChat = reconcile;
    await h.db.query("UPDATE app_settings SET value=value||jsonb_build_object('at',now()-interval '6 minutes') WHERE key='outreach:reconcile-error:-1001'");
    await h.repo.reconcile();
    expect((await h.db.query("SELECT value FROM app_settings WHERE key='outreach:reconcile-error:-1001'")).rows).toEqual([]);
  });
  it('retains a prospect UUID when first confirmed company information arrives', async () => {
    const h = await setup();
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(1009,'user','Mira Fixture','included')");
    await h.db.query("INSERT INTO tickets(chat_id,company_id,kind) VALUES(1009,NULL,'contact_prospect')");
    await h.repo.reconcile(); const prospect = (await h.repo.list({})).items.find((r) => r.kind === 'contact_prospect')!;
    const newCompany = '00000000-0000-4000-8000-000000000105';
    await h.db.query("INSERT INTO companies(id,canonical_name) VALUES($1,'New Company Fixture')", [newCompany]);
    await h.db.query("UPDATE chats SET company_id=$1,mapping_status='confirmed',mapping_version=mapping_version+1 WHERE id=1009", [newCompany]);
    await h.db.query("UPDATE tickets SET company_id=$1,kind='company' WHERE chat_id=1009", [newCompany]);
    await h.repo.reconcile(); const renamed = await h.repo.get(prospect.id);
    expect(renamed.relationship).toMatchObject({ id: prospect.id, kind: 'company', displayName: 'New Company Fixture' });
    expect(renamed.pendingSources).toHaveLength(1);
  });
  it('keeps unrelated equal names separate and non-company contexts inspectable without pipeline inference', async () => {
    const h = await setup();
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status) VALUES(1009,'user','Cedar Fixture','included','non_company')");
    await h.db.query("INSERT INTO tickets(chat_id,company_id,kind) VALUES(1009,NULL,'contact_prospect')");
    await h.repo.reconcile(); const all = (await h.repo.list({})).items;
    expect(all).toHaveLength(2); expect(all.every((r) => r.displayStage === null)).toBe(true);
    const internal = all.find((r) => r.kind === 'contact_prospect')!;
    expect((await h.repo.get(internal.id)).suspendedSources).toHaveLength(1);
  });
  it('exclusion hides business data immediately, before reconciliation; reinclude requires pending membership', async () => {
    const h = await setup(); await h.repo.reconcile(); const id = (await h.repo.list({})).items[0]!.id;
    await h.db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE id=-1001");
    expect((await h.repo.list({})).items).toEqual([]);
    const hidden = await h.repo.get(id); expect(hidden.activeSources).toEqual([]); expect(hidden.pendingSources).toEqual([]);
    await h.repo.reconcile(); await h.db.query("UPDATE chats SET inclusion='included' WHERE id=-1001"); await h.repo.reconcile();
    expect((await h.repo.get(id)).pendingSources).toHaveLength(1);
  });
  it('never maps operational Completed to won; fences a saved provisional stage immediately on source edit', async () => {
    const h = await setup(); await h.db.query("UPDATE tickets SET lane='Completed' WHERE id=$1", [h.ticket]); await h.repo.reconcile();
    const id = (await h.repo.list({})).items[0]!.id;
    expect((await h.repo.get(id)).relationship.acceptedStage).toBeNull();
    await h.db.query("UPDATE outreach_relationships SET provisional_stage='qualification',provisional_reason='Synthetic saved assessment',provisional_evidence_revision=evidence_revision,disposition='pipeline' WHERE id=$1", [id]);
    expect((await h.repo.get(id)).relationship).toMatchObject({ displayStage: 'qualification', stageBasis: 'provisional', acceptedStage: null });
    await h.db.query("UPDATE messages SET text='Edited fixture',version=version+1 WHERE chat_id=-1001 AND id=1");
    expect((await h.repo.get(id)).relationship).toMatchObject({ displayStage: null, stageBasis: 'unknown' });
    expect((await h.repo.list({ stage: 'qualification' })).items).toEqual([]);
  });
  it('invalidates the complete provisional assessment when any linked source is excluded, including an empty source set', async () => {
    const h = await setup();
    await h.db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES(-1002,'supergroup','Cedar second room','included','confirmed',$1)", [company]);
    await h.db.query('INSERT INTO tickets(chat_id,company_id) VALUES(-1002,$1)', [company]);
    await h.repo.reconcile(); const id = (await h.repo.list({})).items[0]!.id;
    await h.db.query("UPDATE outreach_relationships SET provisional_stage='negotiation',provisional_reason='Both sources assessed',provisional_evidence_revision=evidence_revision WHERE id=$1", [id]);
    expect((await h.repo.get(id)).relationship.displayStage).toBe('negotiation');
    await h.db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE id=-1002");
    expect((await h.repo.list({ stage: 'negotiation' })).items).toEqual([]);
    expect((await h.repo.get(id)).relationship).toMatchObject({ displayStage: null, stageReason: null, sourceState: 'changed', sourceCount: 1 });
    await h.db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE id=-1001");
    expect((await h.repo.get(id)).relationship).toMatchObject({ displayStage: null, sourceState: 'changed', sourceCount: 0 });
  });
  it('never publishes an unsourced shared-company summary, including after all sources are excluded', async () => {
    const h = await setup();
    await h.db.query("UPDATE companies SET summary='Private claim learned only from excluded source' WHERE id=$1", [company]);
    await h.repo.reconcile(); const r = (await h.repo.list({})).items[0]!;
    expect(r.summary).toBe('');
    await h.db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1 WHERE id=-1001");
    expect((await h.repo.get(r.id)).relationship.summary).toBe('');
    await h.repo.reconcile(); expect((await h.repo.get(r.id)).relationship.summary).toBe('');
  });
  it('reads current sourced contact roles and actor/date-only facts in pending review only', async () => {
    const h = await setup();
    await h.db.query('INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,-1001,1,1,\'Synthetic source\',now())', [evidence]);
    await h.db.query("INSERT INTO contacts(id,names,affiliation) VALUES($1,ARRAY['Mira Fixture'],'external')", [person]);
    await h.db.query('INSERT INTO contact_evidence(contact_id,evidence_id) VALUES($1,$2)', [person, evidence]);
    await h.db.query('INSERT INTO ticket_contacts(ticket_id,contact_id) VALUES($1,$2)', [h.ticket, person]);
    const role = (await h.db.query("INSERT INTO contact_company_roles(contact_id,company_id,role) VALUES($1,$2,'CTO') RETURNING id", [person, company])).rows[0]!.id;
    await h.db.query('INSERT INTO role_evidence(role_id,evidence_id) VALUES($1,$2)', [role, evidence]);
    await h.db.query("INSERT INTO facts(id,job_id,ticket_id,kind,text,actor_party) SELECT $1,id,$2,'commitment','Send pricing','antseed' FROM analysis_jobs LIMIT 1", [fact, h.ticket]);
    await h.db.query('INSERT INTO fact_evidence(fact_id,evidence_id) VALUES($1,$2)', [fact, evidence]);
    const date = (await h.db.query("INSERT INTO facts(job_id,ticket_id,parent_fact_id,kind,text,relative_to,date_precision,local_date) SELECT job_id,ticket_id,id,'follow_up','tomorrow','2026-10-25T10:00:00Z','date','2026-10-26' FROM facts WHERE id=$1 RETURNING id", [fact])).rows[0]!.id;
    await h.db.query('INSERT INTO fact_evidence(fact_id,evidence_id) VALUES($1,$2)', [date, evidence]);
    await h.repo.reconcile(); const id = (await h.repo.list({})).items[0]!.id; const detail = await h.repo.get(id);
    expect(detail.activeSources).toEqual([]); expect(detail.pendingSources[0]!.contacts[0]).toMatchObject({ names: ['Mira Fixture'], roles: ['CTO'] });
    expect(detail.pendingSources[0]!.facts[0]).toMatchObject({ actor: { party: 'antseed' }, dates: [{ precision: 'date', localDate: '2026-10-26', resolvedAt: null }] });
    // A deadline supported by A+B must disappear after B is deleted, even
    // though the parent action remains supported by A. Never shrink citations.
    const secondEvidence = '00000000-0000-4000-8000-000000000109';
    await h.db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text) VALUES(-1001,2,7,now(),'Second deadline source')");
    await h.db.query("INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,-1001,2,1,'Second deadline source',now())", [secondEvidence]);
    await h.db.query('INSERT INTO fact_evidence(fact_id,evidence_id) VALUES($1,$2)', [date, secondEvidence]);
    expect((await h.repo.get(id)).pendingSources[0]!.facts[0]!.dates[0]!.evidenceIds).toHaveLength(2);
    await h.db.query('UPDATE messages SET deleted_at=now(),version=version+1 WHERE chat_id=-1001 AND id=2');
    expect((await h.repo.get(id)).pendingSources[0]!.facts[0]!.dates).toEqual([]);
    await h.db.query('UPDATE messages SET deleted_at=now(),version=version+1 WHERE chat_id=-1001 AND id=1');
    const deleted = await h.repo.get(id); expect(deleted.pendingSources[0]!.contacts).toEqual([]); expect(deleted.pendingSources[0]!.facts).toEqual([]); expect(deleted.pendingSources[0]!.evidence).toEqual([]);
  });
});
