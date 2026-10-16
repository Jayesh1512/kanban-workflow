import { afterEach, describe, expect, it, vi } from 'vitest';
import { LANES, WORKSTREAMS } from '../../src/shared/domain.js';
import type { PgDatabase } from '../../src/platform/database.js';
import { VikunjaAdapter } from '../../src/vikunja/adapter.js';
import type { RemoteTask, SqlExecutor } from '../../src/shared/ports.js';

afterEach(() => { vi.unstubAllGlobals(); });
describe('Vikunja native 304 response contract (controlled HTTP seam)', () => {
  it('accepts unchanged PATCH and reads back Completed lane without sending done/bucket fields', async () => {
    const query: SqlExecutor['query'] = async (sql) => ({ rows: sql.includes('board_bindings') ? [{ project_id: '1', view_id: '2' }] : sql.includes('board_labels') ? WORKSTREAMS.map((workstream) => ({ workstream, label_id: workstream === 'Buyer' ? '3' : String(10 + WORKSTREAMS.indexOf(workstream)) })) : sql.includes('board_buckets') ? LANES.map((lane, i) => ({ lane, bucket_id: lane === 'Completed' ? '4' : String(i + 10) })) : [{ id: '00000000-0000-4000-8000-000000000001' }], rowCount: 1 } as never);
    const db = { query, withSessionLock: async <T>(_key: string, work: (sql: SqlExecutor, signal: AbortSignal) => Promise<T>) => work({ query }, new AbortController().signal) } as unknown as PgDatabase;
    const adapter = new VikunjaAdapter({ apiToken: 'synthetic-token', password: null, username: 'fixture', projectTitle: 'Fixture', baseUrl: 'http://synthetic.invalid' }, db);
    const task: RemoteTask = { id: '9', projectId: '1', bucketId: '4', title: 'Same title', description: 'Same details', updatedAt: '2026-10-17T00:00:00.000Z' };
    const readback = vi.spyOn(adapter, 'getTask').mockResolvedValue(task);
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      if (options?.method === 'PATCH') { expect(JSON.parse(String(options.body))).toEqual({ title: 'Same title', description: 'Same details' }); return new Response(null, { status: 304 }); }
      return Response.json({ items: [{ id: 3 }], total_pages: 1 });
    }); vi.stubGlobal('fetch', fetcher);
    expect(await adapter.updateTaskDetails({ taskId: '9', title: 'Same title', description: 'Same details', workstream: 'Buyer' })).toEqual(task);
    expect(await adapter.updateTaskDetails({ taskId: '9', title: 'Same title', description: 'Same details', workstream: 'Buyer' })).toEqual(task);
    expect(readback).toHaveBeenCalledTimes(4); expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(2);
    readback.mockResolvedValueOnce(task).mockResolvedValueOnce({ ...task, title: 'Concurrent wrong title' });
    await expect(adapter.updateTaskDetails({ taskId: '9', title: 'Same title', description: 'Same details', workstream: 'Buyer' })).rejects.toMatchObject({ code: 'conflict' });
    fetcher.mockImplementation(async () => new Response(null, { status: 304 }));
    await expect(adapter.updateTaskDetails({ taskId: '9', title: 'Same title', description: 'Same details', workstream: 'Buyer' })).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});
