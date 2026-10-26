import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalFixture, project, sdk, value } from './qa-m4-support.js';
import { checkpoint, enqueue } from './qa-m31-support.js';
import { SqlAnalysisQueue } from '../src/workflow/analysis.js';

const expectedTools = ['list_outreach_relationships','get_outreach_relationship','list_chats','set_chat_inclusion','get_import_status','request_import','get_mapping_candidates','correct_company_mapping','list_companies','get_company','create_company','update_company','list_contacts','get_contact','create_contact','update_contact','list_tickets','get_ticket','ensure_ticket','get_ticket_context','get_evidence','update_ticket_actions','list_ticket_facts','update_fact','today_priorities','propose_lane_change','list_proposals','get_proposal','replay_analysis'];
describe.skipIf(!project)('QA M4 canonical modules, actual HTTP/official SDK/PG/Vikunja; synthetic company only', () => {
  let f: Awaited<ReturnType<typeof canonicalFixture>> | undefined, client: Awaited<ReturnType<typeof sdk>> | undefined;
  afterEach(async () => { await client?.close(); client = undefined; await f?.close(); f = undefined; });
  async function setup() { f = await canonicalFixture(); client = await sdk(f.url); return f; }
  async function tool(name: string, args: Record<string, unknown> = {}) { const r = await client!.callTool({ name, arguments: args }); expect(r.isError, JSON.stringify(value(r))).not.toBe(true); return value(r); }
  async function http(method: 'GET'|'POST'|'PUT', url: string, payload?: Record<string, unknown>) { const r = await f!.app.inject({ method, url, ...(payload ? { payload } : {}) }); expect(r.statusCode, r.body).toBe(200); return r.json(); }
  it('negotiates exactly29 tools with no approval/send/login/move escape; real record read families match HTTP', async () => {
    const { h } = await setup(); expect(client!.getServerVersion()?.name).toBe('antseed');
    const list = await client!.listTools(); expect(list.tools.map((t) => t.name)).toEqual(expectedTools);
    for (const denied of ['decide_proposal','approve_proposal','move_task','send_message','login']) { const r = await client!.callTool({ name: denied, arguments: {} }); expect(r.isError).toBe(true); expect(value(r).error.code).toBe('validation'); }
    const ticket = await h.local();
    for (const [name, args, method, url, body] of [
      ['list_companies',{},'GET','/api/companies'], ['get_company',{id:ticket.companyId},'GET',`/api/companies/${ticket.companyId}`],
      ['list_contacts',{},'GET','/api/contacts'], ['list_tickets',{},'GET','/api/tickets'], ['get_ticket',{id:ticket.id},'GET',`/api/tickets/${ticket.id}`],
      ['ensure_ticket',{chatId:ticket.chatId},'POST','/api/tickets',{chatId:ticket.chatId}], ['get_ticket_context',{ticketId:ticket.id},'GET',`/api/tickets/${ticket.id}/context`],
      ['get_evidence',{ids:[h.evidenceId]},'POST','/api/evidence/query',{ids:[h.evidenceId]}], ['list_ticket_facts',{ticketId:ticket.id},'GET',`/api/tickets/${ticket.id}/facts`],
      ['today_priorities',{date:'2026-10-17',timezone:'Asia/Kolkata'},'GET','/api/priorities/today?date=2026-10-17&timezone=Asia%2FKolkata'],
    ] as const) expect(await tool(name, args)).toEqual(await http(method, url, body));
    expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
  });
  it('company/contact/roles/actions/facts writes persist and share idempotency/version state across transports', async () => {
    const { h } = await setup(), ticket = await h.local();
    const c = { idempotencyKey:'qa-m4-company',canonicalName:'QA M4 Cedar subsidiary',aliases:['QA subsidiary'],domains:[],workstream:'Others',summary:'Synthetic only',buyerIds:[],providerIds:[],evidenceIds:[h.evidenceId] };
    const company = await tool('create_company', c); expect(await http('POST','/api/companies',c)).toEqual(company);
    const update = {...c,idempotencyKey:'qa-m4-company-update',expectedVersion:company.version,summary:'Corrected synthetic summary'};
    const updated = await http('PUT',`/api/companies/${company.id}`,update); expect(await tool('update_company',{...update,id:company.id})).toEqual(updated);
    const stale = await client!.callTool({name:'update_company',arguments:{...update,id:company.id,idempotencyKey:'qa-stale'}}); expect(stale.isError).toBe(true); expect(value(stale).error.code).toBe('conflict');
    const person = {idempotencyKey:'qa-m4-contact',telegramUserIds:['990000088'],names:['QA Noor'],usernames:[],phones:[],emails:[],affiliation:'external',evidenceIds:[h.evidenceId],roles:[{companyId:ticket.companyId,role:'Engineering owner',evidenceIds:[h.evidenceId]}]};
    const contact = await http('POST','/api/contacts',person); expect(await tool('create_contact',person)).toEqual(contact);
    expect(await tool('get_contact',{id:contact.id})).toEqual(await http('GET',`/api/contacts/${contact.id}`));
    const correction = {...person,idempotencyKey:'qa-m4-contact-update',expectedVersion:contact.version,names:['QA Noor corrected']};
    expect(await tool('update_contact',{...correction,id:contact.id})).toEqual(await http('PUT',`/api/contacts/${contact.id}`,correction));
    const actions = {idempotencyKey:'qa-m4-actions',expectedActionsVersion:ticket.actionsVersion,nextAction:'QA follow up',followUpAt:null,etaAt:null,evidenceIds:[h.evidenceId]};
    expect(await tool('update_ticket_actions',{...actions,ticketId:ticket.id})).toEqual(await http('PUT',`/api/tickets/${ticket.id}/actions`,actions));
    // Authored extraction supplies a real persisted fact, never a model-quality claim.
    const id = await enqueue(h.db,h.source.chat.id,h.source.messages[0]!.id), queue = new SqlAnalysisQueue(h.db,h.clock), job = (await queue.claim({workerId:'qa-fact',leaseMs:60000}))!; expect(job.id).toBe(id); await checkpoint(queue,job);
    await h.db.query("UPDATE analysis_jobs SET status='completed',worker_id=NULL,lease_until=NULL WHERE id=$1",[id]);
    const facts = await tool('list_ticket_facts',{ticketId:ticket.id}), fact = facts.items[0]; expect(fact).toBeDefined();
    const fix = {idempotencyKey:'qa-m4-fact',expectedVersion:fact.version,state:'completed',actor:{party:'antseed',contactId:null,displayName:'AntSeed'},evidenceIds:[h.evidenceId],answersFactId:null,dates:[]};
    expect(await tool('update_fact',{...fix,factId:fact.id})).toEqual(await http('PUT',`/api/facts/${fact.id}`,fix));
    expect((await h.local()).stageVersion).toBe(0); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
  });
  it('Hermes origin is forced, proposal remains pending, correction/reject are HTTP-only and stale approval409', async () => {
    const { h } = await setup(), ticket = await h.local();
    const input = {idempotencyKey:'qa-m4-proposal',ticketId:ticket.id,expectedStageVersion:0,targetLane:'Work in progress',evidenceIds:[h.evidenceId],reason:'QA synthetic source',nextAction:null};
    const p = await tool('propose_lane_change',input); expect(p).toMatchObject({origin:'hermes',decision:'pending',applyState:'not_requested'}); expect(await tool('propose_lane_change',input)).toEqual(p);
    expect(await tool('get_proposal',{id:p.id})).toEqual(await http('GET',`/api/proposals/${p.id}`)); expect(await tool('list_proposals',{ticketId:ticket.id})).toEqual(await http('GET',`/api/proposals?ticketId=${ticket.id}`));
    const manual = await http('POST','/api/proposals',{...input,idempotencyKey:'qa-m4-manual'}); expect(manual.origin).toBe('manual');
    const fixed = await http('POST',`/api/proposals/${p.id}/decision`,{idempotencyKey:'qa-m4-correct',decision:'correct',targetLane:'Blocked',reason:'QA blocker',evidenceIds:[h.evidenceId]});
    expect(fixed).toMatchObject({proposal:{decision:'corrected'},replacement:{decision:'pending'}});
    expect((await http('POST',`/api/proposals/${fixed.replacement.id}/decision`,{idempotencyKey:'qa-m4-reject',decision:'reject'})).proposal.decision).toBe('rejected');
    await h.db.query('UPDATE messages SET version=version+1');
    const stale = await f!.app.inject({method:'POST',url:`/api/proposals/${manual.id}/decision`,payload:{idempotencyKey:'qa-m4-stale',decision:'approve'}}); expect(stale.statusCode).toBe(409); expect(stale.json().error.code).toBe('stale_proposal');
    expect((await h.db.query('SELECT * FROM mutations')).rows).toHaveLength(0); expect((await h.local()).stageVersion).toBe(0); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
  });
  it('all six A chat routes and MCP share policy/import/mapping state and audit source; excluded replay is harmless', async () => {
    const { h } = await setup(), chatId=h.source.chat.id;
    expect(await tool('list_chats')).toEqual(await http('GET','/api/chats'));
    const input={chatId,idempotencyKey:'qa-import',maxBatches:1,batchSize:10}; expect(await tool('request_import',input)).toEqual(await http('POST',`/api/chats/${chatId}/import`,{idempotencyKey:input.idempotencyKey,maxBatches:1,batchSize:10}));
    expect(await tool('get_import_status',{chatId})).toEqual(await http('GET',`/api/chats/${chatId}/import`)); expect(await tool('get_mapping_candidates',{chatId})).toEqual(await http('GET',`/api/chats/${chatId}/mapping`));
    const mapping={chatId,idempotencyKey:'qa-mcp-map',expectedMappingVersion:0,status:'confirmed',companyId:(await h.local()).companyId,evidenceIds:[h.evidenceId],reason:'QA explicit mapping'};
    expect((await tool('correct_company_mapping',mapping)).mappingVersion).toBe(1);
    await http('PUT',`/api/chats/${chatId}/mapping`,{...mapping,idempotencyKey:'qa-http-map',expectedMappingVersion:1});
    expect((await h.db.query('SELECT source,reason FROM mapping_history ORDER BY version')).rows).toEqual([{source:'mcp',reason:mapping.reason},{source:'http',reason:mapping.reason}]);
    const policy={chatId,idempotencyKey:'qa-exclude',expectedPolicyVersion:0,inclusion:'excluded'};
    expect(await tool('set_chat_inclusion',policy)).toEqual(await http('PUT',`/api/chats/${chatId}/inclusion`,{idempotencyKey:policy.idempotencyKey,expectedPolicyVersion:0,inclusion:'excluded'}));
    const replay={idempotencyKey:'qa-replay-excluded',chatId}; expect(await tool('replay_analysis',replay)).toEqual(await http('POST','/api/analysis/replay',replay));
    expect((await h.db.query("SELECT * FROM analysis_jobs WHERE status IN ('pending','running','retry')")).rows).toHaveLength(0);
    expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
  });
  it('actual canonical errors reject malformed query/path/provenance and preserve source and SQL state', async () => {
    const { h }=await setup(); const id=h.ticket.id;
    for(const url of ['/api/companies?limit=0x10','/api/companies?limit=1&limit=2','/api/companies?limit=-1','/api/companies?limit=1e2','/api/companies?unknown=x',`/api/tickets/${id}?id=${randomUUID()}`]) {const r=await f!.app.inject(url); expect(r.statusCode,url).toBe(400); expect(r.json()).toMatchObject({error:{code:'validation',retryable:false,requestId:expect.any(String)}});}
    const malformed=await f!.app.inject({method:'POST',url:'/api/proposals',payload:'{',headers:{'content-type':'application/json'}}); expect(malformed.statusCode).toBe(400);
    for(const [name,args] of [['list_companies',{limit:'1'}],['propose_lane_change',{idempotencyKey:'qa-spoof',ticketId:id,expectedStageVersion:0,targetLane:'Blocked',evidenceIds:[h.evidenceId],reason:'QA',nextAction:null,origin:'manual'}],['correct_company_mapping',{chatId:h.source.chat.id,idempotencyKey:'qa-source-spoof',expectedMappingVersion:0,status:'unresolved',companyId:null,evidenceIds:[],reason:'QA',source:'http'}]] as const) {const r=await client!.callTool({name,arguments:args});expect(r.isError).toBe(true);expect(value(r).error.code).toBe('validation');}
    expect((await h.db.query('SELECT * FROM proposals')).rows).toHaveLength(0);expect((await h.db.query('SELECT * FROM mapping_history')).rows).toHaveLength(0);
    const missing=await f!.app.inject(`/api/companies/${randomUUID()}`);expect(missing.statusCode).toBe(404);expect(missing.json().error.code).toBe('not_found');
  });
  it('exact checksum drift fences equivalent HTTP and MCP chat mutations without policy writes', async () => {
    const { h }=await setup(); await h.db.query("UPDATE schema_migrations SET checksum=repeat('0',64)");
    const input={chatId:h.source.chat.id,idempotencyKey:'qa-drift-exclude',expectedPolicyVersion:0,inclusion:'excluded'};
    const result=await client!.callTool({name:'set_chat_inclusion',arguments:input}); expect(result.isError).toBe(true);expect(value(result).error.code).toBe('upstream_unavailable');
    const r=await f!.app.inject({method:'PUT',url:`/api/chats/${input.chatId}/inclusion`,payload:{idempotencyKey:input.idempotencyKey,expectedPolicyVersion:0,inclusion:'excluded'}});
    expect({http:r.statusCode,rows:(await h.db.query('SELECT inclusion,policy_version FROM chats')).rows}).toEqual({http:503,rows:[{inclusion:'included',policy_version:0}]});
  });
  it.each(['checksum','unknown','missing'] as const)('all six A routes stop on %s ledger drift before import/mapping/policy effects',async(drift)=> {
    const {h}=await setup(),chatId=h.source.chat.id;
    if(drift==='checksum')await h.db.query("UPDATE schema_migrations SET checksum=repeat('0',64)");
    if(drift==='unknown')await h.db.query("INSERT INTO schema_migrations(version,checksum) VALUES('999999999999_qa_unknown.sql',repeat('0',64))");
    if(drift==='missing')await h.db.query('DELETE FROM schema_migrations WHERE version=(SELECT max(version) FROM schema_migrations)');
    const before={chats:(await h.db.query('SELECT * FROM chats ORDER BY id')).rows,requests:(await h.db.query('SELECT * FROM telegram_history_requests')).rows,history:(await h.db.query('SELECT * FROM history_cursors')).rows,mapping:(await h.db.query('SELECT * FROM mapping_history')).rows};
    for(const [method,url,payload] of [
      ['GET','/api/chats'],['GET',`/api/chats/${chatId}/import`],['GET',`/api/chats/${chatId}/mapping`],
      ['POST',`/api/chats/${chatId}/import`,{idempotencyKey:'qa-guard-import',maxBatches:1,batchSize:10}],
      ['PUT',`/api/chats/${chatId}/mapping`,{idempotencyKey:'qa-guard-map',expectedMappingVersion:0,status:'unresolved',companyId:null,evidenceIds:[],reason:'QA guarded mapping'}],
      ['PUT',`/api/chats/${chatId}/inclusion`,{idempotencyKey:'qa-guard-policy',expectedPolicyVersion:0,inclusion:'excluded'}],
    ] as const){const r=await f!.app.inject({method,url,...(payload?{payload}:{})});expect(r.statusCode,`${method} ${url}`).toBe(503);expect(r.json()).toMatchObject({error:{code:'upstream_unavailable',retryable:true}});}
    expect({chats:(await h.db.query('SELECT * FROM chats ORDER BY id')).rows,requests:(await h.db.query('SELECT * FROM telegram_history_requests')).rows,history:(await h.db.query('SELECT * FROM history_cursors')).rows,mapping:(await h.db.query('SELECT * FROM mapping_history')).rows}).toEqual(before);
  });
});
