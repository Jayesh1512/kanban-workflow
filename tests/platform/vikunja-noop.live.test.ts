import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { VikunjaAdapter } from '../../src/vikunja/adapter.js';

const url = process.env['VIKUNJA_NOOP_DATABASE_URL'];
describe.skipIf(!url)('actual isolated Vikunja 2.7.0 no-op Merge Patch/readback', () => {
  it('observes native 304 twice, synchronizes labels and preserves serialized task lanes', async () => {
    const admin = new PgDatabase(url!), schema = `vikunja_noop_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`); const uri = new URL(url!); uri.searchParams.set('options', `-c search_path=${schema},public`); const db = new PgDatabase(uri.toString());
    const baseUrl = process.env['VIKUNJA_NOOP_URL']!, password = process.env['VIKUNJA_NOOP_PASSWORD']!, username = process.env['VIKUNJA_NOOP_USERNAME']!;
    const adapter = new VikunjaAdapter({ baseUrl, password, username, apiToken: null, projectTitle: `Isolated noop ${schema}` }, db);
    const observed304: string[] = [], fetcher = globalThis.fetch.bind(globalThis);
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => { const response = await fetcher(input, init); if (response.status === 304) observed304.push(`${init?.method} ${new URL(String(input)).pathname}`); return response; });
    try {
      await migrate(db); const board = await adapter.ensureBoard();
      const companyId = (await db.query("INSERT INTO companies(canonical_name) VALUES('Synthetic noop fixture') RETURNING id")).rows[0]!['id'];
      await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES(-1009,'supergroup','Synthetic noop fixture','included','confirmed',$1)", [companyId]);
      const ticketId = String((await db.query('INSERT INTO tickets(chat_id,company_id) VALUES(-1009,$1) RETURNING id', [companyId])).rows[0]!['id']);
      const task = await adapter.ensureTask({ ticketId, title: 'Unchanged details', description: 'No-op details', workstream: 'Buyer' });
      await adapter.moveTask({ taskId: task.id, projectId: board.projectId, viewId: board.viewId, targetBucketId: board.buckets.Completed });
      const input = { taskId: task.id, title: task.title, description: task.description, workstream: 'Integration' as const };
      expect((await adapter.updateTaskDetails(input)).bucketId).toBe(board.buckets.Completed); expect((await adapter.updateTaskDetails(input)).bucketId).toBe(board.buckets.Completed);
      expect(observed304.filter((entry) => entry === `PATCH /api/v2/tasks/${task.id}`).length).toBeGreaterThanOrEqual(2);
      const auth = await fetcher(`${baseUrl}/api/v2/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) }).then((r) => r.json()) as { token: string };
      const raw = await fetcher(`${baseUrl}/api/v2/tasks/${task.id}`, { headers: { authorization: `Bearer ${auth.token}` } }).then((r) => r.json()) as { done: boolean; labels: Array<{ title: string }> };
      expect(raw.done).toBe(true); expect(raw.labels.map((label) => label.title)).toEqual(['Integration']);
      await Promise.all([adapter.updateTaskDetails(input), adapter.moveTask({ taskId: task.id, projectId: board.projectId, viewId: board.viewId, targetBucketId: board.buckets.Archived })]);
      expect((await adapter.getTask(task.id))?.bucketId).toBe(board.buckets.Archived);
    } finally { spy.mockRestore(); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });
});
