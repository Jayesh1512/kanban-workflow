import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgDatabase } from '../../src/platform/database.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MeetingRepository } from '../../src/meetings/repository.js';
import type { FathomMeeting } from '../../src/meetings/domain.js';
import { fixtureDatabase } from '../workflow/database.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const firstCompany = '00000000-0000-4000-8000-000000001001';
const secondCompany = '00000000-0000-4000-8000-000000001002';
const fixture = JSON.parse(await readFile(new URL('./fixtures/fathom-meeting.json', import.meta.url), 'utf8')) as FathomMeeting;
async function setup() {
  const db = await fixtureDatabase([new URL('../../db/migrations/202610260003_meetings.sql', import.meta.url), new URL('../../db/migrations/202610260005_meeting_tasks.sql', import.meta.url)]);
  cleanup.push(() => db.close());
  const repo = new MeetingRepository(db, { now: () => new Date('2026-10-26T12:00:00Z') }, { internalDomains: ['example.org'] });
  await db.query("INSERT INTO companies(id,canonical_name,domains) VALUES($1,'Acme',ARRAY['acme.example']),($2,'Other',ARRAY['other.example'])", [firstCompany, secondCompany]);
  return { db, repo };
}
const source = () => structuredClone(fixture);

it('uses the same unconfirmed customer scope for sidebar counts and list filters', async () => {
  const { repo, db } = await setup();
  await db.query("UPDATE companies SET domains=ARRAY['acme.example'] WHERE id=$1", [secondCompany]);
  await repo.ingestPage([source()]);
  expect((await repo.customers()).unresolvedCount).toBe(1);
  expect((await repo.list({ customerState: 'unresolved' })).total).toBe(1);
  expect((await repo.list({ customerState: 'ambiguous' })).total).toBe(1);
});

