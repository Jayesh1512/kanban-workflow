import Fastify from 'fastify';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionPort, JevPort, PlatformServices } from '../src/shared/ports.js';
import { createWorkflowModule } from '../src/workflow/module.js';
import { createJevAdapter } from '../src/intelligence/jev.js';
import { SqlAnalysisQueue } from '../src/workflow/analysis.js';
import { processAnalysisOnce } from '../src/workflow/processor.js';
import { resetJevBreaker, seedKnownJevRestriction, withDurableJevBreaker } from '../src/workflow/breaker.js';
import { company, echoExtraction, enqueue, isolatedDatabase, provenance, seed, sourceInput } from './qa-m31-support.js';
import { configuration, fixture, forbidden, project, type Fixture } from './qa-m32-support.js';

describe.skipIf(!project)('QA M3.2 exact migration gate, actual PG scheduler/control ingress', () => {
  let h: Fixture | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });
  it.each(['checksum', 'unknown-ledger', 'missing-ledger'] as const)('%s blocks scheduler AND control decision before any domain effect', async (drift) => {
    h = await fixture(); const p = await h.propose(); await h.bus.tick(); await h.reply(901, 'approve');
    if (drift === 'checksum') await h.db.query("UPDATE schema_migrations SET checksum=repeat('0',64)");
    if (drift === 'unknown-ledger') await h.db.query("INSERT INTO schema_migrations(version,checksum) VALUES('999999999999_qa_unknown.sql',repeat('0',64))");
    if (drift === 'missing-ledger') await h.db.query('DELETE FROM schema_migrations WHERE version=(SELECT max(version) FROM schema_migrations)');
    const settingsBefore = (await h.db.query('SELECT * FROM app_settings ORDER BY key')).rows;
    let remoteCalls = 0; const vikunja = new Proxy(h.adapter, { get(target, key) { const value = Reflect.get(target, key); if (typeof value !== 'function') return value; return (...args: unknown[]) => { remoteCalls++; return value.apply(target, args); }; } });
    const platform: PlatformServices = { db: h.db, config: h.config, clock: h.clock, control: h.bus, telegram: h.telegram, vikunja, chats: forbidden(), ingestion: forbidden() };
    const module = await createWorkflowModule(platform), app = Fastify();
    try {
      await module.register(app); await module.start();
      for (let i = 0; i < 100 && (await module.status()).code === 'not_started'; i++) await delay(10);
      expect((await module.status()).code).toBe(drift === 'missing-ledger' ? 'database_pending' : 'migration_drift');
      await h.bus.tick();
      expect((await h.service.get(p.id)).decision).toBe('pending'); expect((await h.db.query('SELECT * FROM proposal_decisions')).rows).toHaveLength(0);
      expect((await h.db.query('SELECT * FROM mutations')).rows).toHaveLength(0); expect((await h.db.query('SELECT * FROM app_settings ORDER BY key')).rows).toEqual(settingsBefore);
      expect((await h.db.query('SELECT state FROM control_inbox')).rows).toEqual([{ state: 'pending' }]);
      expect(remoteCalls).toBe(0); expect((await h.local()).stageVersion).toBe(0);
      expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
    } finally { await module.stop(); await app.close(); }
  });
});

