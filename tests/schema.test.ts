import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LANES, WORKSTREAMS } from '../src/shared/domain.js';

const db = new PGlite();
const company = '00000000-0000-4000-8000-000000000001';
const ticket = '00000000-0000-4000-8000-000000000002';
const proposal = '00000000-0000-4000-8000-000000000003';

beforeAll(async () => {
  await db.exec(await readFile(new URL('../db/migrations/001_initial.sql', import.meta.url), 'utf8'));
  await db.query('INSERT INTO companies(id,canonical_name) VALUES ($1,$2)', [company, 'Fixture Ltd']);
  await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES (-1001,'supergroup','Fixture','included','confirmed',$1)", [company]);
  await db.query('INSERT INTO tickets(id,chat_id,company_id) VALUES ($1,-1001,$2)', [ticket, company]);
});
afterAll(async () => { await db.close(); });

describe('initial migration executed by PostgreSQL (PGlite, no upstream services)', () => {
  it('seeds exact ordered lanes and independent workstreams', async () => {
    expect((await db.query<{ name: string }>('SELECT name FROM lane_definitions ORDER BY position')).rows.map((r) => r.name)).toEqual([...LANES]);
    expect((await db.query<{ name: string }>('SELECT name FROM workstream_definitions ORDER BY name')).rows.map((r) => r.name)).toEqual([...WORKSTREAMS].sort());
  });
  it('enforces one ticket per chat, real FKs and initial stage', async () => {
    expect((await db.query('SELECT lane,stage_version FROM tickets WHERE id=$1', [ticket])).rows).toEqual([{ lane: 'To be started', stage_version: 0 }]);
    await expect(db.query('INSERT INTO tickets(chat_id,company_id) VALUES(-1001,$1)', [company])).rejects.toThrow();
    await expect(db.query('INSERT INTO tickets(chat_id,company_id) VALUES(-9999,$1)', [company])).rejects.toThrow();
    await expect(db.query("UPDATE tickets SET lane='Done' WHERE id=$1", [ticket])).rejects.toThrow();
    await expect(db.query("INSERT INTO chats(id,kind,title,mapping_status) VALUES (2,'user','Bad','confirmed')")).rejects.toThrow();
    await expect(db.query("UPDATE chats SET is_control=true WHERE id=-1001")).rejects.toThrow();
  });
  it('separates human decision from remote apply and prevents duplicate journals', async () => {
    await db.query("INSERT INTO proposals(id,ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,origin) VALUES($1,$2,'To be started',0,0,0,'Integrations','Evidence of testing','jev')", [proposal, ticket]);
    expect((await db.query('SELECT decision,apply_state FROM proposals WHERE id=$1', [proposal])).rows).toEqual([{ decision: 'pending', apply_state: 'not_requested' }]);
    await expect(db.query("UPDATE proposals SET apply_state='applied',applied_at=now() WHERE id=$1", [proposal])).rejects.toThrow();
    await db.query("UPDATE proposals SET decision='approved',decided_at=now(),apply_state='queued' WHERE id=$1", [proposal]);
    const insert = 'INSERT INTO mutations(proposal_id,ticket_id,task_id,project_id,view_id,source_bucket_id,target_bucket_id) VALUES ($1,$2,1,1,1,1,3)';
    await db.query(insert, [proposal, ticket]);
    await expect(db.query(insert, [proposal, ticket])).rejects.toThrow();
    await expect(db.query("UPDATE proposals SET decision='rejected' WHERE id=$1", [proposal])).rejects.toThrow();
  });
  it('retains pre-message tombstones, account binding, independent replay and extraction checkpoints', async () => {
    await db.exec("INSERT INTO telegram_account(self_user_id) VALUES(123); INSERT INTO message_tombstones(chat_id,message_id,observed_at) VALUES(NULL,42,now()); INSERT INTO history_cursors(chat_id) VALUES(-1001); INSERT INTO live_checkpoints(chat_id) VALUES(-1001)");
    await expect(db.query('INSERT INTO telegram_account(self_user_id) VALUES(456)')).rejects.toThrow();
    await expect(db.query('INSERT INTO message_tombstones(chat_id,message_id,observed_at) VALUES(NULL,42,now())')).rejects.toThrow();
    await db.query("INSERT INTO analysis_jobs(chat_id,policy_version,mapping_version,dedupe_key,status,extraction,extraction_provenance,extraction_input_hash,last_error) VALUES(-1001,0,0,'fixture:1','provider_unavailable',$1,$2,'hash','provider_entitlement')", [{ summary: 'Saved extraction' }, { provider: 'openai', model: 'fixture' }]);
    const row = (await db.query('SELECT extraction,decision,status FROM analysis_jobs')).rows[0];
    expect(row).toEqual({ extraction: { summary: 'Saved extraction' }, decision: null, status: 'provider_unavailable' });
    expect((await db.query('SELECT high_water_message_id,replay_required FROM live_checkpoints')).rows).toEqual([{ high_water_message_id: null, replay_required: true }]);
  });
  it('keeps day precision without inventing an instant', async () => {
    const job = (await db.query<{ id: string }>('SELECT id FROM analysis_jobs')).rows[0]!.id;
    await db.query("INSERT INTO facts(job_id,kind,text,local_date,date_precision,actor_party) VALUES($1,'commitment','Send on Friday','2026-10-23','date','antseed')", [job]);
    expect((await db.query('SELECT resolved_at,actor_party FROM facts')).rows).toEqual([{ resolved_at: null, actor_party: 'antseed' }]);
    await expect(db.query("UPDATE facts SET resolved_at=now() WHERE date_precision='date'")).rejects.toThrow();
  });
  it('stores forwarding independently of identical message text', async () => {
    const body = 'We are live';
    const own = { isForwarded: false, sourceKind: 'own', originPeer: null, originName: null, originDate: null, originMessageId: null };
    const forwarded = { ...own, isForwarded: true, sourceKind: 'forwarded', originDate: '2026-10-16T00:00:00Z' };
    await db.query("INSERT INTO messages(chat_id,id,sent_at,text,forward_metadata) VALUES(-1001,101,'2026-10-17T00:00:00Z',$1,$2),(-1001,102,'2026-10-17T00:00:00Z',$1,$3)", [body, own, forwarded]);
    const rows = (await db.query<{ text: string; forward_metadata: typeof own }>('SELECT text,forward_metadata FROM messages ORDER BY id')).rows;
    expect(rows.map((r) => r.text)).toEqual([body, body]);
    expect(rows.map((r) => r.forward_metadata.isForwarded)).toEqual([false, true]);
    expect(rows[1]!.forward_metadata.originPeer).toBeNull();
  });
});
