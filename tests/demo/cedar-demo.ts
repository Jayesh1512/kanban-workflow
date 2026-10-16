/** PM-executed tooling only. Never starts/stops Compose, workers, AI or Telegram. */
import { constants } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { createPlatformModule } from '../../src/platform/module.js';
import { createWorkflowServices } from '../../src/workflow/module.js';
import { inputHash } from '../../src/workflow/analysis.js';
import { CHAT_ID, SELF_ID, DEMO_KEY, SOURCE_LABEL, authoredDecision, authoredExtraction, authoredProvenance, messages } from './cedar.js';
import { DemoError, docker, inspectInventory, loadManifest, runtimeConfig, type DemoManifest } from './config.js';

type Marker = { anchor: string; sourceBoundary: string; version: 1 };
async function privateLogin(path: string, value: { url: string; username: string; password: string }) {
  // Exclusive create/no-follow. Existing correct private artifact is reusable;
  // never truncate an arbitrary path or print service credentials.
  try { const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await file.writeFile(JSON.stringify(value)); } finally { await file.close(); } }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if ((stat.mode & 0o777) !== 0o600 || await file.readFile('utf8') !== JSON.stringify(value)) throw new DemoError('Existing login artifact is not the same private0600 fixture; use a fresh owned artifact directory'); } finally { await file.close(); }
  }
}
async function seed(m: DemoManifest) {
  inspectInventory(m, docker(m, ['ps', '--all', '--format', 'json']), true);
  const config = await runtimeConfig(m); const bootstrap = new PgDatabase(config.databaseUrl);
  try { await migrate(bootstrap); } finally { await bootstrap.close(); }
  const platform = await createPlatformModule(config); const s = createWorkflowServices(platform.services), db = platform.services.db;
  try {
    await db.withSessionLock('antseed:demo:m5:seed', async () => {
      let marker = (await db.query<{ value: Marker }>('SELECT value FROM app_settings WHERE key=$1', [DEMO_KEY])).rows[0]?.value;
      if (!marker) {
        const counts = (await db.query('SELECT (SELECT count(*) FROM chats)::int AS chats,(SELECT count(*) FROM companies)::int AS companies')).rows[0]!;
        if (counts.chats !== 0 || counts.companies !== 0) throw new DemoError('Fresh PM demo dataset required; helper never clears or overwrites an existing dataset');
        marker = { anchor: new Date().toISOString(), sourceBoundary: SOURCE_LABEL, version: 1 };
        await db.query('INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)', [DEMO_KEY, JSON.stringify(marker)]);
      }
      if (marker.version !== 1 || marker.sourceBoundary !== SOURCE_LABEL) throw new DemoError('Unexpected demo fixture marker');
      const completed = (await db.query("SELECT 1 FROM analysis_jobs WHERE chat_id=$1 AND status='completed' LIMIT 1", [CHAT_ID])).rows.length > 0;
      if (!completed) {
        await platform.services.ingestion.bindAccount(SELF_ID);
        await platform.services.ingestion.upsertDialog({ id: CHAT_ID, kind: 'supergroup', title: 'Cedar Labs — SYNTHETIC DEMO', username: null, archived: false });
        for (const message of messages(marker.anchor)) await platform.services.ingestion.ingest({ type: 'message', message });
        const job = await s.analysis.claim({ workerId: 'pm-demo-authored-fixture', leaseMs: 120000 });
        if (!job || job.chatId !== CHAT_ID) throw new DemoError('Demo analysis claim unavailable; wait for an interrupted fixture lease, keep backend stopped, then rerun');
        const input = await s.analysis.loadInput(job.id), extraction = authoredExtraction(input);
        await s.analysis.saveExtraction({ jobId: job.id, inputHash: inputHash(input), extraction, provenance: authoredProvenance('openai', new Date().toISOString()) }, job.claimToken);
        await s.analysis.complete(job.id, authoredDecision(extraction), authoredProvenance('vercel', new Date().toISOString()), job.claimToken);
      }
      const ticket = (await s.records.listTickets({})).items[0];
      if (!ticket) throw new DemoError('Expected sourced demo ticket after authored decision');
      const proposals = (await s.proposals.list({ ticketId: ticket.id })).items;
      const count = Number((await db.query('SELECT count(*) FROM mutations')).rows[0]!.count);
      if (proposals.length !== 1 || proposals[0]!.decision !== 'pending' || proposals[0]!.applyState !== 'not_requested' || ticket.lane !== 'To be started' || ticket.stageVersion !== 0 || count !== 0) throw new DemoError('Demo already advanced or incomplete; never reset it—use the appropriate verification command');
      if ((await db.query("SELECT 1 FROM analysis_jobs WHERE status IN ('pending','running','retry','provider_unavailable') LIMIT 1")).rows.length) throw new DemoError('Unexpected unfinished analysis; retain fixture for inspection before worker start');
      const context = await s.records.getContext({ ticketId: ticket.id, limit: 20 });
      const binding = (await db.query('SELECT project_id::text,view_id::text FROM board_bindings WHERE singleton')).rows[0];
      if (!binding) throw new DemoError('Boot the canonical backend once to create its board, stop only that backend, then rerun seed');
      const base = `http://127.0.0.1:${m.ports.backend}`, vikunja = `http://127.0.0.1:${m.ports.vikunja}`;
      const approval = { idempotencyKey: `pm-demo:approve:${proposals[0]!.id}`, decision: 'approve', note: 'Explicit operator approval of synthetic authored Cedar demo proposal' };
      const artifact = { version: 1, project: m.project, sourceBoundary: SOURCE_LABEL, seedAnchor: marker.anchor, chatId: CHAT_ID, companyId: ticket.companyId, ticketId: ticket.id, proposalId: proposals[0]!.id, contactIds: context.contacts.map((c) => c.id), factIds: context.facts.map((f) => f.id), evidenceIds: context.evidence.map((e) => e.id), followUpDate: context.facts.flatMap((f) => f.dates).find((d) => d.localDate)?.localDate,
        initial: { lane: ticket.lane, stageVersion: ticket.stageVersion, proposalDecision: proposals[0]!.decision, applyState: proposals[0]!.applyState, mutationCount: count, taskId: ticket.vikunjaTaskId },
        urls: { backend: base, status: `${base}/api/status`, context: `${base}/api/tickets/${ticket.id}/context`, proposal: `${base}/api/proposals/${proposals[0]!.id}`, priorities: `${base}/api/priorities/today?timezone=Asia%2FKolkata`, vikunja, board: `${vikunja}/projects/${binding.project_id}/${binding.view_id}`, approval: `${base}/api/proposals/${proposals[0]!.id}/decision` }, approvalBodyFile: join(m.directory, 'cedar-approval.json'), privateBrowserLoginFile: join(m.directory, 'vikunja-browser-login.private.json') };
      if (!config.vikunja.password) throw new DemoError('Generated browser password missing');
      await privateLogin(artifact.privateBrowserLoginFile, { url: vikunja, username: config.vikunja.username, password: config.vikunja.password });
      await writeFile(artifact.approvalBodyFile, JSON.stringify(approval), { mode: 0o600 });
      await writeFile(join(m.directory, 'cedar-demo.json'), JSON.stringify(artifact, null, 2), { mode: 0o600 });
      console.log(JSON.stringify(artifact)); // Explicit field allowlist; no config/bundle/JWT.
    });
  } finally { await platform.stop(); }
}
async function verify(m: DemoManifest, applied: boolean) {
  inspectInventory(m, docker(m, ['ps', '--all', '--format', 'json']), false);
  const config = await runtimeConfig(m), platform = await createPlatformModule(config), s = createWorkflowServices(platform.services), db = platform.services.db;
  try {
    const manifest = JSON.parse(await readFile(join(m.directory, 'cedar-demo.json'), 'utf8')) as { ticketId: string; proposalId: string; project: string };
    if (manifest.project !== m.project) throw new DemoError('Seed manifest project mismatch');
    const deadline = Date.now() + 20000;
    for (let i = 0; i < 100 && Date.now() < deadline; i++) {
      const ticket = await s.records.getTicket(manifest.ticketId), proposal = await s.proposals.get(manifest.proposalId);
      const journals = (await db.query('SELECT state,attempts FROM mutations WHERE proposal_id=$1', [proposal.id])).rows;
      const buckets = (await db.query<{ lane: string; bucket_id: string }>('SELECT lane,bucket_id::text FROM board_buckets')).rows;
      const remote = ticket.vikunjaTaskId ? await platform.services.vikunja.getTask(ticket.vikunjaTaskId) : null;
      const expected = applied ? 'Work in progress' : 'To be started';
      const good = remote && ticket.lane === expected && ticket.stageVersion === (applied ? 1 : 0) && remote.bucketId === buckets.find((b) => b.lane === expected)?.bucket_id && proposal.decision === (applied ? 'approved' : 'pending') && proposal.applyState === (applied ? 'applied' : 'not_requested') && (applied ? journals.length === 1 && journals[0]!.state === 'committed' : journals.length === 0);
      if (good) {
        const context = await s.records.getContext({ ticketId: ticket.id, limit: 20 });
        if (context.contacts.length !== 2 || !remote.description.includes('Mira Sen') || !remote.description.includes('Jo Rao') || !remote.description.includes('SYNTHETIC DEMO')) throw new DemoError('Actual remote details/context lack authored demo source boundaries');
        const result = { project: m.project, sourceBoundary: SOURCE_LABEL, verified: applied ? 'approved-and-worker-applied' : 'pending-and-worker-projected', ticketId: ticket.id, proposalId: proposal.id, taskId: remote.id, localLane: ticket.lane, stageVersion: ticket.stageVersion, remoteBucketId: remote.bucketId, proposalDecision: proposal.decision, applyState: proposal.applyState, mutationCount: journals.length, committedMutationCount: journals.filter((j) => j.state === 'committed').length, contactCount: context.contacts.length, evidenceCount: context.evidence.length };
        await writeFile(join(m.directory, applied ? 'cedar-applied-readback.json' : 'cedar-pending-readback.json'), JSON.stringify(result, null, 2), { mode: 0o600 }); console.log(JSON.stringify(result)); return;
      }
      if (!applied && (ticket.stageVersion !== 0 || proposal.decision !== 'pending' || journals.length > 0)) throw new DemoError('Pending demo advanced unexpectedly; verification never changes or reverses it');
      await delay(200);
    }
    throw new DemoError('Canonical worker/readback did not reach expected state within20s; inspect sanitized status, do not fabricate success');
  } finally { await platform.stop(); }
}
const [command, flag, path, ...extra] = process.argv.slice(2);
try {
  if (!['seed', 'verify-pending', 'verify-applied'].includes(command ?? '') || flag !== '--manifest' || !path || extra.length) throw new DemoError('Usage: node --import tsx tests/demo/cedar-demo.ts seed|verify-pending|verify-applied --manifest /absolute/PM/manifest.json');
  const m = await loadManifest(path); if (command === 'seed') await seed(m); else await verify(m, command === 'verify-applied');
} catch (error) { console.error(error instanceof DemoError ? error.message : 'Demo operation failed; credential/upstream details suppressed. Keep the owned fixture for inspection.'); process.exitCode = 1; }
