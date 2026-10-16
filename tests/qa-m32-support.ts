import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';
import { loadRuntimeConfig } from '../src/platform/config.js';
import type { Clock, RuntimeConfig, TelegramPort } from '../src/shared/ports.js';
import type { Lane } from '../src/shared/domain.js';
import { VikunjaAdapter } from '../src/vikunja/adapter.js';
import { DurableControlBus } from '../src/telegram/control.js';
import { RecordsRepository } from '../src/workflow/records.js';
import { ProposalRepository } from '../src/workflow/proposals.js';
import { SqlMutationStore } from '../src/workflow/mutations.js';
import { TicketProjector } from '../src/workflow/projection.js';
import { ProposalWorkflow } from '../src/workflow/apply.js';
import { SqlAnalysisQueue } from '../src/workflow/analysis.js';
import { company, isolatedDatabase, seed, sourceInput } from './qa-m31-support.js';

export const project = process.env['QA_M32_PROJECT'];
let configured: Promise<RuntimeConfig> | undefined;
/** Own generated service credentials only. No private AI env is read and no credential is printed. */
export function configuration(): Promise<RuntimeConfig> {
  return configured ??= (async () => {
    if (!project || !/^antseed-qa-m1-[a-z0-9-]+$/.test(project)) throw new Error('Explicit retained QA project required');
    const env = parse(execFileSync('docker', ['compose', '-p', project, '-f', 'compose.yaml', 'exec', '-T', 'backend', 'cat', '/run/antseed/runtime.env'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    const c = await loadRuntimeConfig({ ...env, AI_ENV_PATH: '/qa-m32-no-provider-file', OPENAI_API_KEY: '', AI_GATEWAY_API_KEY: '', JEV_API_KEY: '', VIKUNJA_URL: 'http://127.0.0.1:18081' });
    const r = await fetch(`${c.vikunja.baseUrl}/api/v2/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: c.vikunja.username, password: c.vikunja.password }) });
    if (r.status !== 200) throw new Error(`QA service login HTTP ${r.status}`);
    c.vikunja.apiToken = (await r.json() as { token: string }).token;
    return c;
  })();
}
export async function api(path: string, method = 'GET', body?: unknown): Promise<Record<string, any>> {
  const c = await configuration();
  const r = await fetch(`${c.vikunja.baseUrl}/api/v2${path}`, { method, headers: { authorization: `Bearer ${c.vikunja.apiToken}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!r.ok) throw new Error(`QA raw readback ${method} ${path}: HTTP ${r.status}`);
  return r.status === 204 ? {} : await r.json();
}
export function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
export function forbidden<T extends object>(): T { return new Proxy({} as T, { get(_t, key) { throw new Error(`Unexpected unrelated transport: ${String(key)}`); } }); }

export async function fixture(controlled = true) {
  const f = await isolatedDatabase(project!, true), config = await configuration();
  let now = Date.now(); const clock: Clock = { now: () => new Date(now) };
  const source = sourceInput('rel-004'); const job = await seed(f.db, source); await company(f.db, source.chat.id);
  const input = await new SqlAnalysisQueue(f.db, clock).loadInput(job);
  await f.db.query("UPDATE analysis_jobs SET status='completed'");
  const evidenceId = input.evidence[0]!.id;
  const records = new RecordsRepository(f.db, clock), ticket = await records.ensureTicket(source.chat.id);
  await f.db.query('INSERT INTO ticket_evidence VALUES($1,$2)', [ticket.id, evidenceId]);
  if (controlled) await f.db.query("INSERT INTO chats(id,kind,title,inclusion,is_control) VALUES(-990099,'supergroup','QA synthetic operational control','excluded',true)");
  let messageId = 700, sends = 0, lose = false;
  const sent: Array<{ text: string; id: number; randomId: string }> = [];
  const telegram: TelegramPort = new Proxy({} as TelegramPort, { get(_t, key) {
    if (key === 'status') return async () => ({ state: 'ready', code: null, detail: 'QA synthetic Telegram only', checkedAt: clock.now().toISOString() });
    if (key === 'authorizedSelf') return async () => '990000099';
    if (key === 'sendControlMessage') return async (i: { text: string; randomId: string }) => { sends++; const m = { text: i.text, id: ++messageId, randomId: i.randomId }; sent.push(m); if (lose) { lose = false; throw new Error('QA synthetic receipt lost after send accepted'); } return { messageId: m.id }; };
    if (key === 'getHistory') return async () => ({ messages: sent.map((m) => ({ ...source.messages[0]!, chatId: '-990099', senderId: '990000099', id: m.id, text: m.text })), next: null, complete: true });
    throw new Error(`Unexpected live Telegram operation: ${String(key)}`);
  } });
  const bus = new DurableControlBus(f.db, telegram), proposals = new ProposalRepository(f.db, bus, clock);
  const adapter = new VikunjaAdapter(config.vikunja, f.db), board = await adapter.ensureBoard();
  const mutations = new SqlMutationStore(f.db, clock), projector = new TicketProjector(f.db, adapter, records, clock);
  const service = new ProposalWorkflow(proposals, mutations, adapter, projector);
  const projected = (await projector.project(ticket.id))!;
  async function propose(lane: Lane = 'Integrations', key = randomUUID()) {
    const current = await records.getTicket(ticket.id);
    return service.propose({ idempotencyKey: key, ticketId: ticket.id, expectedStageVersion: current.stageVersion, targetLane: lane, evidenceIds: [evidenceId], reason: 'QA synthetic operational evidence', nextAction: null, origin: 'manual' });
  }
  async function approve(id: string, key = randomUUID()) { return service.decide({ idempotencyKey: key, proposalId: id, decision: 'approve' }); }
  async function reply(id: number, text: string, replyTo = sent.at(-1)!.id) {
    await f.db.query('INSERT INTO control_inbox(chat_id,message_id,sender_id,reply_to_id,text,sent_at) VALUES(-990099,$1,990000099,$2,$3,now()) ON CONFLICT DO NOTHING', [id, replyTo, text]);
  }
  return { ...f, config, clock, source, ticket, projected, evidenceId, records, bus, telegram, proposals, adapter, board, mutations, projector, service, propose, approve, reply, sent,
    advance(ms: number) { now += ms; }, sends: () => sends, loseSend() { lose = true; },
    async local() { return records.getTicket(ticket.id); },
    async remote() { return adapter.getTask(projected.vikunjaTaskId!); },
    async close() { try { await api(`/tasks/${projected.vikunjaTaskId}`, 'DELETE'); } finally { await f.close(); } },
  };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
