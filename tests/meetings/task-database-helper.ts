import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PgDatabase } from '../../src/platform/database.js';
import type { MeetingTaskSnapshot } from '../../src/meetings/domain.js';
export const taskTestUrl = process.env.MEETINGS_TEST_DATABASE_URL;
export async function taskDatabase() {
  if (!taskTestUrl) throw new Error('MEETINGS_TEST_DATABASE_URL is required for session-lock tests');
  const schema = `meeting_tasks_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: taskTestUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(taskTestUrl); url.searchParams.set('schema', schema);
  const db = new PgDatabase(url.toString());
  await db.query(`CREATE TABLE meeting_actions(id uuid PRIMARY KEY,meeting_id uuid NOT NULL,version integer NOT NULL DEFAULT 1,description text NOT NULL,assignee jsonb,recording_timestamp text,playback_url text,completed boolean NOT NULL DEFAULT false,source_state text NOT NULL DEFAULT 'current',source_revision integer NOT NULL DEFAULT 1)`);
  await db.query('CREATE TABLE board_bindings(singleton boolean PRIMARY KEY,project_id text NOT NULL)');
  await db.query("INSERT INTO board_bindings VALUES(true,'7')");
  await db.query(await readFile(new URL('../../db/migrations/202610260005_meeting_tasks.sql', import.meta.url), 'utf8'));
  return { db, admin, async close() { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } };
}
export async function seedExport(db: PgDatabase, changes: Partial<MeetingTaskSnapshot> = {}) {
  const snapshot: MeetingTaskSnapshot = { actionId: randomUUID(), actionVersion: 1, meetingId: randomUUID(), meetingTitle: 'Acme review', title: 'Send proposal', description: 'Send proposal from meeting', customerNames: ['Acme'], sourceUrl: 'https://fathom.video/share/example', playbackUrl: 'https://fathom.video/share/example?t=33', timestamp: '00:00:33', assignee: { name: 'Taylor', email: 'taylor@example.test', team: 'Sales' }, dueAt: null, ...changes };
  await db.query('INSERT INTO meeting_actions(id,meeting_id,description) VALUES($1,$2,$3)', [snapshot.actionId, snapshot.meetingId, snapshot.description]);
  const row = (await db.query<{ id: string }>('INSERT INTO meeting_task_exports(action_id,action_version,snapshot) VALUES($1,$2,$3) RETURNING id', [snapshot.actionId, snapshot.actionVersion, JSON.stringify(snapshot)])).rows[0]!;
  return { ...row, snapshot };
}