describe('meeting archive, immutable source history and automatic task outbox', () => {
  it('deduplicates exact payloads without conflating simultaneous recordings or connection scopes', async () => {
    const { repo, db } = await setup();
    expect(await repo.ingestPage([source()])).toEqual({ imported: 1, unchanged: 0 });
    const before = (await repo.list({})).items[0]!;
    expect(await repo.ingestPage([source()], { observedAt: '2026-10-26T13:00:00Z' })).toEqual({ imported: 0, unchanged: 1 });
    expect((await repo.get(before.id)).meeting).toEqual(before);
    expect(before.customers.map(v => v.id)).toEqual([firstCompany]);
    expect(before.actions.every(v => v.exportState === 'queued')).toBe(true);
    await repo.ingestPage([{ ...source(), recording_id: 90002 }]);
    await repo.ingestPage([source()], { connectionKey: 'different-account' });
    expect((await repo.list({})).total).toBe(3);
    expect((await db.query('SELECT * FROM meeting_revisions')).rowCount).toBe(3);
    expect((await db.query('SELECT * FROM tickets')).rowCount).toBe(0);
    await expect(db.query("UPDATE meeting_revisions SET normalized='{}'")).rejects.toThrow('immutable');
    await expect(db.query("DELETE FROM meeting_transcript_segments")).rejects.toThrow('immutable');
  });
  it('retains omitted/null components, pins transcript pages and preserves complete ordered text', async () => {
    const { repo } = await setup();
    await repo.ingestPage([source()]); const meeting = (await repo.list({})).items[0]!;
    const page = await repo.transcript({ id: meeting.id, limit: 2 });
    const partial = source(); delete partial.action_items; delete partial.transcript; partial.default_summary = null;
    await repo.ingestPage([partial]);
    const current = (await repo.get(meeting.id)).meeting;
    expect(current.sourceRevision).toBe(2); expect(current.transcript.status).toBe('unavailable');
    expect(current.actionsStatus).toBe('unavailable'); expect(current.actions).toHaveLength(2);
    expect(current.summary.markdown).toEqual(meeting.summary.markdown);
    const rest = await repo.transcript({ id: meeting.id, cursor: page.nextCursor!, limit: 2 });
    expect(rest.revision).toBe(1); expect([...page.items, ...rest.items]).toEqual(fixture.transcript);
    expect((await repo.transcript({ id: meeting.id, revision: 2 })).items).toEqual(fixture.transcript);
    await expect(repo.transcript({ id: meeting.id, revision: 2, cursor: page.nextCursor! })).rejects.toThrow('cursor');
  });
  it('retires authoritative removed actions and cancels only undispatched exports', async () => {
    const { repo, db } = await setup(); await repo.ingestPage([source()]);
    const meeting = (await repo.list({})).items[0]!;
    const dispatched = meeting.actions[0]!;
    await db.query("UPDATE meeting_task_exports SET state='unknown' WHERE action_id=$1", [dispatched.id]);
    await repo.ingestPage([{ ...source(), action_items: [] }]);
    expect((await repo.get(meeting.id)).meeting.actions).toEqual([]);
    expect((await repo.get(meeting.id)).meeting.retiredActions).toEqual([expect.objectContaining({ id: dispatched.id, sourceState: 'retired', exportState: 'unknown' })]);
    const rows = (await db.query<{ state: string }>('SELECT state FROM meeting_task_exports ORDER BY state')).rows;
    expect(rows.map(v => v.state)).toEqual(['canceled', 'unknown']);
    await repo.ingestPage([source()]);
    expect((await repo.get(meeting.id)).meeting.sourceRevision).toBe(3);
    expect((await repo.get(meeting.id)).meeting.actions.find(a => a.id === dispatched.id)?.exportState).toBe('unknown');
    expect((await repo.get(meeting.id)).meeting.actions.find(a => a.id !== dispatched.id)?.exportState).toBe('queued');
    expect((await db.query("SELECT count(*)::integer AS count FROM meeting_task_exports WHERE state='queued' AND request_id IS NULL")).rows[0]!.count).toBe(1);
    expect((await db.query('SELECT * FROM meeting_task_exports')).rowCount).toBe(2);
  });
  it('keeps retired dispatched task history visible while excluding it from current action filters', async () => {
    const { repo, db } = await setup(); const input = source(); input.action_items![0]!.description = 'Unique retired source action'; await repo.ingestPage([input]);
    const meeting = (await repo.list({})).items[0]!, action = meeting.actions[0]!;
    await db.query("UPDATE meeting_task_exports SET state='created',remote_task_id='123',remote_url='https://tasks.example/tasks/123' WHERE action_id=$1", [action.id]);
    await repo.ingestPage([{ ...input, action_items: [] }]);
    const detail = (await repo.get(meeting.id)).meeting;
    expect(detail.actions).toEqual([]);
    expect(detail.retiredActions).toEqual([expect.objectContaining({ id: action.id, sourceState: 'retired', exportState: 'created', taskId: '123', taskUrl: 'https://tasks.example/tasks/123' })]);
    expect((await repo.list({})).items[0]!.retiredActions).toEqual(detail.retiredActions);
    expect((await repo.list({ exportState: 'created' })).total).toBe(0);
    expect((await repo.list({ query: action.description })).total).toBe(0);
    expect((await db.query("SELECT state FROM meeting_task_exports WHERE action_id=$1", [action.id])).rows[0]!.state).toBe('created');
  });
  it.each(['created', 'unknown'] as const)('preserves a %s task barrier across source removal and edited reappearance at the same anchor', async state => {
    const { repo, db } = await setup();
    const single = source(); single.action_items = [single.action_items![0]!];
    await repo.ingestPage([single]); const before = (await repo.list({})).items[0]!, action = before.actions[0]!;
    await db.query('UPDATE meeting_task_exports SET state=$2,remote_task_id=$3,remote_url=$4 WHERE action_id=$1', [action.id, state, state === 'created' ? '123' : null, state === 'created' ? 'https://tasks.example/tasks/123' : null]);
    await repo.ingestPage([{ ...single, action_items: [] }]);
    expect((await repo.get(before.id)).meeting.retiredActions).toEqual([expect.objectContaining({ id: action.id, exportState: state })]);
    const edited = structuredClone(single); edited.action_items![0]!.description += ' with the revised wording';
    await repo.ingestPage([edited]);
    const after = (await repo.get(before.id)).meeting;
    expect(after.actions).toEqual([expect.objectContaining({ id: action.id, version: 3, sourceState: 'current', description: edited.action_items![0]!.description, exportState: state })]);
    expect(after.retiredActions).toEqual([]);
    expect((await db.query('SELECT * FROM meeting_actions WHERE meeting_id=$1', [before.id])).rowCount).toBe(1);
    expect((await db.query('SELECT * FROM meeting_task_exports')).rowCount).toBe(1);
    expect((await db.query("SELECT * FROM meeting_task_exports WHERE state IN ('queued','failed')")).rowCount).toBe(0);
  });
  it('blocks edited reappearance when multiple retired source actions share the same anchor', async () => {
    const { repo, db } = await setup();
    const meeting = source(); meeting.action_items = [meeting.action_items![0]!];
    await repo.ingestPage([meeting]); const before = (await repo.list({})).items[0]!, exported = before.actions[0]!;
    await db.query("UPDATE meeting_task_exports SET state='unknown' WHERE action_id=$1", [exported.id]);
    const duplicate = structuredClone(meeting); duplicate.action_items!.push({ ...duplicate.action_items![0]!, description: 'Another action at this timestamp' });
    await repo.ingestPage([duplicate]); await repo.ingestPage([{ ...meeting, action_items: [] }]);
    const edited = structuredClone(meeting); edited.action_items![0]!.description = 'Ambiguous revised source action';
    await repo.ingestPage([edited]);
    const current = (await repo.get(before.id)).meeting;
    expect(current.actions).toHaveLength(1); expect(current.actions[0]!.sourceState).toBe('ambiguous');
    expect(current.retiredActions).toEqual([expect.objectContaining({ id: exported.id, exportState: 'unknown' })]);
    expect((await db.query("SELECT * FROM meeting_task_exports WHERE state IN ('queued','failed')")).rowCount).toBe(0);
  });
  it('does not clear ambiguous identity on later exact snapshots, retirement or edited reappearance', async () => {
    const { repo, db } = await setup();
    const original = source(); original.action_items = [original.action_items![0]!]; delete original.action_items[0]!.recording_timestamp;
    await repo.ingestPage([original]); const meeting = (await repo.list({})).items[0]!;
    await db.query("UPDATE meeting_task_exports SET state='unknown' WHERE action_id=$1", [meeting.actions[0]!.id]);
    const rewritten = structuredClone(original); rewritten.action_items![0]!.description = 'Rewritten source item without a stable anchor';
    await repo.ingestPage([rewritten]);
    const ambiguous = (await repo.get(meeting.id)).meeting.actions[0]!;
    expect(ambiguous.sourceState).toBe('ambiguous');
    await repo.ingestPage([{ ...rewritten, title: 'Title-only change' }]);
    expect((await repo.get(meeting.id)).meeting.actions).toEqual([expect.objectContaining({ id: ambiguous.id, sourceState: 'ambiguous', exportState: 'none' })]);
    await repo.ingestPage([{ ...rewritten, action_items: [] }]);
    await repo.ingestPage([{ ...rewritten, title: 'Ambiguous exact reappearance' }]);
    expect((await repo.get(meeting.id)).meeting.actions).toEqual([expect.objectContaining({ id: ambiguous.id, sourceState: 'ambiguous', exportState: 'none' })]);
    await repo.ingestPage([{ ...rewritten, action_items: [], title: 'Removed again' }]);
    const edited = structuredClone(rewritten); edited.action_items![0]!.description += ' with further edits';
    await repo.ingestPage([edited]);
    expect((await repo.get(meeting.id)).meeting.actions[0]!.sourceState).toBe('ambiguous');
    expect((await db.query('SELECT * FROM meeting_task_exports')).rowCount).toBe(1);
    expect((await db.query("SELECT * FROM meeting_task_exports WHERE state IN ('queued','failed')")).rowCount).toBe(0);
  });
  it('keeps stable action IDs for exact items and unambiguous wording changes; completion cancels queued work', async () => {
    const { repo, db } = await setup(); await repo.ingestPage([source()]);
    const before = (await repo.list({})).items[0]!;
    const revised = source(); revised.action_items![0]!.description += ' to the customer'; revised.action_items![1]!.completed = true;
    await repo.ingestPage([revised]); const after = (await repo.get(before.id)).meeting;
    expect(after.actions.map(a => a.id)).toEqual(before.actions.map(a => a.id));
    expect(after.actions.map(a => a.version)).toEqual([2, 2]);
    expect(after.actions.map(a => a.exportState)).toEqual(['queued', 'canceled']);
    const snapshots = (await db.query<{ snapshot: { actionVersion: number; title: string } }>("SELECT snapshot FROM meeting_task_exports WHERE state='queued'")).rows;
    expect(snapshots[0]!.snapshot).toMatchObject({ actionVersion: 2, title: revised.action_items![0]!.description });
    const ambiguous = source(); ambiguous.action_items = [source().action_items![0]!, source().action_items![0]!];
    await repo.ingestPage([ambiguous]);
    expect((await repo.get(before.id)).meeting.actions.every(a => a.sourceState === 'ambiguous' && a.exportState !== 'queued')).toBe(true);
  });
  it('preserves manual customer corrections, rejects stale writes and leaves domain collisions ambiguous', async () => {
    const { repo, db } = await setup(); await repo.ingestPage([source()]);
    const before = (await repo.list({})).items[0]!;
    const corrected = (await repo.setCustomers({ id: before.id, companyIds: [secondCompany], expectedVersion: before.mappingVersion, reason: 'Confirmed by operator' })).meeting;
    await expect(repo.setCustomers({ id: before.id, companyIds: [], expectedVersion: before.mappingVersion, reason: 'stale' })).rejects.toThrow('mapping changed');
    await repo.ingestPage([{ ...source(), title: 'new title' }]);
    expect((await repo.get(before.id)).meeting.customers).toEqual(corrected.customers);
    await db.query("UPDATE companies SET domains=ARRAY['acme.example'] WHERE id=$1", [secondCompany]);
    await repo.ingestPage([{ ...source(), recording_id: 90002 }]);
    const ambiguous = (await repo.list({ customerState: 'ambiguous' })).items;
    expect(ambiguous).toHaveLength(1); expect(ambiguous[0]!.customers).toEqual([]);
    const counts = await repo.customers(); expect(counts.unresolvedCount).toBe(1);
    expect(counts.items.find(c => c.id === secondCompany)?.meetingCount).toBe(1);
  });
  it('associates multiple unique customers while excluding internal and personal domains', async () => {
    const { repo, db } = await setup();
    await db.query("INSERT INTO companies(canonical_name,domains) VALUES('Personal or internal',ARRAY['gmail.com','example.org'])");
    const meeting = source();
    meeting.calendar_invitees!.push(
      { email: 'contact@other.example', is_external: true },
      { email: 'private@gmail.com', is_external: true },
      { email: 'colleague@example.org', is_external: true },
    );
    await repo.ingestPage([meeting]);
    const archived = (await repo.list({})).items[0]!;
    expect(archived.customerState).toBe('confirmed');
    expect(archived.customers.map(c => c.id).sort()).toEqual([firstCompany, secondCompany].sort());
    expect((await repo.customers()).items.filter(c => c.meetingCount === 1)).toHaveLength(2);
  });
  it('stores and pages long transcripts without truncation, preserving source order at duplicate timestamps', async () => {
    const { repo } = await setup();
    const meeting = source();
    meeting.transcript = Array.from({ length: 1003 }, (_, i) => ({ speaker: { display_name: 'Speaker' }, text: `Unabridged segment ${i}`, timestamp: '00:00:12' }));
    await repo.ingestPage([meeting]);
    const archived = (await repo.list({ query: 'Unabridged segment 1002' })).items[0]!;
    const result = []; let cursor: string | null = null;
    do {
      const page = await repo.transcript({ id: archived.id, limit: 500, ...(cursor ? { cursor } : {}) });
      expect(page.total).toBe(1003); result.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    expect(result).toEqual(meeting.transcript);
  });
  it('uses bound keyset cursors and half-open timestamps while searching all retained content', async () => {
    const { repo } = await setup();
    await repo.ingestPage([source(), { ...source(), recording_id: 90002 }, { ...source(), recording_id: 90003, recording_start_time: '2026-10-26T10:00:00Z' }]);
    const filter = { from: '2026-10-26T09:00:00Z', to: '2026-10-26T10:00:00Z' };
    const first = await repo.list({ ...filter, limit: 1 }), next = await repo.list({ ...filter, limit: 1, cursor: first.nextCursor! });
    expect(first.total).toBe(2); expect(next.items).toHaveLength(1); expect(next.nextCursor).toBeNull();
    expect(first.items[0]!.id).not.toBe(next.items[0]!.id);
    await expect(repo.list({ query: 'different', cursor: first.nextCursor! })).rejects.toThrow('filters');
    expect((await repo.list({ query: 'have not agreed a deadline' })).total).toBe(3);
    expect((await repo.list({ query: 'Confirm security review completion' })).total).toBe(3);
    expect((await repo.list({ query: 'No task deadlines' })).total).toBe(3);
    await expect(repo.list({ limit: 0 })).rejects.toThrow();
    await expect(repo.list({ unexpected: true } as never)).rejects.toThrow();
  });
  it('uses a supplied transaction and rolls the archive and queue back with the caller', async () => {
    const { repo, db } = await setup();
    await expect(db.transaction(async tx => { await repo.ingestPage([source()], {}, tx); throw new Error('cursor failed'); })).rejects.toThrow('cursor failed');
    expect((await repo.list({})).total).toBe(0);
    expect((await db.query('SELECT * FROM meeting_task_exports')).rowCount).toBe(0);
  });
});


it.skipIf(!process.env.MEETINGS_TEST_DATABASE_URL)('serializes concurrent same-recording commits in real PostgreSQL without losing revisions', async () => {
  const schema = `meeting_archive_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.MEETINGS_TEST_DATABASE_URL! });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.MEETINGS_TEST_DATABASE_URL!); url.searchParams.set('schema', schema);
  const db = new PgDatabase(url.toString());
  cleanup.push(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  for (const file of ['001_initial.sql', '202610260003_meetings.sql', '202610260005_meeting_tasks.sql']) {
    await db.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'));
  }
  const repo = new MeetingRepository(db);
  const repeated = await Promise.all(Array.from({ length: 12 }, () => repo.ingestPage([source()])));
  expect(repeated.reduce((sum, r) => sum + r.imported, 0)).toBe(1);
  await Promise.all(Array.from({ length: 8 }, (_, i) => repo.ingestPage([{ ...source(), title: `Concurrent observation ${i}` }])));
  expect((await db.query('SELECT revision FROM meeting_revisions ORDER BY revision')).rows.map(v => v.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect((await db.query('SELECT * FROM meeting_task_exports')).rowCount).toBe(2);
  await Promise.all(Array.from({ length: 4 }, (_, i) => repo.ingestPage([{ ...source(), recording_id: 91000 + i }])));
  expect((await repo.list({})).total).toBe(5);
});
