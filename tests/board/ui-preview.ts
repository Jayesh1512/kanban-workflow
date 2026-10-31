/**
 * Isolated UI preview for the native workspace. Run: npx tsx tests/board/ui-preview.ts
 *
 * Everything here is synthetic: an in-process PostgreSQL engine, a local stand-in for
 * Supabase Auth, and invented companies/tasks. It never reads .local secrets, the real
 * database, Telegram or any AI provider, and sends no email.
 * Sign in on http://localhost:19490/login with any of the accounts below and any
 * password except "wrong" (sign-up is accepted and does nothing).
 */
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../../src/app.js';
import { AccessControl } from '../../src/access/service.js';
import { registerBoard } from '../../src/board/routes.js';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import { nativeOutreachPage } from '../../src/outreach/page.js';
import { DomainError } from '../../src/shared/api.js';
import { workspacePage } from '../../src/board/page.js';
import { ProposalRepository } from '../../src/workflow/proposals.js';
import { TelegramStore } from '../../src/telegram/store.js';
import { fixtureDatabase } from '../workflow/database.js';

const port = Number(process.env.PREVIEW_PORT ?? 19490);
const migrations = ['202610250001_outreach_core.sql', '202610260001_outreach_workflow.sql', '202610260002_stable_outreach_sources.sql', '202610270004_operator_intake_approvals.sql', '202610280001_crm_first.sql', '202610290001_native_workspace.sql','202610300001_work_task_ownership.sql','202610310001_ticket_headline.sql'];
const accounts = [
  ['ravi@antseed.com', 'admin', 'Ravi Admin'], ['manager@example.com', 'crm_manager', 'Maya Manager'],
  ['member@example.com', 'member', 'Mohan Member'], ['other@example.com', 'member', 'Olivia Other'], ['viewer@example.com', 'viewer', 'Vera Viewer'],
] as const;

// Synthetic values only: no Telegram session is ever opened by this preview.
const telegramConfig: ConstructorParameters<typeof TelegramStore>[1] = { apiId: 1, apiHash: 'SYNTHETIC-NOT-A-REAL-HASH', sessionPath: ':memory:', historyBatchSize: 2, historyMaxBatches: 1 };
const db = await fixtureDatabase(migrations.map((name) => new URL(`../../db/migrations/${name}`, import.meta.url)));
const provider = Fastify();
const identities = new Map<string, { id: string; email: string; email_confirmed_at: string }>(accounts.map(([email]) => [email, { id: randomUUID(), email, email_confirmed_at: '2026-10-29T00:00:00Z' }]));
const keys = await generateKeyPair('ES256'), jwk = { ...await exportJWK(keys.publicKey), kid: 'synthetic-jwt-key', alg: 'ES256', use: 'sig' };
let origin = '';
const emailOf = (token: string) => token.split('.').length === 3 ? String(decodeJwt(token).email) : token;
provider.get('/auth/v1/user', async (req, reply) => identities.get(emailOf(req.headers.authorization?.replace('Bearer ', '') ?? '')) ?? reply.code(401).send({ error: 'Invalid token' }));
provider.get('/auth/v1/.well-known/jwks.json', async () => ({ keys: [jwk] }));
provider.get('/auth/v1/settings', async () => ({ mailer_autoconfirm: false }));
provider.post('/auth/v1/token', async (req, reply) => {
  const input = req.body as { email?: string; password?: string; refresh_token?: string }, email = input.email?.toLowerCase() ?? input.refresh_token, identity = email ? identities.get(email) : undefined;
  if (!identity || input.password === 'wrong') return reply.code(400).send({ error: 'Invalid credentials' });
  const access_token = await new SignJWT({ email: identity.email }).setProtectedHeader({ alg: 'ES256', kid: 'synthetic-jwt-key' }).setSubject(identity.id)
    .setIssuer(`${origin}/auth/v1`).setAudience('authenticated').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
  return { access_token, refresh_token: identity.email, expires_in: 3600 };
});
provider.post('/auth/v1/signup', async () => ({ user: { id: randomUUID() } }));
provider.post('/auth/v1/logout', async (_req, reply) => reply.code(204).send());
origin = await provider.listen({ host: '127.0.0.1', port: 0 });

