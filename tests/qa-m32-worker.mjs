// QA-only disposable domain worker. Private test DB URL/service JWT arrive on stdin,
// never argv/logs. Only bounded phase names and fixture UUIDs leave this process.
import { PgDatabase } from '../dist/platform/database.js';
import { RecordsRepository } from '../dist/workflow/records.js';
import { ProposalRepository } from '../dist/workflow/proposals.js';
import { SqlMutationStore } from '../dist/workflow/mutations.js';
import { TicketProjector } from '../dist/workflow/projection.js';
import { ProposalWorkflow } from '../dist/workflow/apply.js';
import { VikunjaAdapter } from '../dist/vikunja/adapter.js';
import { DurableControlBus } from '../dist/telegram/control.js';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw); raw = '';
const db = new PgDatabase(input.databaseUrl);
const clock = { now: () => new Date(input.now) };
function pause(phase, ids = {}) {
  process.stdout.write(`${JSON.stringify({ phase, ...ids })}\n`);
  return new Promise(() => { setInterval(() => {}, 1000); });
}
try {
  const forbiddenTelegram = new Proxy({}, { get() { throw new Error('No Telegram transport in QA crash worker'); } });
  const bus = new DurableControlBus(db, forbiddenTelegram);
  if (input.phase === 'before-proposal-commit') {
    const enqueue = bus.enqueueProposal.bind(bus);
    bus.enqueueProposal = async (...args) => { await enqueue(...args); await pause(input.phase); };
  }
  const records = new RecordsRepository(db, clock), adapter = new VikunjaAdapter(input.vikunja, db);
  const proposals = new ProposalRepository(db, bus, clock), mutations = new SqlMutationStore(db, clock);
  const service = new ProposalWorkflow(proposals, mutations, adapter, new TicketProjector(db, adapter, records, clock));
  const p = await service.propose({ idempotencyKey: `qa-crash:${input.phase}`, ticketId: input.ticketId, expectedStageVersion: 0, targetLane: 'Completed', evidenceIds: [input.evidenceId], reason: 'Synthetic QA crash boundary', nextAction: null, origin: 'manual' });
  if (input.phase === 'after-proposal-commit') await pause(input.phase, { proposalId: p.id });
  await service.decide({ idempotencyKey: 'qa-crash-approval', proposalId: p.id, decision: 'approve' });
  if (input.phase === 'after-decision-commit') await pause(input.phase, { proposalId: p.id });
  if (input.phase === 'after-journal-commit') {
    await mutations.withOwnedTicket(input.ticketId, async () => { const m = await mutations.prepare(p.id); await pause(input.phase, { proposalId: p.id, mutationId: m.id }); });
  }
  if (input.phase === 'after-confirm-before-local') {
    const confirm = mutations.confirmRemote.bind(mutations);
    mutations.confirmRemote = async (...args) => { const m = await confirm(...args); await pause(input.phase, { proposalId: p.id, mutationId: m.id }); return m; };
  }
  if (input.phase === 'after-local-before-ack') {
    const commit = mutations.commit.bind(mutations);
    mutations.commit = async (...args) => { const result = await commit(...args); await pause(input.phase, { proposalId: p.id, mutationId: args[0] }); return result; };
  }
  await service.applyNext();
  throw new Error('Expected controlled crash boundary was not reached');
} catch (error) {
  process.stdout.write(`${JSON.stringify({ phase: 'error', code: typeof error?.code === 'string' ? error.code : 'qa_worker_error' })}\n`);
  await db.close(); process.exitCode = 1;
}
