import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { fixtureDatabase, seedJob } from './database.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { parseOpenAIDecisions, OPENAI_DECISIONS_VERSION } from '../../src/intelligence/openai-decisions.js';
import { outbound, recommendation } from '../intelligence/outbound-fixtures.js';
import { evidenceId, provenance } from '../intelligence/fixtures.js';
import type { ControlBus } from '../../src/shared/ports.js';

it('persists outbound prospect/contact -> awaiting reply -> sourced inbound -> pending proposal, with no stage write', async () => {
  const db = await fixtureDatabase(), clock = { now: () => new Date('2026-10-17T03:00:00Z') };
  try {
    for (const statement of (await readFile(new URL('../../db/migrations/202610170002_decision_origins.sql', import.meta.url), 'utf8')).split(';').filter(s => s.trim())) await db.query(statement);
    await db.query("UPDATE analysis_jobs SET status='cancelled'");
    const source = outbound(), m = source.messages[0]!;
    await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(7,'user','Mira','included')");
    await db.query("INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state,decided_message_id,decided_at) VALUES(7,0,'approved',-1001,9201,'sent',9202,now())");
    await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(7,1,99,$1,$2,$3,$4,$5)', [m.sentAt,m.text,JSON.stringify(m.sender),JSON.stringify(m.peer),JSON.stringify(m.forward)]);
    await seedJob(db,'00000000-0000-4000-8000-000000000091','7',1);
    const proposals = new ProposalRepository(db,{} as ControlBus,clock), queue = new SqlAnalysisQueue(db,clock,'Asia/Kolkata',{onDecision:(tx,input)=>proposals.recordAnalysisDecisionTx(tx,input)});
    const job = (await queue.claim({workerId:'outbound-test',leaseMs:60000}))!, input = await queue.loadInput(job.id);
    expect(input.accountSelfId).toBe('99');
    const extraction = JSON.parse(JSON.stringify(source.extraction).replaceAll(evidenceId,input.evidence[0]!.id)) as typeof source.extraction;
    await queue.saveExtraction({jobId:job.id,inputHash:inputHash(input),extraction,provenance:provenance()},job.claimToken);
    const decision = parseOpenAIDecisions(recommendation(),{...input,extraction}); expect(decision.lane.outcome).toBe('no_change');
    const decisionProvenance = {...provenance(),model:'gpt-6-luna',schemaVersion:OPENAI_DECISIONS_VERSION};
    await queue.complete(job.id,decision,decisionProvenance,job.claimToken);
    const ticket = (await db.query('SELECT id,lane,stage_version FROM tickets WHERE chat_id=7')).rows[0]!;
    const records = new RecordsRepository(db,clock), context = await records.getContext({ticketId:String(ticket.id),limit:100});
    expect(context.outreach).toMatchObject({waitingForReply:true,lastIncomingAt:null,initiatedBy:'antseed'}); expect(context.contacts).toHaveLength(1); expect(context.contacts[0]!.telegramUserIds).toEqual(['7']);
    expect((await db.query('SELECT id FROM proposals')).rows).toHaveLength(0);
    const text = 'Yes, Cedar Labs is interested. Send pricing and engineering will review it.';
    await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(7,2,7,$1,$2,$3,$4,$5)', ['2026-10-17T02:00:00Z',text,JSON.stringify(m.peer),JSON.stringify(m.peer),JSON.stringify(m.forward)]);
    await seedJob(db,'00000000-0000-4000-8000-000000000092','7',2);
    const next = (await queue.claim({workerId:'outbound-test',leaseMs:60000}))!, current = await queue.loadInput(next.id);
    const extracted = {...extraction,evidenceIds:current.evidence.map(e=>e.id)};
    await queue.saveExtraction({jobId:next.id,inputHash:inputHash(current),extraction:extracted,provenance:provenance()},next.claimToken);
    // Native response includes the current directory choice, preserving strict distributions.
    const raw = recommendation(), match = raw.answers.find(a=>a.name==='company_match')!;
    if(match.type==='choice') {match.choice='existing_0';match.probabilities.push({value:'existing_0',probability:1});for(const p of match.probabilities)if(p.value!=='existing_0')p.probability=0;}
    const accepted = parseOpenAIDecisions(raw,{...current,extraction:extracted});
    expect(accepted.lane).toMatchObject({outcome:'propose',targetLane:'Work in progress'});
    await queue.complete(next.id,accepted,decisionProvenance,next.claimToken);
    expect((await records.getContext({ticketId:String(ticket.id),limit:100})).outreach.waitingForReply).toBe(false);
    expect((await db.query('SELECT decision,apply_state,origin FROM proposals')).rows).toEqual([{decision:'pending',apply_state:'not_requested',origin:'openai'}]);
    expect((await db.query('SELECT lane,stage_version FROM tickets WHERE id=$1',[ticket.id])).rows[0]).toMatchObject({lane:'To be started',stage_version:0});
    expect((await db.query('SELECT id FROM mutations')).rows).toHaveLength(0);
  } finally {await db.close();}
});
