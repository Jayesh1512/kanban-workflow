import { describe, expect, it } from 'vitest';
import { fixtureDatabase } from '../workflow/database.js';
import { SqlAnalysisQueue, inputHash } from '../../src/workflow/analysis.js';
import { RecordsRepository } from '../../src/workflow/records.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import type { ControlBus } from '../../src/shared/ports.js';
import { authoredDecision, authoredExtraction, authoredProvenance, messages } from './cedar.js';
import { inspectInventory, manifestSchema } from './config.js';

it('persists authored Cedar source through real analysis/repositories, two shared contacts, date-only facts and one pending review proposal', async () => {
  const db = await fixtureDatabase();
  try {
    const anchor = '2026-10-17T06:00:00.000Z';
    for (const m of messages(anchor)) await db.query(`INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata,reply_to_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(chat_id,id) DO UPDATE SET sent_at=EXCLUDED.sent_at,text=EXCLUDED.text,sender_snapshot=EXCLUDED.sender_snapshot,peer_snapshot=EXCLUDED.peer_snapshot`, [m.chatId, m.id, m.senderId, m.sentAt, m.text, m.sender, m.peer, m.forward, m.replyToId]);
    const clock = { now: () => new Date(anchor) };
    const control: ControlBus = { subscribe() { return () => {}; }, async enqueueProposal() { throw new Error('No control group or live Telegram in demo fixture'); } };
    const proposals = new ProposalRepository(db, control, clock), queue = new SqlAnalysisQueue(db, clock, 'Asia/Kolkata', { onDecision: (tx, input) => proposals.recordAnalysisDecisionTx(tx, input) });
    const job = (await queue.claim({ workerId: 'offline-demo-validation', leaseMs: 60000 }))!; const input = await queue.loadInput(job.id); const extraction = authoredExtraction(input);
    await queue.saveExtraction({ jobId: job.id, inputHash: inputHash(input), extraction, provenance: authoredProvenance('openai', anchor) }, job.claimToken);
    await queue.complete(job.id, authoredDecision(extraction), authoredProvenance('vercel', anchor), job.claimToken);
    const records = new RecordsRepository(db, clock), ticket = (await records.listTickets({})).items[0]!;
    const context = await records.getContext({ ticketId: ticket.id, limit: 20 });
    expect(ticket).toMatchObject({ lane: 'To be started', stageVersion: 0, vikunjaTaskId: null, workstream: 'Buyer' });
    expect(context.contacts.map((c) => c.names[0]).sort()).toEqual(['Jo Rao', 'Mira Sen']); expect(context.contacts.every((c) => c.roles[0]!.companyId === ticket.companyId)).toBe(true);
    expect(context.facts).toHaveLength(2); expect(context.facts.every((f) => f.dates[0]!.localDate === '2026-10-18' && f.dates[0]!.resolvedAt === null)).toBe(true);
    expect(context.messages.every((m) => m.text.startsWith('[SYNTHETIC DEMO]'))).toBe(true); expect(context.evidence).toHaveLength(3);
    expect((await proposals.list({ ticketId: ticket.id })).items).toMatchObject([{ decision: 'pending', applyState: 'not_requested', targetLane: 'Work in progress', origin: 'jev', lastError: 'control_chat_missing' }]);
    expect(Number((await db.query('SELECT count(*) FROM mutations')).rows[0]!.count)).toBe(0);
    const provenance = (await db.query('SELECT extraction_provenance,jev_provenance FROM analysis_jobs WHERE id=$1', [job.id])).rows[0]!;
    expect(provenance.extraction_provenance.model).toBe('authored-fixture/no-live-openai'); expect(provenance.jev_provenance.model).toBe('authored-fixture/no-live-jev');
  } finally { await db.close(); }
});

describe('demo tooling ownership/loopback checks (no Docker or stack access)', () => {
  const m = { project: 'antseed-pm-demo-20261017', directory: '/tmp/owned', override: '/tmp/owned/ports.yaml', aiEnv: '/tmp/owned/ai.env', ports: { backend: 19180, vikunja: 19181, postgres: 19432 } };
  const rows = [
    { Project: m.project, Service: 'postgres', State: 'running', Publishers: [{ URL: '127.0.0.1', TargetPort: 5432, PublishedPort: 19432 }] },
    { Project: m.project, Service: 'vikunja', State: 'running', Publishers: [{ URL: '127.0.0.1', TargetPort: 3456, PublishedPort: 19181 }] },
    { Project: m.project, Service: 'backend', State: 'exited', Publishers: [] },
  ];
  it('requires explicit unique PM project/ports and excludes A/B/QA/default stacks', () => {
    expect(manifestSchema.safeParse(m).success).toBe(true);
    for (const project of ['antseed', 'antseed-builder', 'antseed-qa-m1-test', 'antseed-b-m4-test']) expect(manifestSchema.safeParse({ ...m, project }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...m, ports: { ...m.ports, backend: 19432 } }).success).toBe(false);
  });
  it('requires backend stopped during seed and exact project/loopback service bindings', () => {
    expect(() => inspectInventory(m, JSON.stringify(rows), true)).not.toThrow();
    expect(() => inspectInventory(m, JSON.stringify(rows.map((r) => r.Service === 'backend' ? { ...r, State: 'running' } : r)), true)).toThrow('Stop ONLY');
    expect(() => inspectInventory(m, JSON.stringify(rows.map((r) => ({ ...r, Project: 'other' }))), true)).toThrow('ownership');
    expect(() => inspectInventory(m, JSON.stringify(rows.map((r) => ({ ...r, Publishers: r.Publishers.map((p) => ({ ...p, URL: '0.0.0.0' })) }))), true)).toThrow('loopback');
    expect(() => inspectInventory(m, JSON.stringify(rows), false)).toThrow('running service');
  });
});
