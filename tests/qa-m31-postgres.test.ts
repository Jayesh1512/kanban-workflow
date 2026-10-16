import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqlAnalysisQueue } from '../src/workflow/analysis.js';
import { processAnalysisOnce } from '../src/workflow/processor.js';
import { checkpoint, company, decision, enqueue, isolatedDatabase, provenance, repository, seed, sourceInput } from './qa-m31-support.js';
import type { ExtractionPort, JevPort } from '../src/shared/ports.js';

const project = process.env['QA_M31_PROJECT'];
const unavailable = { ok: false as const, code: 'entitlement' as const, retryable: false, retryAt: null, detail: 'QA-SYNTHETIC-secret-must-not-persist' };
describe.skipIf(!project)('independent M3.1 real PostgreSQL (random schema, no external models)', () => {
  let fixture: Awaited<ReturnType<typeof isolatedDatabase>>; let now: Date;
  beforeEach(async () => { fixture = await isolatedDatabase(project!); now = new Date('2026-10-21T00:00:00Z'); });
  afterEach(async () => { await fixture?.close(); });
  const clock = { now: () => now };
  const claim = (q: SqlAnalysisQueue, leaseMs = 60000) => q.claim({ workerId: 'same-qa-worker', leaseMs });

  it('persists a checkpoint across pool reopen, pauses without entitlement loops, reuses on explicit replay', async () => {
    await seed(fixture.db, sourceInput('rel-003'));
    let q = new SqlAnalysisQueue(fixture.db, clock); const first = (await claim(q))!;
    const saved = await checkpoint(q, first); await q.fail(first.id, unavailable, first.claimToken);
    const db = await fixture.reopen(); q = new SqlAnalysisQueue(db, clock);
    expect(await q.getExtraction(first.id)).toEqual(saved.value);
    expect(await claim(q)).toBeNull(); expect(await claim(q)).toBeNull();
    expect((await db.query('SELECT status,last_error,decision FROM analysis_jobs')).rows).toEqual([{ status: 'provider_unavailable', last_error: 'provider_entitlement', decision: null }]);
    expect(JSON.stringify((await db.query('SELECT * FROM analysis_jobs')).rows)).not.toContain(unavailable.detail);
    expect(await q.replayUnavailable({ idempotencyKey: 'operator-replay' })).toEqual({ queued: 1 });
    let extractions = 0, decisions = 0;
    const extractor: ExtractionPort = { status: async () => { throw Error('unused'); }, extract: async () => { extractions++; throw Error('checkpoint must be reused'); } };
    const jev: JevPort = { status: async () => { throw Error('unused'); }, decide: async (i) => { decisions++; return { ok: true, value: decision(i), provenance: provenance('vercel') }; } };
    expect(await processAnalysisOnce({ queue: q, extraction: extractor, jev }, { workerId: 'same-qa-worker', leaseMs: 60000 })).toBe(true);
    expect([extractions, decisions]).toEqual([0,1]); expect((await db.query('SELECT status,attempts FROM analysis_jobs')).rows).toEqual([{ status: 'completed', attempts: 2 }]);
    expect((await db.query('SELECT * FROM tickets')).rows).toEqual([]);
  });

  it('rejects every original callback after same-worker expiry/reclaim across independent pools', async () => {
    await seed(fixture.db, sourceInput('rel-007'));
    const oldQ = new SqlAnalysisQueue(fixture.db, clock), freshQ = new SqlAnalysisQueue(fixture.peer(), clock);
    const old = (await claim(oldQ, 10))!, saved = await checkpoint(oldQ, old);
    now = new Date(now.getTime() + 11); const fresh = (await claim(freshQ))!;
    expect(fresh.id).toBe(old.id); expect(fresh.claimToken).not.toBe(old.claimToken);
    await freshQ.saveExtraction({ ...saved.value, extraction: { ...saved.value.extraction, summary: 'New immutable attempt' } }, fresh.claimToken);
    const before = (await fixture.db.query('SELECT * FROM analysis_jobs')).rows;
    const outcomes = await Promise.allSettled([oldQ.saveExtraction(saved.value, old.claimToken), oldQ.complete(old.id, decision(saved.input), provenance('vercel'), old.claimToken), oldQ.fail(old.id, unavailable, old.claimToken)]);
    expect(outcomes.map((x) => x.status)).toEqual(['rejected','rejected','rejected']);
    expect((await fixture.db.query('SELECT * FROM analysis_jobs')).rows).toEqual(before);
    await freshQ.complete(fresh.id, decision(saved.input), provenance('vercel'), fresh.claimToken);
  });

  it.each(['exclusion','edit','delete','mapping','context','directory'] as const)('invalidates in-flight save/complete after %s, with no partial fact writes', async (kind) => {
    await seed(fixture.db, sourceInput('rel-028', 1)); const q = new SqlAnalysisQueue(fixture.db, clock), job = (await claim(q))!;
    const saved = await checkpoint(q, job); const count = (await fixture.db.query('SELECT count(*)::int n FROM facts')).rows;
    // A second real connection commits while the provider is conceptually outside the transaction.
    const other = fixture.peer();
    if (kind === 'exclusion') await other.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1");
    if (kind === 'edit') await other.query('UPDATE messages SET text=$1,version=version+1', [sourceInput('rel-028').messages[0]!.text]);
    if (kind === 'delete') await other.query('UPDATE messages SET deleted_at=now(),version=version+1');
    if (kind === 'mapping') await other.query('UPDATE chats SET mapping_version=mapping_version+1');
    if (kind === 'context') await other.query("INSERT INTO messages(chat_id,id,sent_at,text) SELECT id,102,now(),'New context changes the analysis input' FROM chats");
    if (kind === 'directory') await company(other);
    await expect(q.saveExtraction(saved.value, job.claimToken)).rejects.toThrow();
    await expect(q.complete(job.id, decision(saved.input), provenance('vercel'), job.claimToken)).rejects.toThrow();
    expect((await fixture.db.query('SELECT count(*)::int n FROM facts')).rows).toEqual(count);
    expect((await fixture.db.query('SELECT decision FROM analysis_jobs')).rows).toEqual([{ decision: null }]);
    if (['context','directory'].includes(kind)) expect(await q.getExtraction(job.id)).toBeNull();
    else await expect(q.getExtraction(job.id)).rejects.toThrow();
  });

  it('replays a changed context with fresh extraction, while excluded old jobs cannot be revived', async () => {
    await seed(fixture.db, sourceInput('rel-009')); const q = new SqlAnalysisQueue(fixture.db, clock), job = (await claim(q))!;
    await checkpoint(q, job); await q.fail(job.id, unavailable, job.claimToken);
    await fixture.db.query("INSERT INTO messages(chat_id,id,sent_at,text) SELECT id,102,now(),'Follow-up context' FROM chats");
    await q.replayUnavailable({ idempotencyKey: 'context-replay' });
    let calls = 0;
    await processAnalysisOnce({ queue: q, extraction: { status: async () => { throw Error('unused'); }, extract: async (input) => { calls++; const { echoExtraction } = await import('./qa-m31-support.js'); return { ok: true, value: echoExtraction(input), provenance: provenance() }; } }, jev: { status: async () => { throw Error('unused'); }, decide: async () => unavailable } }, { workerId: 'same-qa-worker', leaseMs: 60000 });
    expect(calls).toBe(1);
    await fixture.db.query("UPDATE chats SET inclusion='excluded',policy_version=policy_version+1");
    expect(await q.replayUnavailable({ idempotencyKey: 'excluded-replay' })).toEqual({ queued: 0 }); expect(await claim(q)).toBeNull();
  });

  it('keeps manual mapping, action and completed fact through reanalysis; never moves a lane', async () => {
    const src = sourceInput('rel-035'); await seed(fixture.db, src); const companyId = await company(fixture.db, src.chat.id);
    await fixture.db.query("INSERT INTO mapping_history(chat_id,company_id,mapping_status,version,reason,source) VALUES($1,$2,'confirmed',0,'QA operator corrected explicit evidence','http')", [src.chat.id, companyId]);
    const records = repository(fixture.db), t = await records.ensureTicket(src.chat.id);
    await fixture.db.query("UPDATE tickets SET lane='Integrations',stage_version=5 WHERE id=$1", [t.id]);
    const q = new SqlAnalysisQueue(fixture.db, clock); let job = (await claim(q))!;
    const saved = await checkpoint(q, job, (x) => { x.facts[0]!.kind = 'commitment'; x.facts[0]!.actor.party = 'antseed'; });
    await q.complete(job.id, decision(saved.input), provenance('vercel'), job.claimToken);
    const fact = (await records.listFacts({ ticketId: t.id })).items[0]!;
    await records.updateFact({ idempotencyKey: 'complete', factId: fact.id, expectedVersion: fact.version, actor: fact.actor, state: 'completed', answersFactId: null, evidenceIds: fact.evidenceIds, dates: [] });
    await records.updateActions({ idempotencyKey: 'manual-action', ticketId: t.id, expectedActionsVersion: (await records.getTicket(t.id)).actionsVersion, nextAction: 'Operator owns this next step', followUpAt: '2026-10-30T04:30:00Z', etaAt: null, evidenceIds: fact.evidenceIds });
    await enqueue(fixture.db, src.chat.id); job = (await claim(q))!;
    const next = await checkpoint(q, job, (x) => { x.facts[0]!.kind = 'commitment'; x.facts[0]!.actor.party = 'antseed'; });
    const d = decision(next.input); d.companyMatch = { outcome: 'new_company', candidates: [] }; d.lane = { outcome: 'propose', targetLane: 'Completed', reason: 'Synthetic recommendation is not approval', evidenceIds: fact.evidenceIds, nextAction: null };
    await q.complete(job.id, d, provenance('vercel'), job.claimToken);
    expect(await records.getTicket(t.id)).toMatchObject({ companyId, lane: 'Integrations', stageVersion: 5, actionsSource: 'manual', nextAction: 'Operator owns this next step', followUpAt: '2026-10-30T04:30:00.000Z' });
    expect((await records.listFacts({ ticketId: t.id })).items).toMatchObject([{ id: fact.id, state: 'completed', source: 'manual' }]);
    expect((await fixture.db.query('SELECT source FROM mapping_history')).rows).toEqual([{ source: 'http' }]);
    expect((await fixture.db.query('SELECT * FROM proposals')).rows).toEqual([]);
  });

  it('uses shared contact/company across corpus chats 026/027 with scoped message101 evidence and persistent contact roles', async () => {
    const a = sourceInput('rel-026'), b = sourceInput('rel-027'); await seed(fixture.db, a); await seed(fixture.db, b);
    const companyId = await company(fixture.db); const q = new SqlAnalysisQueue(fixture.db, clock);
    for (let i = 0; i < 2; i++) {
      const job = (await claim(q))!; const saved = await checkpoint(q, job, (x) => { x.contacts = [{ telegramUserIds: ['990000002'], names: ['Noor Mehta'], usernames: [], phones: [], emails: [], affiliation: i === 0 ? 'external' : 'unknown', roles: [], evidenceIds: x.evidenceIds }]; });
      await q.complete(job.id, decision(saved.input, companyId), provenance('vercel'), job.claimToken);
    }
    const db = await fixture.reopen(), records = repository(db); const tickets = (await records.listTickets({})).items;
    expect(tickets).toHaveLength(2); expect(new Set(tickets.map((t) => t.companyId))).toEqual(new Set([companyId]));
    expect(tickets[0]!.contactIds).toEqual(tickets[1]!.contactIds); expect(tickets[0]!.contactIds).toHaveLength(1);
    expect((await records.listContacts({})).items).toHaveLength(1);
    const contexts = await Promise.all(tickets.map((t) => records.getContext({ ticketId: t.id, limit: 10 })));
    expect(contexts.map((c) => c.messages[0]!.id)).toEqual([101,101]);
    expect(contexts[0]!.evidence[0]!.id).not.toBe(contexts[1]!.evidence[0]!.id);
    expect(contexts.every((c) => c.evidence.every((e) => e.chatId === c.chat.id))).toBe(true);
    const contact = contexts[0]!.contacts[0]!, e = contexts[0]!.evidence[0]!;
    const changed = await records.updateContact(contact.id, contact.version, { idempotencyKey: 'operator-role', telegramUserIds: contact.telegramUserIds, names: contact.names, usernames: [], phones: [], emails: [], affiliation: 'external', evidenceIds: contact.evidenceIds, roles: [{ companyId, role: 'technical evaluator (operator correction)', evidenceIds: [e.id] }] });
    expect((await records.getContact(changed.id)).roles).toMatchObject([{ companyId, contactId: contact.id, role: 'technical evaluator (operator correction)' }]);
  });

  it('returns exact date-only day in facts/context and ranks at IST midnight without promoting external/completed work', async () => {
    expect(process.env['TZ'], 'Run this regression with explicit TZ=Asia/Kolkata').toBe('Asia/Kolkata');
    const src = sourceInput('rel-035'); await seed(fixture.db, src); await company(fixture.db, src.chat.id);
    const q = new SqlAnalysisQueue(fixture.db, clock), job = (await claim(q))!;
    const saved = await checkpoint(q, job, (x) => { x.facts[0]!.kind = 'commitment'; x.facts[0]!.actor.party = 'antseed'; x.facts[0]!.dates = [{ kind: 'commitment', originalText: 'tomorrow', relativeTo: src.messages[0]!.sentAt, timezone: 'Asia/Kolkata', localDate: '2026-10-18', resolvedAt: null, precision: 'date', ambiguous: false, evidenceIds: x.evidenceIds }]; });
    await q.complete(job.id, decision(saved.input), provenance('vercel'), job.claimToken);
    const db = await fixture.reopen(), records = repository(db, '2026-10-18T18:31:00Z'), t = (await records.listTickets({})).items[0]!;
    const facts = (await records.listFacts({ ticketId: t.id })).items; expect(facts[0]!.dates[0]).toMatchObject({ localDate: '2026-10-18', precision: 'date', resolvedAt: null });
    expect((await records.getContext({ ticketId: t.id, limit: 10 })).facts[0]!.dates).toEqual(facts[0]!.dates);
    expect((await records.priorities({ limit: 10, timezone: 'Asia/Kolkata' }))[0]).toMatchObject({ urgency: 'urgent', reasons: ['commitment','overdue'] });
    expect((await records.priorities({ limit: 10, timezone: 'UTC' }))[0]).toMatchObject({ urgency: 'normal', reasons: ['commitment','upcoming'] });
    expect(await records.priorities({ limit: 10 })).toEqual(await records.priorities({ limit: 10 }));
    await db.query("UPDATE facts SET actor_party='external' WHERE parent_fact_id IS NULL"); expect(await records.priorities({ limit: 10 })).toEqual([]);
    await db.query("UPDATE facts SET actor_party='antseed',state='completed' WHERE parent_fact_id IS NULL"); expect(await records.priorities({ limit: 10 })).toEqual([]);
    await db.query("UPDATE facts SET state='open' WHERE parent_fact_id IS NULL"); await db.query("UPDATE tickets SET lane='Archived'"); expect(await records.priorities({ limit: 10 })).toEqual([]);
  });
  it('serializes manual fact correction versus analysis without PG40P01 or loss of manual precedence', async () => {
    const src = sourceInput('rel-035'); await seed(fixture.db, src); await company(fixture.db, src.chat.id);
    const q = new SqlAnalysisQueue(fixture.db, clock), initial = (await claim(q))!;
    const saved = await checkpoint(q, initial); await q.complete(initial.id, decision(saved.input), provenance('vercel'), initial.claimToken);
    const records = repository(fixture.db), ticket = (await records.listTickets({})).items[0]!;
    const fact = (await records.listFacts({ ticketId: ticket.id })).items[0]!;
    await enqueue(fixture.db, src.chat.id); const job = (await claim(q))!;
    const input = await q.loadInput(job.id); const extraction = (await import('./qa-m31-support.js')).echoExtraction(input);
    const pending = { jobId: job.id, inputHash: (await import('../src/workflow/analysis.js')).inputHash(input), extraction, provenance: provenance() };
    const gateKey = `qa-manual-${job.id}`;
    await fixture.db.query(`CREATE FUNCTION qa_pause_manual() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='manual' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}',0)); END IF; RETURN NEW; END $$`);
    await fixture.db.query('CREATE TRIGGER qa_pause BEFORE UPDATE ON facts FOR EACH ROW EXECUTE FUNCTION qa_pause_manual()');
    const gate = await fixture.db.pool.connect(); await gate.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [gateKey]);
    const manualDb = fixture.peer(), analysisDb = fixture.peer();
    const manual = repository(manualDb).updateFact({ idempotencyKey: 'manual-race', factId: fact.id, expectedVersion: fact.version, actor: fact.actor, state: 'completed', evidenceIds: fact.evidenceIds, dates: [], answersFactId: null });
    // Attach immediately so a deliberately reproduced database rejection is always handled.
    const settledManual = manual.then(() => ({ ok: true, code: null }), (e: { code?: string }) => ({ ok: false, code: e.code }));
    let analysis: ReturnType<SqlAnalysisQueue['saveExtraction']> | undefined;
    let settledAnalysis: Promise<{ ok: boolean; code: string | null | undefined }> | undefined;
    try {
      let paused = false;
      for (let n=0;n<100;n++) {
        paused = (await fixture.db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE 'UPDATE facts SET actor_party%'")).rows.length > 0;
        if (paused) break; await new Promise((r)=>setTimeout(r,10));
      }
      expect(paused).toBe(true);
      analysis = new SqlAnalysisQueue(analysisDb, clock).saveExtraction(pending, job.claimToken);
      settledAnalysis = analysis.then(() => ({ ok: true, code: null }), (e: { code?: string }) => ({ ok: false, code: e.code }));
      // Both implementations must now wait at a real PG row lock; the gate determines ordering.
      let blocked = false;
      for (let n=0;n<100;n++) {
        blocked = (await fixture.db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event<>'advisory' AND state='active'")).rows.length > 0;
        if (blocked) break; await new Promise((r)=>setTimeout(r,10));
      }
      expect(blocked).toBe(true);
      await gate.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [gateKey]);
      expect(await Promise.all([settledManual, settledAnalysis])).toEqual([{ ok: true, code: null }, { ok: true, code: null }]);
      expect((await records.listFacts({ ticketId: ticket.id })).items.find((f)=>f.id===fact.id)).toMatchObject({ source: 'manual', state: 'completed' });
      const current = (await fixture.db.query('SELECT status,last_error FROM analysis_jobs WHERE id=$1',[job.id])).rows[0]!;
      expect(current).toEqual({ status: 'running', last_error: null });
      // If context changed conservatively, lease expiry must still allow recovery rather than entitlement pause.
      now = new Date(now.getTime()+60001); expect((await claim(q))?.id).toBe(job.id);
    } finally {
      await gate.query('SELECT pg_advisory_unlock_all()'); gate.release();
      await settledManual; await settledAnalysis;
    }
  });

  it('keeps actual transient PostgreSQL40001 recoverable instead of blaming provider schema/entitlement', async () => {
    await seed(fixture.db, sourceInput('rel-003'));
    await fixture.db.query('CREATE SEQUENCE qa_fail_once');
    await fixture.db.query("CREATE FUNCTION qa_transient_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF nextval('qa_fail_once')=1 THEN RAISE EXCEPTION 'QA actual PG transient injection' USING ERRCODE='40001'; END IF; RETURN NEW; END $$");
    await fixture.db.query('CREATE TRIGGER qa_transient BEFORE INSERT ON facts FOR EACH ROW EXECUTE FUNCTION qa_transient_once()');
    const q = new SqlAnalysisQueue(fixture.db, clock);
    const extraction: ExtractionPort = { status: async () => { throw Error('unused'); }, extract: async (input) => ({ ok: true, value: (await import('./qa-m31-support.js')).echoExtraction(input), provenance: provenance() }) };
    const jev: JevPort = { status: async () => { throw Error('unused'); }, decide: async (input) => ({ ok: true, value: decision(input), provenance: provenance('vercel') }) };
    await processAnalysisOnce({ queue: q, extraction, jev }, { workerId: 'same-qa-worker', leaseMs: 60000 });
    const row = (await fixture.db.query('SELECT status,last_error FROM analysis_jobs')).rows[0]!;
    expect(row.status).toBe('retry'); expect(row.last_error).not.toBe('provider_invalid_response');
    now = new Date(now.getTime()+60001);
    await processAnalysisOnce({ queue: q, extraction, jev }, { workerId: 'same-qa-worker', leaseMs: 60000 });
    expect((await fixture.db.query('SELECT status,attempts FROM analysis_jobs')).rows).toEqual([{ status:'completed',attempts:2 }]);
  });

});
