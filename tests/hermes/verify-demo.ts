import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { PgDatabase } from '../../src/platform/database.js';
import { VikunjaAdapter } from '../../src/vikunja/adapter.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';

// Readback only for the one existing owned synthetic demo. Never creates a new fixture.
const project = process.env['WORKFLOW_TEST_PROJECT']; if (!project || !/^antseed-b-m4-[a-z0-9-]+$/.test(project)) throw new Error('Owned synthetic M4 project required');
const manifest = JSON.parse(await readFile('/tmp/antseed-b-m4-public.json', 'utf8')) as { ticketId: string; url: string };
const args = ['compose', '-p', project, '-f', 'compose.yaml']; if (process.env['WORKFLOW_TEST_COMPOSE_OVERRIDE']) args.push('-f', process.env['WORKFLOW_TEST_COMPOSE_OVERRIDE']);
const bundle = parse(execFileSync('docker', [...args, 'exec', '-T', 'vikunja', 'cat', '/run/antseed/runtime.env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const config = await loadRuntimeConfig({ ...bundle, AI_ENV_PATH: '/antseed-test-no-ai', DATABASE_URL: bundle['DATABASE_URL']!.replace('postgres:5432', `127.0.0.1:${process.env['WORKFLOW_TEST_PG_PORT']}`), VIKUNJA_URL: process.env['WORKFLOW_TEST_VIKUNJA_URL']! });
const admin = new PgDatabase(config.databaseUrl); let db: PgDatabase | null = null;
try {
  const schemas = (await admin.query<{ table_schema: string }>("SELECT table_schema FROM information_schema.tables WHERE table_name='tickets' AND table_schema LIKE 'm4_%'")).rows;
  if (schemas.length !== 1 || !/^m4_[a-f0-9]{32}$/.test(schemas[0]!.table_schema)) throw new Error('Expected exactly one owned M4 demo schema');
  const url = new URL(config.databaseUrl); url.searchParams.set('options', `-c search_path=${schemas[0]!.table_schema}`); db = new PgDatabase(url.toString());
  const ticket = (await db.query('SELECT lane,stage_version,vikunja_task_id FROM tickets WHERE id=$1', [manifest.ticketId])).rows[0]!;
  const proposals = (await db.query('SELECT id,decision,apply_state,origin,target_lane FROM proposals WHERE ticket_id=$1', [manifest.ticketId])).rows;
  const adapter = new VikunjaAdapter(config.vikunja, db); const board = await adapter.ensureBoard(); const task = await adapter.getTask(ticket.vikunja_task_id);
  const mutations = (await db.query('SELECT count(*) FROM mutations')).rows[0]!.count;
  const result = { proposalCount: proposals.length, proposals, localLane: ticket.lane, localStageVersion: ticket.stage_version, remoteBucket: task!.bucketId, expectedInitialBucket: board.buckets['To be started'], remoteUnchanged: task!.bucketId === board.buckets['To be started'], mutationCount: Number(mutations) };
  if (result.localLane !== 'To be started' || result.localStageVersion !== 0 || !result.remoteUnchanged || result.mutationCount !== 0) throw new Error('Unexpected synthetic demo stage mutation');
  await writeFile('/tmp/antseed-b-m4-hermes-proposal-readback.json', JSON.stringify(result)); console.log(JSON.stringify(result));
} finally { await db?.close(); await admin.close(); }
