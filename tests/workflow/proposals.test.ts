import { afterEach, describe, expect, it } from 'vitest';
import { workflowHarness } from './harness.js';
import type { ControlMessage } from '../../src/shared/ports.js';
import { LANES } from '../../src/shared/domain.js';
import { decisionFixture } from '../intelligence/fixtures.js';
import { randomUUID } from 'node:crypto';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });
async function setup() { const h = await workflowHarness(); cleanups.push(() => h.db.close()); return h; }

describe('durable proposal decisions and control correlation', () => {
  it.each(LANES)('durably notifies a pending %s recommendation without approving or moving (authored SQL intent)',async target=>{
    const h=await setup();await h.configureControl();const from=target==='To be started'?'Work in progress':'To be started';await h.db.query('UPDATE tickets SET lane=$2 WHERE id=$1',[h.ticket.id,from]);
    const decision=decisionFixture(h.evidenceId);decision.diagnostics.rubricVersion='openai.decisions.antseed.v3';decision.lane={outcome:'propose',targetLane:target,evidenceIds:[h.evidenceId],reason:'Caller-authored stage recommendation, not model classification',nextAction:null};
    const input={jobId:randomUUID(),ticketId:h.ticket.id,expectedStageVersion:0,decision};
    await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,input));await h.db.transaction(tx=>h.proposals.recordAnalysisDecisionTx(tx,input));
    const rows=(await h.db.query('SELECT p.decision,p.apply_state,p.origin,o.state,o.text FROM proposals p JOIN control_outbox o ON o.proposal_id=p.id')).rows;
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({decision:'pending',apply_state:'not_requested',origin:'openai',state:'pending'});expect(rows[0]!.text).toContain(`${from} → ${target}`);expect(rows[0]!.text).toContain('Reply approve');
    expect((await h.records.getTicket(h.ticket.id)).lane).toBe(from);expect(await h.service.applyNext()).toBeNull();expect(h.moves()).toBe(0);expect((await h.db.query('SELECT id FROM mutations')).rows).toHaveLength(0);
  });
  it('retains missing-control proposals, later enqueues one stable marked intent', async () => {
    const h = await setup(); const p = await h.propose(); expect(p).toMatchObject({ decision: 'pending', applyState: 'not_requested', lastError: 'control_chat_missing' });
    expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(0);
    await h.configureControl(); await h.proposals.flushPendingControl();
    const first = (await h.db.query('SELECT * FROM control_outbox')).rows[0]!;
    await h.proposals.flushPendingControl(); expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(1);
    expect(first.text).toContain(`[antseed-proposal:${p.id}]`); expect((await h.db.query('SELECT random_id FROM control_outbox')).rows[0]!.random_id).toEqual(first.random_id);
    expect((await h.proposals.get(p.id)).lastError).toBeNull();
  });
  it('approval is idempotent and never directly moves a ticket; correction needs a separate approval', async () => {
    const h = await setup(); const p = await h.propose();
    const corrected = await h.service.decide({ idempotencyKey: 'correct', proposalId: p.id, decision: 'correct', targetLane: 'Blocked', reason: 'Waiting on counterpart', evidenceIds: [h.evidenceId] });
    expect(corrected.proposal.decision).toBe('corrected'); expect(corrected.replacement).toMatchObject({ decision: 'pending', applyState: 'not_requested', correctionOf: p.id });
    expect(await h.service.applyNext()).toBeNull();
    const input = { idempotencyKey: 'approve', proposalId: corrected.replacement!.id, decision: 'approve' as const };
    const first = await h.service.decide(input); expect(await h.service.decide(input)).toEqual(first);
    expect((await h.records.getTicket(h.ticket.id)).lane).toBe('To be started'); expect(h.moves()).toBe(0);
    expect((await h.db.query('SELECT * FROM proposal_decisions')).rows).toHaveLength(2);
    const rejected = await h.propose('rejected'); await h.service.decide({ idempotencyKey: 'reject', proposalId: rejected.id, decision: 'reject' });
    expect((await h.service.get(rejected.id)).decision).toBe('rejected');
  });
  it.each([
    ["UPDATE chats SET policy_version=policy_version+1 WHERE id=-1001", 'policy_changed'],
    ["UPDATE chats SET mapping_version=mapping_version+1 WHERE id=-1001", 'mapping_changed'],
    ["UPDATE tickets SET stage_version=stage_version+1", 'stage_changed'],
    ["UPDATE messages SET version=version+1 WHERE chat_id=-1001", 'evidence_changed'],
    ["UPDATE messages SET deleted_at=now() WHERE chat_id=-1001", 'evidence_changed'],
    ["UPDATE chats SET inclusion='excluded' WHERE id=-1001", 'chat_not_tracked'],
  ])('persists stale state before rejecting a decision: %s', async (sql, code) => {
    const h = await setup(); const p = await h.propose(); await h.db.query(sql);
    await expect(h.service.decide({ idempotencyKey: 'stale', proposalId: p.id, decision: 'approve' })).rejects.toThrow();
    expect(await h.service.get(p.id)).toMatchObject({ decision: 'pending', applyState: 'stale', lastError: code }); expect(h.moves()).toBe(0);
  });
  it('correlates only replies to delivered intents; replay cannot duplicate decisions', async () => {
    const h = await setup(); await h.configureControl(); const p = await h.propose();
    await h.db.query('UPDATE control_outbox SET message_id=50 WHERE proposal_id=$1', [p.id]);
    const reply: ControlMessage = { chatId: '-2001', messageId: 51, senderId: '99', replyToMessageId: 50, text: 'approve', sentAt: h.clock.now().toISOString() };
    await h.service.handleControlReply({ ...reply, replyToMessageId: null }); await h.service.handleControlReply({ ...reply, chatId: '-1001' });
    expect((await h.service.get(p.id)).decision).toBe('pending');
    await h.service.handleControlReply(reply); await h.service.handleControlReply(reply);
    expect((await h.service.get(p.id)).decision).toBe('approved'); expect((await h.db.query('SELECT * FROM proposal_decisions')).rows).toHaveLength(1);
    expect((await h.db.query('SELECT source,sender_id FROM proposal_decisions')).rows[0]).toMatchObject({ source: 'telegram', sender_id: 99 });
    await h.service.handleControlReply({ ...reply, messageId: 52, text: 'correct invalid lane' });
    expect((await h.db.query("SELECT value FROM app_settings WHERE key='workflow:control:-2001:52'")).rows[0]!.value).toMatchObject({ code: 'validation' });
  });
});

