import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { VikunjaAdapter } from '../src/vikunja/adapter.js';
import { ProposalWorkflow } from '../src/workflow/apply.js';
import { TicketProjector } from '../src/workflow/projection.js';
import { deferred, fixture, project, type Fixture } from './qa-m32-support.js';

describe.skipIf(!project)('QA M3.2 real HTTP failures and independent ticket progress', () => {
  let h: Fixture | undefined;
  afterEach(async () => { await h?.close(); h = undefined; });
  it.each([401, 429, 503] as const)('actual HTTP%s prevents effect, retains durable unknown, and later readback/retry commits once', async (status) => {
    h = await fixture(); const p = await h.propose(); await h.approve(p.id); let fault = true, attempted = 0, accepted = 0;
    const server = createServer(async (req, res) => {
      try {
        const body: Buffer[] = []; for await (const c of req) body.push(Buffer.from(c));
        const moving = req.method === 'PUT' && /\/buckets\/\d+\/tasks$/.test(req.url!);
        if (moving) { attempted++; if (fault) { res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '1' }); res.end(JSON.stringify({ message: 'QA fault' })); return; } }
        const upstream = await fetch(`${h!.config.vikunja.baseUrl}${req.url}`, { method: req.method!, headers: { authorization: `Bearer ${h!.config.vikunja.apiToken}`, 'content-type': 'application/json' }, ...(req.method === 'GET' ? {} : { body: Buffer.concat(body) }) });
        if (moving && upstream.ok) accepted++;
        res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { res.writeHead(502); res.end(); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const adapter = new VikunjaAdapter({ ...h.config.vikunja, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` }, h.db);
    const service = new ProposalWorkflow(h.proposals, h.mutations, adapter, new TicketProjector(h.db, adapter, h.records, h.clock));
    try {
      const unknown = (await service.applyNext())!; expect(unknown.state).toBe('remote_unknown'); expect(attempted).toBe(1); expect(accepted).toBe(0);
      expect((await h.local()).stageVersion).toBe(0); expect((await h.remote())?.bucketId).toBe(h.board.buckets['To be started']);
      // Real API client status reflects failed transport, not successful application.
      expect(await adapter.status()).toMatchObject({ state: 'unavailable', code: 'upstream_unavailable' });
      fault = false; expect((await service.reconcile(unknown.id)).state).toBe('committed'); await service.reconcile(unknown.id);
      expect(attempted).toBe(2); expect(accepted).toBe(1); expect(await h.local()).toMatchObject({ lane: 'Integrations', stageVersion: 1 }); expect((await h.remote())?.bucketId).toBe(h.board.buckets.Integrations);
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
  });
  it('a delayed remote write holds no SQL transaction and does not block a different ticket apply', async () => {
    h = await fixture(); const second = await fixture(); const p = await h.propose(), q = await second.propose('Completed'); await h.approve(p.id); await second.approve(q.id);
    const entered = deferred(), release = deferred(); let pid = 0;
    const original = h.adapter.moveTask.bind(h.adapter);
    h.adapter.moveTask = async (i) => { pid = Number((await h!.db.query('SELECT pg_backend_pid() pid')).rows[0]!.pid); entered.resolve(); await release.promise; return original(i); };
    const delayed = h.service.applyNext();
    try {
      await entered.promise;
      expect((await h.peer().query('SELECT xact_start IS NULL AS outside_transaction,state FROM pg_stat_activity WHERE pid=$1', [pid])).rows).toEqual([{ outside_transaction: true, state: 'idle' }]);
      expect((await second.service.applyNext())?.state).toBe('committed'); expect((await second.local()).stageVersion).toBe(1);
      expect((await second.remote())?.bucketId).toBe(second.board.buckets.Completed);
    } finally { release.resolve(); await delayed; await second.close(); }
    expect((await h.local()).stageVersion).toBe(1); expect((await h.remote())?.bucketId).toBe(h.board.buckets.Integrations);
  });
});