describe.skipIf(!project)('QA M3.2 durable Jev pause/replay, actual PG + localhost HTTP stand-in ONLY', () => {
  it('bootstrapped known restriction makes zero requests; credential rotation/restart do not bypass; explicit replay reuses current checkpoint', async () => {
    const f = await isolatedDatabase(project!, true), config = structuredClone(await configuration()); config.jev.apiKey = 'QA-synthetic-credential';
    const clock = { now: () => new Date() }; const src = sourceInput('rel-004'); await seed(f.db, src); await company(f.db, src.chat.id);
    let calls = 0, extracts = 0, mode: 'denied' | 'success' = 'denied';
    const server = createServer(async (req, res) => {
      let text = ''; for await (const chunk of req) text += chunk.toString(); calls++;
      if (mode === 'denied') { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'no_providers_available', type: 'RestrictedModelsError' } })); return; }
      const body = JSON.parse(text), answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(body.questions) as Array<[string, any]>) {
        if (q.type === 'noul') answers[key] = { type: 'noul', noul: .99 };
        if (q.type === 'choice') { const selected = ({ relevance: 'company', company_match: 'existing_0', workstream: 'Buyer', lane: 'no_change' } as Record<string, string>)[key]!; answers[key] = { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((x) => [x, x === selected ? 1 : 0])) }; }
        if (q.type === 'score') answers[key] = { type: 'score', score: 1, confidence: 1, legend: Object.fromEntries(q.criteria.map((x: string, i: number) => [String(i), x])), probabilities: { '0': 0, '1': 1, '2': 0, '3': 0 } };
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: 'typesafe-ai/jev', answers }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const transport: typeof fetch = (endpoint, init) => { expect(String(endpoint)).toBe(config.jev.endpoint); return fetch(`${url}${new URL(String(endpoint)).pathname}`, init); };
    const extraction: ExtractionPort = { status: async () => ({ state: 'ready', code: null, detail: 'QA-authored extraction, no model', checkedAt: clock.now().toISOString() }), async extract(input) { extracts++; return { ok: true, value: echoExtraction(input), provenance: provenance() }; } };
    let queue = new SqlAnalysisQueue(f.db, clock, config.timezone, { onReplay: resetJevBreaker });
    let jev = withDurableJevBreaker(f.db, createJevAdapter(config.jev, { fetch: transport, clock }), config, clock);
    const once = () => processAnalysisOnce({ queue, extraction, jev }, { workerId: 'qa-breaker', leaseMs: 60000 });
    try {
      await seedKnownJevRestriction(f.db, config, clock); await once(); expect(calls).toBe(0); expect(extracts).toBe(1);
      expect((await f.db.query('SELECT status,extraction IS NOT NULL saved FROM analysis_jobs')).rows).toEqual([{ status: 'provider_unavailable', saved: true }]);
      const db = await f.reopen(); config.jev.apiKey = 'QA-rotated-synthetic-credential';
      queue = new SqlAnalysisQueue(db, clock, config.timezone, { onReplay: resetJevBreaker }); jev = withDurableJevBreaker(db, createJevAdapter(config.jev, { fetch: transport, clock }), config, clock);
      await seedKnownJevRestriction(db, config, clock); await enqueue(db, src.chat.id, src.messages[0]!.id); await once();
      expect(calls).toBe(0); expect(extracts).toBe(2); expect(await once()).toBe(false); expect((await jev.status()).code).toBe('provider_entitlement');
      expect(await queue.replayUnavailable({ idempotencyKey: 'qa-authorized-replay-denied' })).toEqual({ queued: 2 });
      await seedKnownJevRestriction(db, config, clock); await once(); await once(); expect(calls).toBe(1); expect(extracts).toBe(2); expect(await once()).toBe(false);
      // Keep one current saved job for the recovery check; the second is test-only cancelled.
      await db.query("UPDATE analysis_jobs SET status='cancelled' WHERE id=(SELECT id FROM analysis_jobs ORDER BY created_at DESC LIMIT 1)");
      mode = 'success'; expect(await queue.replayUnavailable({ idempotencyKey: 'qa-authorized-replay-restored' })).toEqual({ queued: 1 });
      await seedKnownJevRestriction(db, config, clock); await once();
      expect(calls).toBe(2); expect(extracts).toBe(2); expect((await db.query("SELECT status FROM analysis_jobs WHERE status<>'cancelled'")).rows).toEqual([{ status: 'completed' }]);
      expect((await db.query('SELECT * FROM proposals')).rows).toHaveLength(0); expect((await db.query('SELECT * FROM mutations')).rows).toHaveLength(0);
      expect(JSON.stringify((await db.query("SELECT value FROM app_settings WHERE key LIKE 'workflow:jev:%'")).rows)).not.toContain('credential');
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await f.close(); }
  });
  it('unhandled upstream interruption leaves a durable uncertain pause across fresh instances without automatic reissue', async () => {
    const f = await isolatedDatabase(project!, true), config = structuredClone(await configuration()), clock = { now: () => new Date() }; config.jev.apiKey = 'QA-no-network';
    let calls = 0; const provider: JevPort = { status: async () => ({ state: 'ready', code: null, detail: 'Synthetic only', checkedAt: clock.now().toISOString() }), async decide() { calls++; throw new Error('Synthetic crash after unknown provider acceptance'); } };
    const input = sourceInput('rel-004'), augmented = { ...input, extraction: echoExtraction(input) };
    try {
      await expect(withDurableJevBreaker(f.db, provider, config, clock).decide(augmented)).rejects.toThrow('Synthetic crash');
      const db = await f.reopen(), restarted = withDurableJevBreaker(db, provider, config, clock);
      expect(await restarted.decide(augmented)).toMatchObject({ ok: false, code: 'unavailable', retryable: false }); expect(calls).toBe(1);
      expect(await restarted.status()).toMatchObject({ state: 'unavailable', code: 'provider_unavailable' });
    } finally { await f.close(); }
  });
});
