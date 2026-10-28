import { randomBytes } from 'node:crypto';
import type { Clock, ControlBus, ControlMessage, Database, RemoteTask, VikunjaPort } from '../../src/shared/ports.js';
import { LANES, WORKSTREAMS } from '../../src/shared/domain.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { SqlMutationStore, ticketLockKey } from '../../src/workflow/mutations.js';
import { TicketProjector } from '../../src/workflow/projection.js';
import { ProposalWorkflow } from '../../src/workflow/apply.js';
import { decisionFixture, extractionFixture, provenance } from '../intelligence/fixtures.js';
import { fixtureDatabase } from './database.js';
import { schedulingDatabase } from './locking-fixture.js';

export async function workflowHarness(options?: { db: Database; vikunja: VikunjaPort; clock?: Clock }) {
  const scheduling = options ? { db: options.db, disconnect() { throw new Error('Real PostgreSQL loss must be injected through pg_terminate_backend'); } } : schedulingDatabase(await fixtureDatabase()); const db = scheduling.db;
  let time = new Date('2026-10-17T00:00:00Z'); const clock = options?.clock ?? { now: () => time }; const records = new RecordsRepository(db, clock);
  const handlers = new Set<(message: ControlMessage) => Promise<void>>();
  const control: ControlBus = { subscribe(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; }, async enqueueProposal(tx, input) {
    const configured = (await tx.query('SELECT id FROM chats WHERE id=$1 AND is_control', [input.chatId])).rows[0]; if (!configured) throw new Error('Test control chat not configured');
    await tx.query(`INSERT INTO control_outbox(proposal_id,chat_id,text,random_id) VALUES($1,$2,$3,$4) ON CONFLICT(proposal_id,chat_id) DO NOTHING`, [input.proposalId, input.chatId, `${input.text}\n[antseed-proposal:${input.proposalId}]`, BigInt.asIntN(64, BigInt(`0x${randomBytes(8).toString('hex')}`)).toString()]);
  } };
  const proposals = new ProposalRepository(db, control, clock); const mutations = new SqlMutationStore(db, clock, 60000);
  const queue = new SqlAnalysisQueue(db, clock); const job = (await queue.claim({ workerId: 'fixture', leaseMs: 60000 }))!;
  const input = await queue.loadInput(job.id); const extraction = extractionFixture(input.evidence[0]!.id);
  await queue.saveExtraction({ jobId: job.id, inputHash: inputHash(input), extraction, provenance: provenance() }, job.claimToken);
  await queue.complete(job.id, decisionFixture(input.evidence[0]!.id), provenance('vercel'), job.claimToken);
  const ticket = (await records.listTickets({})).items[0]!;
  const buckets = Object.fromEntries(LANES.map((lane, i) => [lane, String(i + 1)])) as Record<(typeof LANES)[number], string>;
  const labels = Object.fromEntries(WORKSTREAMS.map((work, i) => [work, String(i + 10)])) as Record<(typeof WORKSTREAMS)[number], string>;
  if (!options) await db.query('INSERT INTO board_bindings(project_id,view_id) VALUES(1,1)');
  if (!options) for (const [lane, id] of Object.entries(buckets)) await db.query('INSERT INTO board_buckets(lane,bucket_id) VALUES($1,$2)', [lane, id]);
  const tasks = new Map<string, RemoteTask>(); let moves = 0; let failAfterMove = false;
  const vikunja: VikunjaPort = options?.vikunja ?? {
    async status() { return { state: 'ready', code: null, detail: 'Deterministic fake; no real Vikunja', checkedAt: clock.now().toISOString() }; },
    async ensureBoard() { return { projectId: '1', viewId: '1', buckets, labels }; },
    async ensureTask(input) { return db.withSessionLock(ticketLockKey(input.ticketId), async () => {
      const task = tasks.get(input.ticketId) ?? { id: '1', projectId: '1', bucketId: '1', title: input.title, description: input.description, updatedAt: clock.now().toISOString() }; tasks.set(input.ticketId, task); return { ...task };
    }); },
    async getTask(id) { const task = [...tasks.values()].find((t) => t.id === id); return task ? { ...task } : null; },
    async updateTaskDetails(input) { const task = [...tasks.values()].find((t) => t.id === input.taskId); if (!task) throw new Error('missing fake task'); task.title = input.title; task.description = input.description; return { ...task }; },
    async moveTask(input) { const task = [...tasks.values()].find((t) => t.id === input.taskId); if (!task) throw new Error('missing fake task'); moves++; task.bucketId = input.targetBucketId; if (failAfterMove) { failAfterMove = false; throw new Error('Injected remote accepted / response lost'); } },
    async retireTask(input) { const entry = [...tasks.entries()].find(([, task]) => task.id === input.taskId); if (entry) tasks.delete(entry[0]); },
  };
  const projector = new TicketProjector(db, vikunja, records, clock); const service = new ProposalWorkflow(proposals, mutations, vikunja, projector);
  return { db, clock, records, proposals, mutations, service, projector, vikunja, ticket, evidenceId: input.evidence[0]!.id, tasks, control, handlers, disconnect: scheduling.disconnect,
    advance(ms: number) { time = new Date(time.getTime() + ms); }, failMoveResponseOnce() { failAfterMove = true; }, moves: () => moves,
    async configureControl() { await db.query("INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES(-2001,'supergroup','Control','excluded',true) ON CONFLICT(id) DO UPDATE SET is_control=true"); },
    async propose(key = 'proposal') { return proposals.propose({ idempotencyKey: key, ticketId: ticket.id, expectedStageVersion: 0, targetLane: 'Integrations', evidenceIds: [input.evidence[0]!.id], reason: 'Synthetic pilot test evidence', nextAction: null, origin: 'manual' }); },
  };
}
