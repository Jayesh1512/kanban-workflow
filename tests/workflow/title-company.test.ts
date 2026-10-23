import { afterEach, beforeEach, expect, it } from 'vitest';
import { companyCardTitle, companyFromGroupTitle } from '../../src/shared/company-title.js';
import { resolveTitleCompany, TITLE_COMPANY_SOURCE } from '../../src/workflow/title-company.js';
import { fixtureDatabase } from './database.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { extractionFixture, decisionFixture, provenance } from '../intelligence/fixtures.js';

it.each([
 ['group','AntSeed <> Phala','Phala'],['supergroup','Antseed <> Aeon','Aeon'],['group','Fere AI <> Antseed','Fere AI'],
 ['group',' antseed < >  Cedar   Labs ','Cedar Labs'],['group','Phala <-> ANTSEED','Phala'],['supergroup','AntSeed ↔ Phala','Phala'],
 ['user','AntSeed <> Phala',null],['channel','AntSeed <> Phala',null],['group','Phala',null],['group','AntSeed - Phala',null],
 ['group','Antseed <> Phala <> Aeon',null],['group','Phala <> Aeon',null],['group','AntSeed <> Antseed',null],['group','AntSeed <> ',null],
 ['group','AntSeed <> Phala & Aeon',null],['group','AntSeed <> Community',null],
])('derives only an unambiguous structured group company: %s %s', (kind,title,want)=>{expect(companyFromGroupTitle(kind,title)).toBe(want);});
let db:Awaited<ReturnType<typeof fixtureDatabase>>;
beforeEach(async()=>{db=await fixtureDatabase();await db.query("UPDATE chats SET title='AntSeed <> Phala' WHERE id=-1001");await db.query("INSERT INTO tickets(chat_id,company_id,kind,lane,stage_version,vikunja_task_id) VALUES(-1001,NULL,'contact_prospect','Integrations',3,88)");});
afterEach(async()=>{await db.close();});
it('links Phala from its group title, upgrades the same ticket and retains lane/remote ID without fake message evidence',async()=>{
 const before=(await db.query('SELECT id FROM tickets')).rows[0]!['id'];expect(await db.transaction(tx=>resolveTitleCompany(tx,'-1001'))).toBe(true);
 const row=(await db.query('SELECT t.*,c.canonical_name FROM tickets t JOIN companies c ON c.id=t.company_id')).rows[0]!;
 expect(row).toMatchObject({id:before,canonical_name:'Phala',kind:'company',lane:'Integrations',stage_version:3,vikunja_task_id:88});
 const history=(await db.query('SELECT * FROM mapping_history')).rows[0]!;expect(String(history['reason'])).toContain(TITLE_COMPANY_SOURCE);expect(String(history['reason'])).toContain('AntSeed <> Phala');expect((await db.query('SELECT * FROM mapping_history_evidence')).rows).toHaveLength(0);
 expect(await db.transaction(tx=>resolveTitleCompany(tx,'-1001'))).toBe(false);expect((await db.query('SELECT * FROM companies')).rows).toHaveLength(1);
 expect((await db.query("SELECT * FROM analysis_jobs WHERE status='pending'")).rows).toHaveLength(1);expect((await db.query('SELECT text FROM messages')).rows[0]!['text']).not.toContain('Phala');
});
it('reuses an existing exact name or alias without duplicating a company',async()=>{
 const company=(await db.query("INSERT INTO companies(canonical_name,aliases) VALUES('Phala Network',ARRAY['Phala']) RETURNING id")).rows[0]!['id'];
 await db.transaction(tx=>resolveTitleCompany(tx,'-1001'));expect((await db.query('SELECT company_id FROM chats')).rows[0]!['company_id']).toBe(company);expect((await db.query('SELECT * FROM companies')).rows).toHaveLength(1);
});
it('leaves duplicate-name ambiguity unresolved',async()=>{
 await db.query("INSERT INTO companies(canonical_name) VALUES('Phala'),('Phala')");expect(await db.transaction(tx=>resolveTitleCompany(tx,'-1001'))).toBe(false);expect((await db.query('SELECT mapping_status FROM chats')).rows[0]!['mapping_status']).toBe('unresolved');
});
it.each(['excluded','undecided'])('does not identify/import unapproved %s chats',async inclusion=>{
 await db.query('UPDATE chats SET inclusion=$1',[inclusion]);expect(await db.transaction(tx=>resolveTitleCompany(tx,'-1001'))).toBe(false);expect((await db.query('SELECT * FROM companies')).rows).toHaveLength(0);
});
it('preserves deliberate operator unresolved mapping and non-company choices',async()=>{
 await db.query("INSERT INTO mapping_history(chat_id,mapping_status,version,reason,source) VALUES(-1001,'unresolved',0,'Operator choice','http')");expect(await db.transaction(tx=>resolveTitleCompany(tx,'-1001'))).toBe(false);
 await db.query("DELETE FROM mapping_history");await db.query("UPDATE chats SET mapping_status='non_company'");expect(await db.transaction(tx=>resolveTitleCompany(tx,'-1001'))).toBe(false);
});
it('does not replace a title-derived company with an incidental company mentioned in later extraction',async()=>{
 await db.transaction(tx=>resolveTitleCompany(tx,'-1001'));const queue=new SqlAnalysisQueue(db);const job=(await queue.claim({workerId:'fixture',leaseMs:60000}))!;const input=await queue.loadInput(job.id);const extraction=extractionFixture(input.evidence[0]!.id);
 await queue.saveExtraction({jobId:job.id,inputHash:inputHash(input),extraction,provenance:provenance()},job.claimToken);await queue.complete(job.id,decisionFixture(input.evidence[0]!.id),provenance('vercel'),job.claimToken);
 expect((await db.query('SELECT canonical_name FROM companies')).rows).toEqual([{canonical_name:'Phala'}]);expect((await db.query('SELECT lane,stage_version FROM tickets')).rows[0]).toEqual({lane:'Integrations',stage_version:3});
});

it('uses the company name once on structured-group cards, retaining other chat titles and unknown prospects',()=>{
 expect(companyCardTitle({canonicalName:'Phala',aliases:[]},{kind:'supergroup',title:'AntSeed <> Phala'})).toBe('Phala');
 expect(companyCardTitle({canonicalName:'Fere AI',aliases:[]},{kind:'group',title:'Fere AI <> Antseed'})).toBe('Fere AI');
 expect(companyCardTitle({canonicalName:'Phala Network',aliases:['Phala']},{kind:'group',title:'Antseed <> Phala'})).toBe('Phala Network');
 expect(companyCardTitle({canonicalName:'Phala',aliases:[]},{kind:'group',title:'Integration support'})).toBe('Phala — Integration support');
 expect(companyCardTitle(null,{kind:'user',title:'New contact'})).toBe('New contact — company unknown');
});
