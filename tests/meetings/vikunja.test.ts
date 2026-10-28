import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/shared/ports.js';
import { VikunjaMeetingTaskAdapter } from '../../src/meetings/vikunja.js';
import type { MeetingTaskSnapshot } from '../../src/meetings/domain.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function server(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const http = createServer(handler); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error();
  return `http://127.0.0.1:${address.port}`;
}
const db = { query: async () => ({ rows: [{ project_id: '7' }] }) } as unknown as Database;
const snapshot: MeetingTaskSnapshot = { actionId: '13a501dd-1965-41db-9208-f0102eb625e7', actionVersion: 1, meetingId: 'bf5d9ec8-5ad8-4917-865f-ee2dc0c15c90', meetingTitle: 'Review', title: 'Follow up', description: 'Send document', customerNames: ['Acme'], sourceUrl: 'https://fathom.video/test', playbackUrl: 'https://fathom.video/test?t=3', timestamp: '00:00:03', assignee: { name: 'Taylor', email: 'taylor@example.test', team: 'Sales' }, dueAt: null };
const marker = `[meeting-action:${snapshot.actionId}]`;
const send = (res: ServerResponse, body: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const config = (baseUrl: string) => ({ baseUrl, apiToken: 'secret-token', username: 'user', password: null, projectTitle: 'Existing', timeoutMs: 200 });
describe('independent Vikunja meeting task adapter over HTTP', () => {
  it('uses existing credentials/project, preserves evidence and owner labels, and never assigns a guessed user or deadline', async () => {
    const requests: { method: string; url: string; body: Record<string, unknown> }[] = [];
    const base = await server(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      requests.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : {} });
      expect(req.headers.authorization).toBe('Bearer secret-token');
      send(res, req.method === 'POST' ? { id: 42, project_id: 7 } : { id: 7 });
    });
    const adapter = new VikunjaMeetingTaskAdapter(db, config(base));
    await adapter.prepare(); const task = await adapter.create(snapshot, marker);
    expect(task).toEqual({ id: '42', url: `${base}/tasks/42` });
    expect(requests.map(r => [r.method, r.url])).toEqual([['GET', '/api/v2/projects/7'], ['POST', '/api/v2/projects/7/tasks']]);
    expect(requests[1]!.body).toEqual({ title: 'Follow up', description: expect.stringContaining(marker), due_date: null });
    const description = requests[1]!.body.description as string;
    for (const text of ['Acme', 'Review', 'Taylor', 'taylor@example.test', '00:00:03', snapshot.sourceUrl!, snapshot.playbackUrl!]) expect(description).toContain(text);
    expect(requests[1]!.body).not.toHaveProperty('assignees');
  });
  it('logs in once before dispatch and does not replay task POSTs after 401 or 5xx', async () => {
    const requests: string[] = [];
    const base = await server((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === '/api/v2/login') send(res, { token: 'login-token' });
      else if (req.method === 'POST') send(res, { secret: 'never reflect this' }, 401);
      else send(res, { id: 7 });
    });
    const adapter = new VikunjaMeetingTaskAdapter(db, { ...config(base), apiToken: null, password: 'secret-password' }, { projectId: '7' });
    await adapter.prepare(); await expect(adapter.create(snapshot, marker)).rejects.toThrow('HTTP 401');
    expect(requests).toEqual(['POST /api/v2/login', 'GET /api/v2/projects/7', 'POST /api/v2/projects/7/tasks']);
  });
  it('scans every page and matches complete markers, preserving duplicate matches for conflict handling', async () => {
    const pages: string[] = [];
    const base = await server((req, res) => {
      if (!req.url!.includes('/tasks?')) return send(res, { id: 7 });
      pages.push(req.url!);
      const page = new URL(req.url!, 'http://localhost').searchParams.get('page');
      send(res, { total_pages: 2, items: page === '1' ? [{ id: 1, project_id: 7, description: `${marker}wrong` }, { id: 2, project_id: 7, description: `prefix ${marker}` }] : [{ id: 3, project_id: 7, description: `Context\n\n${marker}\n` }, { id: 4, project_id: 7, description: marker }] });
    });
    const adapter = new VikunjaMeetingTaskAdapter(db, config(base)); await adapter.prepare();
    expect((await adapter.find(marker)).map(t => t.id)).toEqual(['3', '4']); expect(pages).toHaveLength(2);
  });
  it('rejects repeated/invalid pagination instead of claiming a complete zero match', async () => {
    const base = await server((req, res) => send(res, req.url!.includes('/tasks?') ? { items: [{ id: 1, project_id: 7, description: 'ordinary' }], total_pages: 2 } : { id: 7 }));
    const adapter = new VikunjaMeetingTaskAdapter(db, config(base)); await adapter.prepare();
    await expect(adapter.find(marker)).rejects.toThrow('incomplete');
  });
  it('bounds timeouts and sanitizes malformed creation responses without retry', async () => {
    let posts = 0;
    const base = await server((req, res) => { if (req.method === 'POST') { posts++; res.end('secret-token not JSON'); } else send(res, { id: 7 }); });
    const adapter = new VikunjaMeetingTaskAdapter(db, config(base)); await adapter.prepare();
    await expect(adapter.create(snapshot, marker)).rejects.toThrow('invalid response'); expect(posts).toBe(1);
    const hung = await server((_req, _res) => {});
    await expect(new VikunjaMeetingTaskAdapter(db, { ...config(hung), timeoutMs: 20 }).prepare()).rejects.toThrow('timed out');
  });
  it('never bootstraps a missing project', async () => {
    const adapter = new VikunjaMeetingTaskAdapter({ query: async () => ({ rows: [] }) } as unknown as Database, config('http://127.0.0.1:1'));
    await expect(adapter.prepare()).rejects.toThrow('existing Vikunja project');
  });
});
