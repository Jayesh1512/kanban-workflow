import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Extraction } from '../../src/shared/domain.js';
import type { ControlBus, RuntimeConfig } from '../../src/shared/ports.js';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { TelegramStore } from '../../src/telegram/store.js';
import { VikunjaAdapter } from '../../src/vikunja/adapter.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { SqlMutationStore } from '../../src/workflow/mutations.js';
import { ProposalWorkflow } from '../../src/workflow/apply.js';
import { TicketProjector } from '../../src/workflow/projection.js';
import { parseOpenAIDecisions, OPENAI_DECISIONS_VERSION } from '../../src/intelligence/openai-decisions.js';
import { outbound, recommendation } from '../intelligence/outbound-fixtures.js';
import { provenance } from '../intelligence/fixtures.js';
import { testVikunjaToken } from '../vikunja-test-auth.js';
const project=process.env['PROSPECT_TEST_PROJECT'];
describe.skipIf(!project)('contact prospects: actual isolated PostgreSQL17/Vikunja2.7, authored inference only',()=>{
  let config:RuntimeConfig,admin:PgDatabase,db:PgDatabase,schema:string;
  beforeAll(async()=>{
    if(!/^antseed-(?:prospects-check|qa-m1-system)-[a-z0-9-]+$/.test(project!))throw Error('Requires an explicitly isolated prospect/system synthetic project');
    const container=project+'-postgres-1';
    const info=JSON.parse(execFileSync('docker',['inspect',container],{encoding:'utf8'}))[0];expect(info.Config.Labels['com.docker.compose.project']).toBe(project);
    const bundle=parse(execFileSync('docker',['exec',container,'cat','/run/antseed/runtime.env'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    const url=new URL(bundle['DATABASE_URL']!);url.hostname='127.0.0.1';url.port=process.env['PROSPECT_TEST_PG_PORT']??'19533';
    config=await loadRuntimeConfig({...bundle,DATABASE_URL:url.toString(),VIKUNJA_URL:process.env['PROSPECT_TEST_VIKUNJA_URL']??'http://127.0.0.1:19581',MOVEMENT_PROVIDER:'openai',AI_ENV_PATH:'/no-private-provider-file',TELEGRAM_APPLICATION_PROFILE:'custom'});
    await testVikunjaToken(config.vikunja);
    admin=new PgDatabase(config.databaseUrl);
  });
  afterEach(async()=>{if(db){await db.close();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');}});
  afterAll(async()=>{await admin?.close();});
  async function fixture(){schema='prospect_'+randomUUID().replaceAll('-','');await admin.query('CREATE SCHEMA '+schema);const url=new URL(config.databaseUrl);url.searchParams.set('options','-c search_path='+schema);db=new PgDatabase(url.toString());await migrate(db);return db;}
  it('creates a real unknown-company card, applies only after approval, then upgrades the same remote task without resetting its lane',async()=>{
    await fixture();let instant=Date.now();const clock={now:()=>new Date(instant)};
    const store=new TelegramStore(db,config.telegram);await store.bindAccount('99');await store.upsertDialog({id:'7',kind:'user',title:'Synthetic Harsh',username:'synthetic_harsh',archived:false});
    const original=outbound().messages[0]!;original.sender.names=['Jayesh'];original.peer.names=['Harsh'];original.peer.usernames=['harsh'];
    const send=async(id:number,sender:string,text:string)=>{instant+=1000;await store.ingest({type:'message',message:{chatId:'7',id,senderId:sender,sentAt:new Date(instant).toISOString(),editedAt:null,text,replyToId:null,sourceUrl:null,sender:sender==='99'?original.sender:original.peer,peer:original.peer,forward:original.forward}});};
    await send(1,'99','Hi Harsh, Jayesh here from AntSeed. Would you like to try our API services?');
    const records=new RecordsRepository(db,clock),repo=new ProposalRepository(db,{} as ControlBus,clock),queue=new SqlAnalysisQueue(db,clock,'Asia/Kolkata',{onDecision:(tx,input)=>repo.recordAnalysisDecisionTx(tx,input)});
    const adapter=new VikunjaAdapter({...config.vikunja,projectTitle:'Owned prospect regression '+schema},db);const board=await adapter.ensureBoard(),projector=new TicketProjector(db,adapter,records,clock);
    try{
      async function analyse(known=false){
        const job=(await queue.claim({workerId:'synthetic-inference',leaseMs:60000}))!;expect(job).toBeTruthy();const input=await queue.loadInput(job.id),ids=input.evidence.map(e=>e.id),latest=input.evidence.find(e=>e.messageId===(known?3:input.messages.length>1?2:1))!.id;
        const extraction:Extraction={companyCandidates:known?[{companyId:null,canonicalName:'Cedar Labs',confidence:1,evidenceIds:[latest]}]:[],companies:known?[{canonicalName:'Cedar Labs',aliases:[],domains:[],buyerIds:[],providerIds:[],evidenceIds:[latest]}]:[],contacts:[{telegramUserIds:['7'],names:['Harsh'],usernames:['harsh'],phones:[],emails:[],roles:[],affiliation:known?'external':'unknown',evidenceIds:known?[latest]:ids}],facts:[],dates:[],summary:known?'Harsh from Cedar Labs; company sourced.':'Business enquiry to Harsh; company unknown.',substantive:true,evidenceIds:ids};
        await queue.saveExtraction({jobId:job.id,inputHash:inputHash(input),extraction,provenance:provenance()},job.claimToken);
        const raw=recommendation();for(const a of raw.answers){if(!known&&a.name==='company_match'&&a.type==='choice'){a.choice='none';for(const p of a.probabilities)p.probability=p.value==='none'?1:0;}if(a.name==='outbound_enquiry'&&a.type==='predicate')a.probability=0.99;}
        const decision=parseOpenAIDecisions(raw,{...input,extraction});await queue.complete(job.id,decision,{...provenance(),model:'gpt-6-luna',schemaVersion:OPENAI_DECISIONS_VERSION},job.claimToken);
        return (await records.listTickets({})).items[0]!;
      }
      let ticket=await analyse();expect(ticket).toMatchObject({kind:'contact_prospect',companyId:null,lane:'To be started',stageVersion:0});expect((await records.listCompanies({})).items).toHaveLength(0);
      await projector.project(ticket.id);ticket=await records.getTicket(ticket.id);const remoteId=ticket.vikunjaTaskId!;let remote=(await adapter.getTask(remoteId))!;expect(remote.title).toBe('Synthetic Harsh — company unknown');expect(remote.bucketId).toBe(board.buckets['To be started']);
      await store.setInclusion({chatId:'7',inclusion:'excluded',expectedPolicyVersion:0,idempotencyKey:'exclude'});await expect(projector.project(ticket.id)).rejects.toMatchObject({code:'excluded_chat'});
      await store.setInclusion({chatId:'7',inclusion:'included',expectedPolicyVersion:1,idempotencyKey:'include'});expect((await records.getTicket(ticket.id)).trackingState).toBe('active');await projector.project(ticket.id);expect((await adapter.getTask(remoteId))!.bucketId).toBe(board.buckets['To be started']);
      await send(2,'7','Yes, please send pricing and our engineering team will review the API.');await analyse();const proposal=(await repo.list({ticketId:ticket.id})).items[0]!;expect(proposal).toMatchObject({origin:'openai',decision:'pending',applyState:'not_requested'});expect((await adapter.getTask(remoteId))!.bucketId).toBe(board.buckets['To be started']);
      const workflow=new ProposalWorkflow(repo,new SqlMutationStore(db,clock),adapter,projector);await workflow.decide({idempotencyKey:'synthetic-human-approval',proposalId:proposal.id,decision:'approve'});expect((await workflow.applyNext())?.state).toBe('committed');expect((await adapter.getTask(remoteId))!.bucketId).toBe(board.buckets['Work in progress']);
      await send(3,'7','I am Harsh from Cedar Labs. Our team is reviewing the pricing.');await analyse(true);await projector.project(ticket.id);
      const upgraded=await records.getTicket(ticket.id);remote=(await adapter.getTask(remoteId))!;expect(upgraded).toMatchObject({id:ticket.id,kind:'company',companyId:expect.any(String),vikunjaTaskId:remoteId,lane:'Work in progress',stageVersion:1});expect(remote.title).toBe('Cedar Labs — Synthetic Harsh');expect(remote.bucketId).toBe(board.buckets['Work in progress']);expect((await records.listTickets({})).items).toHaveLength(1);expect((await records.getContext({ticketId:ticket.id,limit:100})).company?.canonicalName).toBe('Cedar Labs');
      expect((await db.query("SELECT count(*)::int AS n FROM mutations WHERE state='committed'")).rows[0]!.n).toBe(1);
    }finally{
      const response=await fetch(config.vikunja.baseUrl+'/api/v2/projects/'+board.projectId,{method:'DELETE',headers:{authorization:'Bearer '+config.vikunja.apiToken},signal:AbortSignal.timeout(8000)});expect(response.ok).toBe(true);await response.body?.cancel();
    }
  },30000);
  it('reserves a distinct live claim during held historical ownership and never lets the live slot take backlog',async()=>{
    await fixture();await db.query('INSERT INTO telegram_account(self_user_id) VALUES(99)');await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(7,'user','Synthetic queue','included')");const now=new Date();
    async function seed(id:number,fresh:boolean){const uuid=randomUUID(),sent=new Date(now.getTime()-(fresh?0:7200000));await db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text) VALUES(7,$1,$2,$3,'Synthetic source')",[id,fresh?99:7,sent]);await db.query('INSERT INTO analysis_jobs(id,chat_id,policy_version,mapping_version,dedupe_key) VALUES($1::uuid,7,0,0,$1::text)',[uuid]);await db.query('INSERT INTO analysis_job_messages VALUES($1,7,$2,1)',[uuid,id]);return uuid;}
    const oldest=await seed(1,false),oldQueue=new SqlAnalysisQueue(db,{now:()=>now}),liveQueue=new SqlAnalysisQueue(db,{now:()=>now});expect((await oldQueue.claim({workerId:'history',leaseMs:60000}))!.id).toBe(oldest);await seed(2,false);
    expect(await liveQueue.claim({workerId:'live',leaseMs:60000,recentOutboundOnly:true})).toBeNull();const fresh=await seed(3,true);expect((await liveQueue.claim({workerId:'live',leaseMs:60000,recentOutboundOnly:true}))!.id).toBe(fresh);expect((await db.query("SELECT value FROM app_settings WHERE key='workflow:analysis:dispatch'")).rows[0]!.value).toBe(1);
    for(let id=4;id<=10;id++)await seed(id,true);const claims=await Promise.all(Array.from({length:7},(_,i)=>new SqlAnalysisQueue(db,{now:()=>now}).claim({workerId:'same',leaseMs:60000,recentOutboundOnly:i%2===0})));expect(claims.every(Boolean)).toBe(true);expect(new Set(claims.map(j=>j!.id)).size).toBe(7);expect(new Set(claims.map(j=>j!.claimToken)).size).toBe(7);
  },15000);
});