const access = new AccessControl(db, { supabaseUrl: origin, publishableKey: 'synthetic-public-key', adminEmail: 'ravi@antseed.com', appUrl: `http://localhost:${port}`, crmApproval: 'direct' });
const app = await buildApp();
await access.register(app);
app.decorate('workspaceAccess', access);
const outreach = new OutreachWorkflow(db, { now: () => new Date() }, { provider: 'openai', endpoint: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', apiKey: null, timeoutMs: 1000, maxAttempts: 1 }, { nativeBoard: true });
registerBoard(app, db, outreach, async () => {}, 'Asia/Kolkata', {
  work: new ProposalRepository(db, { subscribe: () => () => {}, enqueueProposal: async () => {} }),
  intake: new TelegramStore(db as never, telegramConfig),
});
if (!app.hasRoute({ method: 'GET', url: '/approvals' })) app.get('/approvals', async (_req, reply) => reply.type('text/html; charset=utf-8').send(workspacePage));

// Read-only stand-ins for routes the full workflow module registers.
app.get('/', async (_req, reply) => reply.redirect('/dashboard'));
app.get('/outreach', async (_req, reply) => reply.header('Cache-Control', 'no-store').type('text/html').send(nativeOutreachPage));
app.get('/connections', async (_req, reply) => reply.type('text/html').send('<!doctype html><title>Connections</title><p>Synthetic preview: Connections page is not part of this UI.</p><a href="/dashboard">Back</a>'));
app.get('/api/outreach/relationships', async (req) => { const q = req.query as { limit?: string; cursor?: string }; return outreach.list({ limit: Number(q.limit ?? 50), ...(q.cursor ? { cursor: q.cursor } : {}) }); });
// Public detail hides unplaced relationships; the Approvals route reads them.
app.get('/api/outreach/relationships/:id', async (req) => { const detail = await outreach.get((req.params as { id: string }).id); if (!detail.relationship.acceptedStage) throw new DomainError('not_found', 'Relationship not found'); return detail; });
app.get('/api/outreach/proposals', async (req) => outreach.listProposals(req.query));
app.get('/api/outreach/status', async () => outreach.status());
app.post('/api/outreach/relationships/:id/assess', async (req) => {
  const id = (req.params as { id: string }).id, r = (await outreach.get(id)).relationship;
  await outreach.propose({ relationshipId: id, expectedEvidenceRevision: r.evidenceRevision, targetStage: 'negotiation', idempotencyKey: randomUUID(), reason: 'Synthetic AI assessment: pricing was discussed in the latest messages.' }, 'openai');
  return { status: 'proposed', detail: 'synthetic' };
});
app.get('/api/tickets', async () => ({ items: (await db.query("SELECT id,lane,summary,next_action,workstream,follow_up_at FROM tickets ORDER BY id")).rows.map((t) => ({ id: t.id, lane: t.lane, summary: t.summary, nextAction: t.next_action, workstream: t.workstream, followUpAt: t.follow_up_at })), nextCursor: null }));

// Synthetic CRM relationships and legacy Work tickets.
const names = ['Orchid Labs', 'Basalt Compute', 'Fernway Inference', 'Harbor GPU Collective', 'Quill & Anchor Analytics', 'Northfield Models', 'Tamarind Cloud', 'Vantage Edge', 'Pinewood Research', 'Aperture Foundry'];
let sequence = 9500;
for (const [i, name] of names.entries()) {
  const chatId = String(-2000 - i), companyId = randomUUID();
  await db.query('INSERT INTO companies(id,canonical_name) VALUES($1,$2)', [companyId, name]);
  await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES($1,'supergroup',$2,'included','confirmed',$3)", [chatId, `${name} · partnership`, companyId]);
  await db.query('INSERT INTO tickets(chat_id,company_id,lane,summary,next_action,workstream) VALUES($1,$2,$3,$4,$5,$6)', [chatId, companyId, ['To be started', 'Work in progress', 'Integrations', 'Blocked'][i % 4], `Synthetic summary for ${name}.`, i % 3 ? 'Send revised pricing sheet' : null, ['Buyer', 'Provider', 'Integration', 'Others'][i % 4]]);
  await db.query(`INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state,decided_message_id,decided_at) VALUES($1,0,'approved',-1001,$2,'sent',$3,now())`, [chatId, sequence, sequence + 1]); sequence += 2;
  await db.query("INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) SELECT $1,1,sender_id,now()-($2||' days')::interval,$3,sender_snapshot,peer_snapshot,forward_metadata FROM messages WHERE chat_id=-1001", [chatId, String(i + 1), `Synthetic conversation with ${name}`]);
}
await db.query("INSERT INTO chats(id,kind,title,inclusion) VALUES(-2100,'group','Unknown inbound contact','included')");
await db.query("INSERT INTO tickets(chat_id,kind,summary) VALUES(-2100,'contact_prospect','Synthetic unclassified contact')");
await outreach.reconcile();
const admin = await access.identify('ravi@antseed.com');
for (const [email, role, displayName] of accounts) if (email !== 'ravi@antseed.com') await db.query('INSERT INTO workspace_members(email,role,display_name) VALUES($1,$2,$3)', [email, role, displayName]);
await db.query("UPDATE workspace_members SET display_name='Ravi Admin' WHERE email='ravi@antseed.com'");
// Pending operational Work lane proposals and chat-intake requests (synthetic).
const evidenceFor = async (chatId: string) => (await db.query("INSERT INTO evidence(chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,1,1,'Synthetic evidence',now()) RETURNING id", [chatId])).rows[0]!.id;
for (const [i, [chatId, target, next]] of ([['-2001', 'Integrations', 'Share the integration checklist'], ['-2004', 'Work in progress', 'Start the endpoint health checks']] as const).entries()) {
  try {
    const ticket = (await db.query('SELECT id,lane FROM tickets WHERE chat_id=$1', [chatId])).rows[0]!;
    const proposal = (await db.query(`INSERT INTO proposals(ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,next_action,origin,decision)
      VALUES($1,$2,0,0,0,$3,$4,$5,'jev','pending') RETURNING id`, [ticket.id, ticket.lane, target, `Synthetic reason ${i + 1}: the latest messages suggest this lane.`, next])).rows[0]!;
    await db.query('INSERT INTO proposal_evidence(proposal_id,evidence_id) VALUES($1,$2)', [proposal.id, await evidenceFor(chatId)]);
  } catch (error) { console.log('Skipped synthetic Work proposal:', (error as Error).message); }
}
for (const [i, [id, kind, title, username]] of ([[-2201, 'group', 'Quartz Partners · intro', null], [-2202, 'supergroup', 'Lumen Grid operators', 'lumengrid'], [-2203, 'user', 'Priya from Delta Edge', 'priya_de']] as const).entries()) {
  try {
    await db.query("INSERT INTO chats(id,kind,title,username,inclusion) VALUES($1,$2,$3,$4,'undecided')", [id, kind, title, username]);
    await db.query("INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state) VALUES($1,(SELECT policy_version FROM chats WHERE id=$1),'pending',-1001,$2,'sent')", [id, 9800 + i]);
  } catch (error) { console.log('Skipped synthetic intake request:', (error as Error).message); }
}

const stageOrder = ['lead', 'lead', 'qualification', 'qualification', 'negotiation', 'won', 'archived', 'lead'] as const;
// Work evidence is inserted above, before any proposal, so source revisions stay stable.
await outreach.reconcile();
const unplaced = (await outreach.listReviewRelationships({ limit: 50 })).items.sort((x, y) => x.displayName.localeCompare(y.displayName));
for (const [i, r] of unplaced.slice(0, stageOrder.length).entries())
  await outreach.moveByHuman({ relationshipId: r.id, expectedEvidenceRevision: r.evidenceRevision, targetStage: stageOrder[i]!, idempotencyKey: `seed-${i}`, reason: 'Synthetic seed placement' }, admin, 'unplaced');
const waiting = unplaced.slice(stageOrder.length);
if (waiting[1]) await outreach.propose({ relationshipId: waiting[1].id, expectedEvidenceRevision: waiting[1].evidenceRevision, targetStage: 'qualification', idempotencyKey: 'seed-ai', reason: 'Synthetic AI suggestion: a technical call was scheduled.' }, 'openai');
const accepted = (await outreach.list({ limit: 50 })).items;
if (accepted[2]) await outreach.propose({ relationshipId: accepted[2].id, expectedEvidenceRevision: accepted[2].evidenceRevision, targetStage: 'negotiation', idempotencyKey: 'seed-ai-2', reason: 'Synthetic AI suggestion: pricing was discussed.' }, 'openai');
try { if (accepted[0]) await outreach.updateActions({ relationshipId: accepted[0].id, expectedActionsVersion: accepted[0].actionsVersion ?? 0, actions: [{ text: 'Send the revised pricing sheet', actor: 'antseed', state: 'open', precision: 'date', localDate: '2026-11-05', instant: null, timezone: 'Asia/Kolkata' }] }); }
catch (error) { console.log('Skipped synthetic data proposal:', (error as Error).message); }
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const tasks: Array<[string, string, string, string, number | null]> = [
  ['member@example.com', 'Prepare integration test plan for Basalt', 'Cover auth, retries and the rate-limit headers. https://example.com/spec', 'Work in progress', 3],
  ['member@example.com', 'Reply to Fernway about the SLA wording', '', 'To be started', -2],
  ['member@example.com', 'Draft onboarding guide', 'Short and visual.', 'To be started', null],
  ['member@example.com', 'Wait for Harbor GPU legal review', 'Blocked until their counsel replies.', 'Blocked', 9],
  ['member@example.com', 'Ship pricing page copy', '', 'Completed', -5],
  ['other@example.com', 'Update the provider onboarding checklist', 'Add the new settlement step.', 'Work in progress', 1],
  ['other@example.com', 'Verify supercalifragilisticexpialidocious-integration-endpoint-health-check-results', '', 'Integrations', 6],
  ['manager@example.com', 'Follow up with Tamarind Cloud', 'They asked for the rate card.', 'To be started', 0],
  ['manager@example.com', 'Archive stale prospects from September', '', 'Archived', null],
  ['ravi@antseed.com', 'Review workspace roles with the team', '', 'To be started', 2],
];
for (const [email, title, description, lane, offset] of tasks) {
  const owner = (await db.query('SELECT id FROM workspace_members WHERE email=$1', [email])).rows[0]!;
  await db.query('INSERT INTO personal_tasks(owner_id,title,description,lane,due_date,creation_key) VALUES($1,$2,$3,$4,$5,$6)', [owner.id, title, description, lane, offset === null ? null : day(offset), randomUUID()]);
}

await app.listen({ host: '127.0.0.1', port });
console.log(`Synthetic UI preview on http://localhost:${port}/login`);
console.log('Accounts (any password except "wrong"): ' + accounts.map(([e, r]) => `${e} (${r})`).join(', '));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await app.close(); await provider.close(); await db.close(); process.exit(0); });
