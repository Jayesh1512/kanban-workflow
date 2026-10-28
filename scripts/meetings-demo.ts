import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResult, QueryResultRow } from 'pg';
import { buildApp } from '../src/app.js';
import { createMeetingFeature, disabledMeetingConfig } from '../src/meetings/feature.js';
import type { FathomMeeting } from '../src/meetings/domain.js';
import type { Database, DomainServices, SqlExecutor, RuntimeConfig } from '../src/shared/ports.js';
import { MCP_OPERATIONS } from '../src/shared/api.js';
import { createBindings } from '../src/hermes/bindings.js';
import { registerHttp } from '../src/hermes/http.js';
import { registerMcp } from '../src/hermes/mcp.js';

// An isolated, persistent synthetic archive. No production env files, Fathom key,
// Telegram sessions, Vikunja credentials or external workers are loaded here.
const dataDirectory = fileURLToPath(new URL('../.local/meeting-demo/', import.meta.url));
await mkdir(dataDirectory, { recursive: true });
const engine = new PGlite(dataDirectory);
await engine.exec('CREATE TABLE IF NOT EXISTS demo_migrations(version text PRIMARY KEY,checksum text NOT NULL)');
for (const name of ['001_initial.sql', '202610260003_meetings.sql', '202610260004_meeting_ingestion.sql', '202610260005_meeting_tasks.sql']) {
  const sql = await readFile(new URL('../db/migrations/' + name, import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const existing = await engine.query<{ checksum: string }>('SELECT checksum FROM demo_migrations WHERE version=$1', [name]);
  if (existing.rows[0]) {
    if (existing.rows[0].checksum !== checksum) throw new Error('Demo schema changed. Remove .local/meeting-demo to rebuild only this synthetic archive.');
  } else {
    await engine.exec('BEGIN');
    try { await engine.exec(sql); await engine.query('INSERT INTO demo_migrations VALUES($1,$2)', [name, checksum]); await engine.exec('COMMIT'); }
    catch (error) { await engine.exec('ROLLBACK'); throw error; }
  }
}
const context = new AsyncLocalStorage<SqlExecutor>();
let tail: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> { const result = tail.then(work); tail = result.catch(() => {}); return result; }
const direct: SqlExecutor = { async query<R extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<R>> {
  const result = await engine.query<R>(sql, values);
  return { rows: result.rows, rowCount: result.rows.length || result.affectedRows || 0, fields: [], command: '', oid: 0 };
} };
const db: Database = {
  query: <R extends QueryResultRow>(sql: string, values?: unknown[]) => context.getStore() ? direct.query<R>(sql, values) : serialize(() => direct.query<R>(sql, values)),
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>) {
    if (context.getStore()) return Promise.reject(new Error('Nested demo transactions are not supported'));
    return serialize(async () => { await engine.exec('BEGIN'); try { const result = await context.run(direct, () => work(direct)); await engine.exec('COMMIT'); return result; } catch (error) { await engine.exec('ROLLBACK'); throw error; } });
  },
  async withSessionLock() { throw new Error('The synthetic demo does not run remote task publishers'); },
  async close() { await tail; await engine.close(); },
};
const config = {
  timezone: 'Asia/Kolkata', meetings: disabledMeetingConfig,
  vikunja: { baseUrl: 'http://127.0.0.1:1', publicUrl: 'http://127.0.0.1:1', username: '', password: null, apiToken: null, projectTitle: 'Synthetic demo' },
} as RuntimeConfig;
const feature = createMeetingFeature({ db, config, clock: { now: () => new Date() } }, { demo: true, taskPort: null });
if (!(await db.query('SELECT 1 FROM meetings LIMIT 1')).rowCount) {
  for (const [id, name, domain] of [
    ['00000000-0000-4000-8000-000000009001', 'Acme', 'acme.example'],
    ['00000000-0000-4000-8000-000000009002', 'Cedar Labs', 'cedar.example'],
    ['00000000-0000-4000-8000-000000009003', 'Northstar', 'northstar.example'],
  ]) await db.query('INSERT INTO companies(id,canonical_name,domains) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [id, name, [domain]]);
  const base = JSON.parse(await readFile(new URL('../tests/meetings/fixtures/fathom-meeting.json', import.meta.url), 'utf8')) as FathomMeeting;
  const specifications = [
    { id: 90001, company: 'Acme', domain: 'acme.example', title: 'Pilot readiness & next steps', day: '2026-10-26', hour: '09', summary: 'The pilot is working. Updated onboarding documentation and security review confirmation remain open. The next customer meeting will decide on rollout.', actions: ['Send the updated onboarding guide', 'Confirm security review completion'] },
    { id: 90002, company: 'Cedar Labs', domain: 'cedar.example', title: 'Implementation check-in', day: '2026-10-26', hour: '09', summary: 'The integration is ready for staging. Cedar Labs will share a sample data set; Alex will document the staging setup. No deadlines were agreed.', actions: ['Document the staging setup', 'Share the sample data set'] },
    { id: 90003, company: 'Northstar', domain: 'northstar.example', title: 'Customer kickoff', day: '2026-10-25', hour: '11', summary: 'The team agreed on the initial pilot scope. Success criteria and the project contact list need to be shared before the next planning call.', actions: ['Share the pilot success criteria', 'Send the project contact list'] },
    { id: 90004, company: 'Cedar Labs', domain: 'cedar.example', title: 'Technical discovery', day: '2026-10-24', hour: '14', summary: 'Technical discovery covered authentication, data formats and the staging environment. The team will prepare a sample request and confirm the authentication flow.', actions: ['Prepare a sample API request', 'Confirm the authentication flow'] },
    { id: 90005, company: 'Acme', domain: 'acme.example', title: 'Rollout planning', day: '2026-10-23', hour: '10', summary: 'Acme reviewed rollout readiness. The onboarding guide needs a refresh. The security checklist has already been shared with the customer.', actions: ['Refresh the onboarding guide', 'Share the security checklist'] },
    { id: 90006, company: 'Partner', domain: 'unknown.example', title: 'Partner introduction', day: '2026-10-22', hour: '08', summary: 'An introductory conversation identified a possible pilot. Customer identity needs confirmation before this recording is linked to an existing company.', actions: ['Send the introductory materials'] },
  ];
  const meetings = specifications.map(spec => {
    const meeting = JSON.parse(JSON.stringify(base).replaceAll('Acme', spec.company).replaceAll('acme.example', spec.domain)) as FathomMeeting;
    meeting.recording_id = spec.id; meeting.title = spec.title; meeting.meeting_title = spec.title;
    meeting.recording_start_time = meeting.scheduled_start_time = spec.day + 'T' + spec.hour + ':00:00Z';
    meeting.recording_end_time = spec.day + 'T' + spec.hour + ':42:00Z'; meeting.scheduled_end_time = spec.day + 'T' + spec.hour + ':45:00Z';
    meeting.created_at = spec.day + 'T' + spec.hour + ':45:00Z';
    meeting.url = 'https://fathom.video/calls/synthetic-' + spec.id; meeting.share_url = 'https://fathom.video/share/synthetic-' + spec.id;
    meeting.default_summary = { template_name: 'general', markdown_formatted: '## Summary\n' + spec.summary + '\n\n## Context\nSynthetic demonstration data. No real customer recording is included.' };
    meeting.action_items = spec.actions.map((description, index) => ({ ...structuredClone(base.action_items![index % 2]!), description, completed: spec.id === 90005 && index === 1 }));
    meeting.transcript = [
      { timestamp: '00:00:12', speaker: { display_name: 'Alex Morgan', matched_calendar_invitee_email: 'alex@example.org' }, text: 'This is a synthetic demonstration of our ' + spec.company + ' meeting: ' + spec.title + '.' },
      { timestamp: '00:04:30', speaker: { display_name: 'Jordan Lee', matched_calendar_invitee_email: 'jordan@' + spec.domain }, text: spec.summary },
      ...spec.actions.map((description, index) => ({ timestamp: index ? '00:12:10' : '00:10:45', speaker: { display_name: index ? 'Jordan Lee' : 'Alex Morgan' }, text: 'My action item is: ' + description + '. No due date has been agreed.' })),
    ];
    return meeting;
  });
  await feature.archive.ingestPage(meetings, { origin: 'manual' });
}
const catalog = MCP_OPERATIONS.filter(op => op.service.startsWith('meetings.'));
// Only the meeting catalog is registered below; unrelated domain closures cannot run.
const bindings = createBindings({ meetings: feature.archive } as unknown as DomainServices, 'http');
const ready = async () => {};
let transports: ReturnType<typeof registerMcp> | null = null;
const calls = new Set<Promise<unknown>>();
let stopping = false;
async function track<T>(work: () => Promise<T>): Promise<T> {
  if (stopping) throw new Error('Demo stopping');
  const result = Promise.resolve().then(work); calls.add(result); try { return await result; } finally { calls.delete(result); }
}
async function stop() { stopping = true; await transports?.close(); await Promise.allSettled([...calls]); }
const app = await buildApp({ modules: [{ name: 'synthetic-meeting-demo', async register(server) {
  server.get('/', (_request, reply) => reply.redirect('/meetings'));
  await feature.register(server, ready);
  registerHttp(server, bindings, ready, track, catalog);
  transports = registerMcp(server, bindings, ready, track, catalog);
  server.addHook('preClose', stop);
}, async start() {}, async stop() { await stop(); await db.close(); }, async status() { return { state: 'ready', code: null, detail: 'Synthetic archive; no external services', checkedAt: new Date().toISOString() }; } }] });
const port = Number(process.env['MEETINGS_DEMO_PORT'] ?? 19480);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MEETINGS_DEMO_PORT');
await app.listen({ host: '127.0.0.1', port });
console.log('Synthetic Meeting Analyzer demo: http://127.0.0.1:' + port + '/meetings');
process.once('SIGINT', () => { void app.close(); });
process.once('SIGTERM', () => { void app.close(); });
