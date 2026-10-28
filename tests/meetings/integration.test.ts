import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import pg from 'pg';
import { expect, it } from 'vitest';
import { PgDatabase } from '../../src/platform/database.js';
import { registerTransports } from '../../src/hermes/module.js';
import { createBindings } from '../../src/hermes/bindings.js';
import type { DomainServices } from '../../src/shared/ports.js';
import type { FathomMeeting, MeetingConfig, MeetingEnvelope, MeetingListEnvelope, TranscriptEnvelope, CustomerListEnvelope } from '../../src/meetings/domain.js';
import { FathomClient } from '../../src/meetings/fathom.js';
import { MeetingRepository } from '../../src/meetings/repository.js';
import { MeetingSync } from '../../src/meetings/sync.js';
import { MeetingTaskPublisher } from '../../src/meetings/tasks.js';
import { VikunjaMeetingTaskAdapter } from '../../src/meetings/vikunja.js';
import { connectClient } from '../hermes/client.js';

const databaseUrl = process.env.MEETINGS_TEST_DATABASE_URL;
const source = JSON.parse(await readFile(new URL('./fixtures/fathom-meeting.json', import.meta.url), 'utf8')) as FathomMeeting;

it.skipIf(!databaseUrl)('imports canonical Fathom pages into the real archive, automatically publishes to Vikunja and serves identical HTTP/MCP history', async () => {
  const schema = `meeting_integration_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scopedUrl = new URL(databaseUrl!); scopedUrl.searchParams.set('schema', schema);
  const db = new PgDatabase(scopedUrl.toString());
  const fathom = Fastify(), vikunja = Fastify(), app = Fastify();
  let transport: ReturnType<typeof registerTransports> | undefined;
  let client: Awaited<ReturnType<typeof connectClient>> | undefined;
  try {
    for (const file of ['001_initial.sql', '202610260003_meetings.sql', '202610260004_meeting_ingestion.sql', '202610260005_meeting_tasks.sql']) {
      await db.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'));
    }
    const companyId = randomUUID();
    await db.query("INSERT INTO companies(id,canonical_name,domains) VALUES($1,'Acme',ARRAY['acme.example'])", [companyId]);
    const first = structuredClone(source);
    const second: FathomMeeting = { ...structuredClone(source), recording_id: 90002, title: 'Acme follow-up', meeting_title: 'Acme follow-up', action_items: [] };
    const unresolved: FathomMeeting = { ...structuredClone(source), recording_id: 90003, title: 'Unresolved history', meeting_title: 'Unresolved history', calendar_invitees: [{ email: 'private@gmail.com', is_external: true }], action_items: [] };
    let removeActions = false;
    const fathomRequests: URLSearchParams[] = [];
    fathom.get('/external/v1/meetings', async request => {
      expect(request.headers['x-api-key']).toBe('synthetic-fathom-key');
      const query = new URL(request.url, 'http://localhost').searchParams;
      fathomRequests.push(query);
      for (const flag of ['include_transcript', 'include_summary', 'include_action_items', 'include_crm_matches']) expect(query.get(flag)).toBe('true');
      expect(query.get('created_after')).toBe('2026-10-01T00:00:00.000Z');
      expect(query.get('created_before')).toBe('2026-10-27T00:00:00.000Z');
      if (!query.has('cursor')) return { items: [{ ...first, ...(removeActions ? { action_items: [] } : {}) }], next_cursor: 'canonical-page-2' };
      expect(query.get('cursor')).toBe('canonical-page-2');
      return { items: [second, unresolved], next_cursor: null };
    });
    const remoteTasks: Array<{ id: number; project_id: number; title: string; description: string; due_date: null }> = [];
    const remoteMethods: string[] = [];
    vikunja.addHook('onRequest', async request => {
      expect(request.headers.authorization).toBe('Bearer synthetic-vikunja-token'); remoteMethods.push(`${request.method} ${request.url}`);
    });
    vikunja.get('/api/v2/projects/7', async () => ({ id: 7, title: 'Existing customer work' }));
    vikunja.get('/api/v2/projects/7/tasks', async () => ({ items: remoteTasks, total_pages: 1 }));
    vikunja.post('/api/v2/projects/7/tasks', async request => {
      const body = request.body as { title: string; description: string; due_date: null };
      expect(Object.keys(body).sort()).toEqual(['description', 'due_date', 'title']);
      expect(body.due_date).toBeNull();
      const task = { ...body, id: remoteTasks.length + 100, project_id: 7 }; remoteTasks.push(task); return task;
    });
    const fathomUrl = await fathom.listen({ host: '127.0.0.1', port: 0 });
    const vikunjaUrl = await vikunja.listen({ host: '127.0.0.1', port: 0 });
    const clock = { now: () => new Date('2026-10-27T12:00:00Z') };
    const config: MeetingConfig = { enabled: true, apiKey: 'synthetic-fathom-key', webhookSecret: null, pollIntervalMs: 300_000, timeoutMs: 5000, internalDomains: ['example.org'], projectId: '7' };
    const archive = new MeetingRepository(db, clock, { internalDomains: config.internalDomains });
    const sync = new MeetingSync(db, archive, config, clock, { client: new FathomClient({ apiKey: config.apiKey!, baseUrl: `${fathomUrl}/external/v1/`, clock }) });
    const publisher = new MeetingTaskPublisher(db, new VikunjaMeetingTaskAdapter(db, { baseUrl: vikunjaUrl, apiToken: 'synthetic-vikunja-token', username: 'unused', password: null, projectTitle: 'Existing customer work' }, { projectId: '7' }), clock);
    async function canonicalImport(key: string) {
      const run = await sync.requestImport({ idempotencyKey: key, createdAfter: '2026-10-01T00:00:00Z', createdBefore: '2026-10-27T00:00:00Z' }) as { id: string };
      await sync.tick(); await sync.tick();
      const result = (await db.query<{ status: string; pages: number; imported: number; unchanged: number }>('SELECT status,pages,imported,unchanged FROM meeting_import_runs WHERE id=$1', [run.id])).rows[0]!;
      expect(result.status).toBe('completed'); expect(result.pages).toBe(2); return result;
    }
    expect(await canonicalImport('first')).toMatchObject({ imported: 3, unchanged: 0 });
    expect((await db.query("SELECT state FROM meeting_task_exports WHERE state='queued'")).rowCount).toBe(2);
    // The publisher consumes the automatically inserted outbox; there is no review/approval call.
    await publisher.tick();
    expect(remoteTasks).toHaveLength(1);
    expect(remoteTasks[0]!.description).toContain('Customers: Acme');
    expect(remoteTasks[0]!.description).toContain(`Recording: ${source.share_url}`);
    expect(remoteTasks[0]!.description).toContain('Playback: https://fathom.video/');
    expect(remoteTasks[0]!.description).toMatch(/\[meeting-action:[0-9a-f-]+\]/);
    expect(remoteMethods.filter(v => v.startsWith('POST'))).toEqual(['POST /api/v2/projects/7/tasks']);

    // Only meetings is exercised; other domain services cannot be called by this test graph.
    function unavailable<T extends object>(): T {
      return new Proxy({} as T, { get: (_target, key) => () => { throw new Error(`Unexpected unrelated service call: ${String(key)}`); } });
    }
    const services: DomainServices = { meetings: archive, chats: unavailable(), records: unavailable(), proposals: unavailable(), analysis: unavailable(), outreach: unavailable() };
    expect(createBindings(services, 'mcp')['meetings.list'].readOnly).toBe(true);
    transport = registerTransports(app, services, async () => {});
    const appUrl = await app.listen({ host: '127.0.0.1', port: 0 }); client = await connectClient(appUrl);
    async function tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const value = await client!.callTool({ name, arguments: args }); expect(value.isError, JSON.stringify(value)).not.toBe(true);
      const text = value.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(text[0]!.text) as T; expect(value.structuredContent).toEqual(parsed); return parsed;
    }
    async function http<T>(path: string): Promise<T> {
      const response = await fetch(`${appUrl}${path}`); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); return response.json() as Promise<T>;
    }
    const seen: string[] = []; let cursor: string | null = null;
    do {
      const args: { limit: number; cursor?: string } = { limit: 1, ...(cursor ? { cursor } : {}) };
      const query = new URLSearchParams(Object.entries(args).map(([k, v]) => [k, String(v)]));
      const page = await http<MeetingListEnvelope>(`/api/meetings?${query}`);
      expect(await tool('list_meetings', args)).toEqual(page); expect(page.total).toBe(3);
      seen.push(...page.items.map(m => m.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(3);
    const directory = await http<CustomerListEnvelope>('/api/meetings/customers');
    expect(await tool('list_meeting_customers')).toEqual(directory);
    expect(directory.items.find(c => c.id === companyId)?.meetingCount).toBe(2); expect(directory.unresolvedCount).toBe(1);
    const grouped = await http<MeetingListEnvelope>(`/api/meetings?customerId=${companyId}`);
    expect(await tool('list_meetings', { customerId: companyId })).toEqual(grouped); expect(grouped.items).toHaveLength(2);
    const original = grouped.items.find(m => m.source.recordingId === String(source.recording_id))!;
    const detail = await http<MeetingEnvelope>(`/api/meetings/${original.id}`);
    expect(await tool('get_meeting', { id: original.id })).toEqual(detail);
    expect(detail.meeting.source).toMatchObject({ provider: 'fathom', origin: 'api', url: source.share_url });
    expect(detail.meeting.actions.map(a => a.exportState).sort()).toEqual(['created', 'queued']);
    const transcript = []; cursor = null;
    do {
      const args = { id: original.id, limit: 1, ...(cursor ? { cursor } : {}) };
      const query: URLSearchParams = new URLSearchParams({ limit: '1', ...(cursor ? { cursor } : {}) });
      const page: TranscriptEnvelope = await http<TranscriptEnvelope>(`/api/meetings/${original.id}/transcript?${query}`);
      expect(await tool('get_meeting_transcript', args)).toEqual(page);
      expect(page.revision).toBe(1); transcript.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    expect(transcript).toEqual(source.transcript);
    expect(await canonicalImport('duplicate')).toMatchObject({ imported: 0, unchanged: 3 });
    expect((await db.query('SELECT * FROM meeting_revisions')).rowCount).toBe(3);
    expect((await db.query('SELECT * FROM meeting_task_exports')).rowCount).toBe(2); expect(remoteTasks).toHaveLength(1);
    removeActions = true;
    expect(await canonicalImport('removal')).toMatchObject({ imported: 1, unchanged: 2 });
    expect((await archive.get(original.id)).meeting.actions).toEqual([]);
    expect((await db.query<{ state: string }>('SELECT state FROM meeting_task_exports ORDER BY state')).rows.map(v => v.state)).toEqual(['canceled', 'created']);
    await publisher.tick(); await publisher.tick();
    expect(remoteTasks).toHaveLength(1); expect(remoteMethods.some(v => v.startsWith('DELETE'))).toBe(false);
    expect((await db.query('SELECT * FROM meeting_remote_requests')).rowCount).toBe(1);
    expect((await db.query('SELECT * FROM tickets')).rowCount).toBe(0); expect(fathomRequests).toHaveLength(6);
  } finally {
    await client?.close(); await transport?.close(); await app.close(); await fathom.close(); await vikunja.close();
    await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
}, 30_000);