it('atomically records Jev proposal intent with successful analysis and replays without duplicates', async () => {
  const h = await setup();
  const { SqlAnalysisQueue, inputHash } = await import('../../src/workflow/analysis.js'); const { seedJob } = await import('./database.js');
  const { extractionFixture, decisionFixture, provenance } = await import('../intelligence/fixtures.js'); const { randomUUID } = await import('node:crypto');
  const queue = new SqlAnalysisQueue(h.db, h.clock, 'Asia/Kolkata', { onDecision: (tx, input) => h.proposals.recordAnalysisDecisionTx(tx, input) });
  await seedJob(h.db, randomUUID()); const job = (await queue.claim({ workerId: 'analysis', leaseMs: 60000 }))!; const input = await queue.loadInput(job.id);
  await queue.saveExtraction({ jobId: job.id, inputHash: inputHash(input), extraction: extractionFixture(h.evidenceId), provenance: provenance() }, job.claimToken);
  const decision = decisionFixture(h.evidenceId); decision.companyMatch = { outcome: 'matched', companyId: h.ticket.companyId!, confidence: 1 }; decision.lane = { outcome: 'propose', targetLane: 'Integrations', evidenceIds: [h.evidenceId], reason: 'Synthetic actual pilot evidence', nextAction: null };
  await queue.complete(job.id, decision, provenance('vercel'), job.claimToken); await h.proposals.recoverDecisionIntents(); await h.proposals.recoverDecisionIntents();
  const proposals = await h.proposals.list({}); expect(proposals.items).toHaveLength(1); expect(proposals.items[0]).toMatchObject({ origin: 'jev', decision: 'pending', applyState: 'not_requested', lastError: 'control_chat_missing' });
  expect((await h.db.query('SELECT status FROM analysis_jobs WHERE id=$1', [job.id])).rows[0]!.status).toBe('completed'); expect(h.moves()).toBe(0);
});
it('recovers older committed analysis recommendation without inventing an approval', async () => {
  const h = await setup(); await h.db.query("UPDATE analysis_jobs SET decision=jsonb_set(decision,'{lane}',$1::jsonb) WHERE status='completed'", [JSON.stringify({ outcome: 'propose', targetLane: 'Integrations', reason: 'Synthetic prior recommendation', evidenceIds: [h.evidenceId], nextAction: null })]);
  await h.proposals.recoverDecisionIntents(); await h.proposals.recoverDecisionIntents(); expect((await h.proposals.list({})).items).toHaveLength(1); expect(await h.service.applyNext()).toBeNull();
});
it('marks stale historical analysis intents instead of repeatedly blocking newer recovery work', async () => {
  const h = await setup(); await h.db.query("UPDATE analysis_jobs SET decision=jsonb_set(decision,'{lane}',$1::jsonb) WHERE status='completed'", [JSON.stringify({ outcome: 'propose', targetLane: 'Integrations', reason: 'Synthetic prior recommendation', evidenceIds: [h.evidenceId], nextAction: null })]);
  await h.db.query('UPDATE messages SET version=version+1 WHERE chat_id=-1001'); await h.proposals.recoverDecisionIntents(); await h.proposals.recoverDecisionIntents();
  expect((await h.proposals.list({})).items).toHaveLength(0); expect((await h.db.query("SELECT value FROM app_settings WHERE key LIKE 'workflow:decision-proposal:%'")).rows[0]!.value).toMatchObject({ state: 'stale' });
});
