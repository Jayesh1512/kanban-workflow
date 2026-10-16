import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { createPlatformModule } from '../../src/platform/module.js';
import { createWorkflowModule } from '../../src/workflow/module.js';
import { buildApp } from '../../src/app.js';
import { inputFixture, jobId, sourceText } from '../intelligence/fixtures.js';
import { seedJob } from '../workflow/database.js';
import { workflowHarness } from '../workflow/harness.js';

/** Only explicitly owned disposable stack; generated service credentials stay in memory. */
export async function nativeFixture() {
  const project = process.env['WORKFLOW_TEST_PROJECT'];
  if (!project || !/^antseed-b-m4-[a-z0-9-]+$/.test(project)) throw new Error('Require an isolated Builder B M4 synthetic project');
  const args = ['compose', '-p', project, '-f', 'compose.yaml']; if (process.env['WORKFLOW_TEST_COMPOSE_OVERRIDE']) args.push('-f', process.env['WORKFLOW_TEST_COMPOSE_OVERRIDE']);
  const bundle = parse(execFileSync('docker', [...args, 'exec', '-T', 'vikunja', 'cat', '/run/antseed/runtime.env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const config = await loadRuntimeConfig({ ...bundle, AI_ENV_PATH: '/antseed-test-no-ai', OPENAI_API_KEY: '', JEV_API_KEY: '', AI_GATEWAY_API_KEY: 'synthetic-not-a-credential', DATABASE_URL: bundle['DATABASE_URL']!.replace('postgres:5432', `127.0.0.1:${process.env['WORKFLOW_TEST_PG_PORT']}`), VIKUNJA_URL: process.env['WORKFLOW_TEST_VIKUNJA_URL']! });
  const admin = new PgDatabase(config.databaseUrl); const schema = `m4_${randomUUID().replaceAll('-', '')}`; await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(config.databaseUrl); url.searchParams.set('options', `-c search_path=${schema}`); config.databaseUrl = url.toString();
  const dir = await mkdtemp(join(tmpdir(), 'antseed-m4-')); config.telegram.sessionPath = join(dir, 'session');
  const seed = new PgDatabase(config.databaseUrl);
  try {
    await migrate(seed); await seed.query('INSERT INTO telegram_account(self_user_id) VALUES(99)');
    await seed.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-1001,'supergroup','AntSeed M4 Synthetic Cedar','included')");
    const m = inputFixture().messages[0]!;
    await seed.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(-1001,1,7,$1,$2,$3,$4,$5)', [m.sentAt, sourceText, m.sender, m.peer, m.forward]); await seedJob(seed, jobId);
    // Controlled model stand-ins seed real records; NOT evidence of live inference.
    const platform = await createPlatformModule(config); const h = await workflowHarness({ db: seed, vikunja: platform.services.vikunja });
    await seed.query("UPDATE companies SET canonical_name='AntSeed M4 Synthetic Cedar' WHERE id=$1", [h.ticket.companyId]);
    const workflow = await createWorkflowModule(platform.services); const app = await buildApp({ modules: [platform, workflow] });
    let closed = false;
    return { app, platform, workflow, config, db: seed, h, async close() { if (closed) return; closed = true; await app.close(); await seed.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); await rm(dir, { recursive: true, force: true }); } };
  } catch (error) { await seed.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); await rm(dir, { recursive: true, force: true }); throw error; }
}
