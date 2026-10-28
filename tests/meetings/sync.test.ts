import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PgDatabase } from '../../src/platform/database.js';
import type { Database } from '../../src/shared/ports.js';
import type { MeetingConfig } from '../../src/meetings/domain.js';
import { FathomClient } from '../../src/meetings/fathom.js';
import { MeetingSync } from '../../src/meetings/sync.js';
import { fathomHttp, ingestionArchive, ingestionDatabase } from './ingestion-test-helper.js';

const config: MeetingConfig = { enabled: true, apiKey: 'synthetic-key', webhookSecret: null, pollIntervalMs: 60_000, timeoutMs: 1000, internalDomains: [], projectId: null };
const now = new Date('2026-10-26T10:00:00Z');
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function database(): Promise<Database> { const db = await ingestionDatabase(); cleanup.push(() => db.close()); return db; }
describe('durable Fathom synchronization', () => {
  it('persists one page per tick and resumes the fixed creation window after restart', async () => {
    const db = await database(); const requests: URL[] = [];
    const http = await fathomHttp((request, response) => { const url = new URL(request.url!, 'http://localhost'); requests.push(url); response.end(JSON.stringify({ items: [{ recording_id: requests.length, title: 'Same-time meeting', created_at: now.toISOString(), transcript: [] }], next_cursor: requests.length === 1 ? 'second-page' : null })); }); cleanup.unshift(http.close);
    const options = { client: new FathomClient({ apiKey: config.apiKey!, baseUrl: http.baseUrl }) };
    const archive = ingestionArchive(db); const sync = new MeetingSync(db, archive, config, { now: () => now }, options);
    const request = { idempotencyKey: 'historical', createdAfter: '2026-10-01T00:00:00Z', createdBefore: '2026-10-20T00:00:00Z' };
    const run = await sync.requestImport(request); expect(await sync.requestImport(request)).toEqual(run);
    await expect(sync.requestImport({ ...request, createdAfter: '2026-10-02T00:00:00Z' })).rejects.toMatchObject({ code: 'conflict' });
    await sync.tick(); expect(requests).toHaveLength(1);
    const partial = (await db.query('SELECT * FROM meeting_import_runs')).rows[0]!; expect(partial.cursor).toBe('second-page'); expect(partial.pages).toBe(1);
    await new MeetingSync(db, archive, config, { now: () => new Date(now.getTime() + 5000) }, options).tick();
    expect(requests[1]!.searchParams.get('cursor')).toBe('second-page'); expect(requests[1]!.searchParams.get('created_before')).toBe('2026-10-20T00:00:00.000Z');
    expect((await db.query('SELECT count(*)::int AS count FROM test_ingestion')).rows[0]!.count).toBe(2);
    const status = await sync.status() as { lastImport: { status: string; pages: number }; configured: boolean };
    expect(status.lastImport).toMatchObject({ status: 'completed', pages: 2 }); expect(JSON.stringify(status)).not.toContain('synthetic-key');
  });
  it('rolls back archive writes and cursor together and fences expired page responses', async () => {
    const db = await database(); let fail = true; let requests = 0;
    const http = await fathomHttp((_request, response) => { requests++; response.end(JSON.stringify({ items: [{ recording_id: 1, title: 'Meeting', created_at: now.toISOString() }], next_cursor: 'next' })); }); cleanup.unshift(http.close);
    const archive = ingestionArchive(db); const original = archive.ingestPage;
    archive.ingestPage = async (...args) => { const result = await original(...args); if (fail) throw new Error('crash before cursor commit'); return result; };
    let time = now;
    const sync = new MeetingSync(db, archive, config, { now: () => time }, { client: new FathomClient({ apiKey: 'key', baseUrl: http.baseUrl }) });
    await sync.requestImport({ idempotencyKey: 'rollback' }); await sync.tick();
    expect((await db.query('SELECT count(*)::int AS count FROM test_ingestion')).rows[0]!.count).toBe(0);
    expect((await db.query('SELECT cursor,status FROM meeting_import_runs')).rows[0]).toEqual({ cursor: null, status: 'retry' });
    fail = false; time = new Date(now.getTime() + 10_000); await sync.tick(); expect(requests).toBe(2);
    expect((await db.query('SELECT cursor,pages FROM meeting_import_runs')).rows[0]).toEqual({ cursor: 'next', pages: 1 });
    // Simulate lease takeover while an HTTP response is being processed.
    archive.ingestPage = async (...args) => original(...args);
    const client = new FathomClient({ apiKey: 'key', baseUrl: http.baseUrl });
    const list = client.listMeetings.bind(client);
    client.listMeetings = async (...args) => { const page = await list(...args); await db.query("UPDATE meeting_import_runs SET lease_token=gen_random_uuid(),status='queued',cursor='new-owner' WHERE status='running'"); return { ...page, next_cursor: null }; };
    await new MeetingSync(db, archive, config, { now: () => time }, { client }).tick();
    expect((await db.query('SELECT cursor,pages FROM meeting_import_runs')).rows[0]).toEqual({ cursor: 'new-owner', pages: 1 });
  });
  it('honors connection-wide rate backoff and pauses authentication until explicit retry', async () => {
    const db = await database(); let status = 429; let requests = 0; let time = now;
    const http = await fathomHttp((_request, response) => { requests++; response.writeHead(status, { 'retry-after': '20' }); response.end(status === 200 ? JSON.stringify({ items: [], next_cursor: null }) : 'error'); }); cleanup.unshift(http.close);
    const sync = new MeetingSync(db, ingestionArchive(db), config, { now: () => time }, { client: new FathomClient({ apiKey: 'key', baseUrl: http.baseUrl }) });
    await sync.requestImport({ idempotencyKey: 'retry' }); await sync.tick(); await sync.tick(); expect(requests).toBe(1);
    time = new Date(now.getTime() + 21_000); status = 401; await sync.tick(); expect(requests).toBe(2);
    time = new Date(now.getTime() + 200_000); await sync.tick(); expect(requests).toBe(2);
    expect(await sync.status()).toMatchObject({ state: 'authentication_required' });
    status = 200; await sync.requestImport({ idempotencyKey: 'retry' }); await sync.tick(); expect(requests).toBe(3);
    expect(await sync.status()).toMatchObject({ state: 'ready', lastImport: { status: 'completed' } });
  });
  it('only refreshes canonical REST after a durable webhook and starts bounded polling when enabled', async () => {
    const db = await database(); const urls: URL[] = [];
    const http = await fathomHttp((request, response) => { urls.push(new URL(request.url!, 'http://localhost')); response.end(JSON.stringify({ items: [], next_cursor: null })); }); cleanup.unshift(http.close);
    const client = new FathomClient({ apiKey: 'key', baseUrl: http.baseUrl }); const archive = ingestionArchive(db);
    for (const disabled of [{ ...config, enabled: false }, { ...config, apiKey: null }]) await new MeetingSync(db, archive, disabled, { now: () => now }, { client }).tick();
    expect(urls).toHaveLength(0);
    await db.query(`INSERT INTO meeting_webhook_inbox(id,webhook_id,webhook_timestamp,body_sha256,raw_body,payload) VALUES(gen_random_uuid(),'signal',1,'hash',$1,$2)`, [Buffer.from('{}'), JSON.stringify({ recording_id: 999, created_after: '1900-01-01', action_items: [{ description: 'Must not import' }] })]);
    const sync = new MeetingSync(db, archive, config, { now: () => now }, { client }); await sync.tick();
    expect(urls).toHaveLength(1); expect(urls[0]!.searchParams.get('created_after')).toBe('2026-09-26T10:00:00.000Z');
    expect((await db.query('SELECT processed_at FROM meeting_webhook_inbox')).rows[0]!.processed_at).not.toBeNull();
    expect((await db.query('SELECT count(*)::int AS count FROM test_ingestion')).rows[0]!.count).toBe(0);
    await sync.tick(); expect(urls).toHaveLength(1);
    const polling = new MeetingSync(db, archive, config, { now: () => new Date(now.getTime() + 61_000) }, { client }); await polling.tick();
    expect(urls).toHaveLength(2);
    await expect(sync.requestImport({ idempotencyKey: 'unbounded', createdAfter: '2000-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'validation' });
  });
});

const postgresUrl = process.env['MEETINGS_TEST_DATABASE_URL'];
describe.skipIf(!postgresUrl)('real PostgreSQL Fathom worker concurrency', () => {
  it('permits one connection fetch, takes over expired leases and rejects a late stale canonical page', async () => {
    const schema = `meeting_ingestion_${randomUUID().replaceAll('-', '')}`;
    const admin = new PgDatabase(postgresUrl!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(postgresUrl!); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    const db = new PgDatabase(scoped.toString()); const other = new PgDatabase(scoped.toString());
    let releaseFirst: (() => void) | undefined;
    try {
      await db.query(await readFile(new URL('../../db/migrations/202610260004_meeting_ingestion.sql', import.meta.url), 'utf8'));
      await db.query('CREATE TABLE test_ingestion(recording_id bigint PRIMARY KEY,payload jsonb NOT NULL)');
      let requests = 0; let sawFirst!: () => void; const firstSeen = new Promise<void>(resolve => { sawFirst = resolve; });
      const http = await fathomHttp((_request, response) => {
        requests++;
        const body = (title: string) => JSON.stringify({ items: [{ recording_id: 7, title, created_at: now.toISOString() }], next_cursor: null });
        if (requests === 1) { releaseFirst = () => response.end(body('stale')); sawFirst(); }
        else response.end(body('new owner'));
      });
      try {
        const options = { client: new FathomClient({ apiKey: 'test-key', baseUrl: http.baseUrl }) };
        const a = new MeetingSync(db, ingestionArchive(db), config, { now: () => now }, options);
        const b = new MeetingSync(other, ingestionArchive(other), config, { now: () => now }, options);
        await Promise.all([a.requestImport({ idempotencyKey: 'concurrent' }), b.requestImport({ idempotencyKey: 'concurrent' })]);
        expect((await db.query('SELECT count(*)::int AS count FROM meeting_import_runs')).rows[0]!.count).toBe(1);
        const pending = a.tick(); await firstSeen;
        await b.tick(); expect(requests).toBe(1);
        await other.query("UPDATE meeting_import_runs SET lease_until=$1 WHERE status='running'", [new Date(now.getTime() - 1000)]);
        await b.tick(); expect(requests).toBe(2);
        releaseFirst!(); await pending;
        expect((await db.query('SELECT payload FROM test_ingestion')).rows[0]!.payload.title).toBe('new owner');
        expect((await db.query('SELECT status,pages,attempts FROM meeting_import_runs')).rows[0]).toEqual({ status: 'completed', pages: 1, attempts: 2 });
      } finally { releaseFirst?.(); await http.close(); }
    } finally { await db.close(); await other.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });
});
