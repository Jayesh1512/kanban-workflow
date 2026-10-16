import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { deferred, fixture, project, type Fixture } from './qa-m32-support.js';

const phases = ['before-proposal-commit', 'after-proposal-commit', 'after-decision-commit', 'after-journal-commit', 'accepted-response-withheld', 'after-confirm-before-local', 'after-local-before-ack'] as const;
describe.skipIf(!project)('QA M3.2 A05 seven SIGKILL windows, actual PG and pinned Vikunja', () => {
  let h: Fixture | undefined, child: ChildProcessWithoutNullStreams | undefined;
  afterEach(async () => { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } child = undefined; await h?.close(); h = undefined; });
  it.each(phases)('%s persists conservative intent and recovers exactly one logical stage', async (phase) => {
    h = await fixture();
    const reached = deferred<{ phase: string }>(), release = deferred(); let remoteMoves = 0;
    // Forward actual HTTP to the QA-owned Vikunja. Only the successful bucket PUT
    // response is withheld; raw remote readback proves acceptance before SIGKILL.
    const proxy = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
        const method = req.method!, moving = method === 'PUT' && /\/buckets\/\d+\/tasks$/.test(req.url!);
        const upstream = await fetch(`${h!.config.vikunja.baseUrl}${req.url}`, { method, headers: { authorization: `Bearer ${h!.config.vikunja.apiToken}`, 'content-type': 'application/json' }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }) });
        const body = Buffer.from(await upstream.arrayBuffer());
        if (moving && upstream.ok) { remoteMoves++; reached.resolve({ phase: 'accepted-response-withheld' }); await release.promise; }
        if (!res.destroyed) { res.writeHead(upstream.status, { 'content-type': 'application/json' }); res.end(body); }
      } catch { if (!res.destroyed) { res.writeHead(502); res.end(); } }
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const port = (proxy.address() as { port: number }).port;
    const childStage = deferred<{ phase: string }>();
    child = spawn(process.execPath, ['tests/qa-m32-worker.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); const lines = output.split('\n'); output = lines.pop()!; for (const line of lines) if (line) childStage.resolve(JSON.parse(line)); });
    // stderr is drained, never echoed (even private test connection diagnostics).
    child.stderr.resume(); child.stdin.end(JSON.stringify({ phase, databaseUrl: h.db.pool.options.connectionString, now: h.clock.now().toISOString(), ticketId: h.ticket.id, evidenceId: h.evidenceId, vikunja: { ...h.config.vikunja, ...(phase === 'accepted-response-withheld' ? { baseUrl: `http://127.0.0.1:${port}` } : {}) } }));
    try {
      const stage = await Promise.race([phase === 'accepted-response-withheld' ? reached.promise : childStage.promise, new Promise<never>((_r, reject) => { const t = setTimeout(() => reject(new Error('QA crash phase timed out')), 12000); t.unref(); })]);
      expect(stage.phase).toBe(phase);
      const before = (await h.db.query('SELECT * FROM mutations')).rows;
      const accepted = ['accepted-response-withheld', 'after-confirm-before-local', 'after-local-before-ack'].includes(phase);
      expect((await h.remote())?.bucketId).toBe(h.board.buckets[accepted ? 'Completed' : 'To be started']);
      if (phase === 'before-proposal-commit') { expect((await h.db.query('SELECT * FROM proposals')).rows).toHaveLength(0); expect((await h.db.query('SELECT * FROM control_outbox')).rows).toHaveLength(0); }
      if (phase === 'after-journal-commit' || phase === 'accepted-response-withheld') expect(before[0]?.state).toBe('prepared');
      if (phase === 'after-confirm-before-local') expect(before[0]?.state).toBe('remote_confirmed');
      if (phase === 'after-local-before-ack') expect(before[0]?.state).toBe('committed');
      const exited = once(child, 'exit'); child.kill('SIGKILL'); expect((await exited)[1]).toBe('SIGKILL'); release.resolve();
      // Independent connection/process ownership after a real abrupt process exit.
      let parentMoves = 0; const move = h.adapter.moveTask.bind(h.adapter);
      h.adapter.moveTask = async (i) => { parentMoves++; return move(i); };
      let proposals = (await h.service.list({})).items;
      if (phase === 'before-proposal-commit') { expect(await h.service.applyNext()).toBeNull(); proposals = [await h.propose('Completed')]; }
      if (['before-proposal-commit', 'after-proposal-commit'].includes(phase)) { expect(await h.service.applyNext()).toBeNull(); await h.approve(proposals[0]!.id); }
      const result = before[0] ? await h.service.reconcile(String(before[0].id)) : await h.service.applyNext();
      expect(result?.state).toBe('committed');
      await h.service.reconcile(result!.id); expect(await h.service.applyNext()).toBeNull();
      expect(await h.local()).toMatchObject({ lane: 'Completed', stageVersion: 1 }); expect((await h.remote())?.bucketId).toBe(h.board.buckets.Completed);
      expect((await h.db.query('SELECT state FROM mutations')).rows).toEqual([{ state: 'committed' }]);
      expect(parentMoves).toBe(accepted ? 0 : 1); if (phase === 'accepted-response-withheld') expect(remoteMoves).toBe(1);
    } finally { release.resolve(); proxy.closeAllConnections(); await new Promise<void>((r) => proxy.close(() => r())); }
  }, 25000);
});
