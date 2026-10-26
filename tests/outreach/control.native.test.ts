import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PgDatabase, migrate } from '../../src/platform/database.js';
import { OutreachWorkflow } from '../../src/outreach/service.js';
import { DurableControlBus } from '../../src/telegram/control.js';
import { TelegramStore } from '../../src/telegram/store.js';
import type { TelegramPort, RuntimeConfig } from '../../src/shared/ports.js';
const file = process.env['CRM_NATIVE_CONFIG'];
describe.skipIf(!file)('real PG durable control routing with explicitly synthetic Telegram transport', () => {
    let db: PgDatabase, admin: PgDatabase, schema: string, service: OutreachWorkflow, store: TelegramStore;
    const clock = { now: () => new Date() };
    const config: RuntimeConfig['jev'] = { provider: 'openai', endpoint: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', apiKey: null, timeoutMs: 1000, maxAttempts: 1 };
    beforeEach(async () => { const c = JSON.parse(await readFile(file!, 'utf8')); admin = new PgDatabase(c.databaseUrl); schema = 'control_' + randomUUID().replaceAll('-', ''); await admin.query(`CREATE SCHEMA ${schema}`); const u = new URL(c.databaseUrl); u.searchParams.set('options', `-c search_path=${schema},public`); db = new PgDatabase(u.toString()); await migrate(db); store = new TelegramStore(db, { apiId: null, apiHash: null, sessionPath: ':memory:', historyBatchSize: 50, historyMaxBatches: 0 }); await store.bindAccount('99'); await store.upsertDialog({ id: '-1001', kind: 'supergroup', title: 'Synthetic business', username: null, archived: false }); await db.query("UPDATE chats SET inclusion='included' WHERE id=-1001"); await db.query("INSERT INTO tickets(chat_id,kind) VALUES(-1001,'contact_prospect')"); await store.upsertDialog({ id: '-1009', kind: 'supergroup', title: 'Synthetic control', username: null, archived: false }); await db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=-1009"); service = new OutreachWorkflow(db, clock, config); await service.reconcile(); });
    afterEach(async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); });
    const port = (send: TelegramPort['sendControlMessage'], history: unknown[] = []) => ({ status: async () => ({ state: 'ready' }), authorizedSelf: async () => '99', sendControlMessage: send, getHistory: async () => ({ messages: history, next: null, complete: true }) }) as unknown as TelegramPort;
    async function proposal() { const r = (await service.list({})).items[0]!; return service.propose({ relationshipId: r.id, expectedEvidenceRevision: r.evidenceRevision, targetStage: 'qualification', idempotencyKey: randomUUID(), reason: 'Synthetic sales review' }); }
    async function inbox(id: number, reply: number, text = 'approve') { await db.query("INSERT INTO control_inbox(chat_id,message_id,sender_id,reply_to_id,text,sent_at) VALUES(-1009,$1,99,$2,$3,now())", [id, reply, text]); }
    it('routes intake, work and sales receipts to one exact owner without broadcasting', async () => {
        const p = await proposal();
        await db.query("UPDATE outreach_control_outbox SET chat_id=-1009,state='sent',message_id=51 WHERE proposal_id=$1", [p.id]);
        const ticket = (await db.query('SELECT id FROM tickets LIMIT 1')).rows[0]!;
        const work = (await db.query("INSERT INTO proposals(ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,origin) VALUES($1,'To be started',0,0,0,'Work in progress','Synthetic','manual') RETURNING id", [ticket.id])).rows[0]!;
        await db.query("INSERT INTO control_outbox(proposal_id,chat_id,random_id,text,state,message_id) VALUES($1,-1009,17,'Work receipt','sent',50)", [work.id]);
        await store.upsertDialog({ id: '2001', kind: 'user', title: 'New fixture contact', username: null, archived: false });
        await db.query("UPDATE chats SET inclusion='undecided' WHERE id=2001");
        await db.query("INSERT INTO chat_intake_requests(chat_id,policy_version,control_chat_id,message_id,delivery_state) VALUES(2001,0,-1009,52,'sent')");
        const calls: string[] = [];
        const bus = new DurableControlBus(db, port(async () => ({ messageId: 99 })), store);
        bus.subscribeOwner('operational', async () => { calls.push('work'); });
        bus.subscribeOwner('outreach', async (m) => { calls.push('sales'); await service.handleControlReply(m); }, id => service.isProposalCurrent(id));
        for (const [id, reply] of [[60, 50], [61, 51], [62, 52]]) {
            await inbox(id!, reply!);
            await bus.tick();
        }
        expect(calls).toEqual(['work', 'sales']);
        expect((await db.query('SELECT inclusion FROM chats WHERE id=2001')).rows[0]!.inclusion).toBe('included');
        expect((await service.getProposal(String(p.id))).state).toBe('approved');
        expect((await db.query('SELECT state FROM control_inbox')).rows.every(r => r.state === 'done')).toBe(true);
    });
    it('retains an early sales reply until accepted-send receipt linkage is repaired; one physical send/decision', async () => { const p = await proposal(); let sent = 0; const history: any[] = []; const bus = new DurableControlBus(db, port(async (input) => { sent++; history.push({ id: 77, senderId: '99', text: input.text }); throw new Error('Synthetic accepted send / lost response'); }, history), store); bus.subscribeOwner('operational', async () => { throw Error('Wrong owner'); }); bus.subscribeOwner('outreach', m => service.handleControlReply(m), id => service.isProposalCurrent(id)); await bus.tick(); await inbox(78, 77); await db.query("UPDATE outreach_control_outbox SET lease_until=now()-interval '1 second'"); await bus.tick(); expect((await db.query('SELECT state FROM control_inbox')).rows[0]!.state).toBe('pending'); expect((await db.query('SELECT state,message_id FROM outreach_control_outbox')).rows[0]).toMatchObject({ state: 'sent', message_id: '77' }); await db.query("UPDATE control_inbox SET lease_until=now()-interval '1 second'"); await bus.tick(); await bus.tick(); expect((await service.getProposal(String(p.id))).state).toBe('approved'); expect((await db.query('SELECT * FROM outreach_sales_decisions')).rows).toHaveLength(1); expect(sent).toBe(1); });
    it('suppresses excluded source delivery and preserves business lane', async () => { const p = await proposal(); let sends = 0; const bus = new DurableControlBus(db, port(async () => { sends++; return { messageId: 77 }; }), store); bus.subscribeOwner('outreach', m => service.handleControlReply(m), id => service.isProposalCurrent(id)); await store.setInclusion({ chatId: '-1001', expectedPolicyVersion: 0, inclusion: 'excluded', idempotencyKey: randomUUID() }); await bus.tick(); expect(sends).toBe(0); expect((await db.query('SELECT state FROM outreach_control_outbox WHERE proposal_id=$1', [p.id])).rows[0]!.state).toBe('cancelled'); expect((await db.query('SELECT lane FROM tickets')).rows[0]!.lane).toBe('To be started'); });
});
