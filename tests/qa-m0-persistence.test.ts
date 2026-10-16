import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dateFactSchema, updateFactSchema } from '../src/shared/schemas.js';
import type { ContactWrite, RecordsService } from '../src/shared/ports.js';

const id = (n: number) => `99000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const stamp = '2026-10-17T18:29:00Z';
let directory: string;
let db: PGlite;

const sender = { id: '990000002', kind: 'user', names: ['Synthetic Noor'], usernames: ['qa_synthetic_noor'], visiblePhones: [], visibleEmails: ['noor@cedar-relay.invalid'], observedAt: stamp };
const peer = { ...sender, id: '-1009900001', kind: 'channel', names: ['Synthetic Cedar'], usernames: [], visibleEmails: [] };
const forward = { isForwarded: true, sourceKind: 'forwarded', originPeer: null, originName: null, originDate: '2026-10-16T09:00:00Z', originMessageId: null };
const extraction = { companyCandidates: [], companies: [], contacts: [], facts: [], dates: [], summary: 'Retained synthetic extraction', substantive: true, evidenceIds: [id(3)] };
const provenance = { provider: 'openai', model: 'synthetic-model', requestId: 'qa-synthetic-request', schemaVersion: 'qa-v1', completedAt: stamp, usage: { input_tokens: 10 } };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'antseed-qa-m0-pglite-'));
  db = new PGlite(directory);
  await db.exec(await readFile(new URL('../db/migrations/001_initial.sql', import.meta.url), 'utf8'));
  await db.query('INSERT INTO companies(id,canonical_name) VALUES($1,$2)', [id(1), 'Synthetic Cedar']);
  await db.query("INSERT INTO chats(id,kind,title,inclusion,mapping_status,company_id) VALUES(-1009900001,'supergroup','Synthetic QA','included','confirmed',$1)", [id(1)]);
  await db.query('INSERT INTO tickets(id,chat_id,company_id) VALUES($1,-1009900001,$2)', [id(2), id(1)]);
  await db.query('INSERT INTO telegram_account(self_user_id) VALUES(990000001)');
  await db.query("INSERT INTO message_tombstones(chat_id,message_id,observed_at) VALUES(NULL,42,$1),(-1009900001,42,$1)", [stamp]);
  await db.query("INSERT INTO history_cursors(chat_id,next_message_id,next_date,generation) VALUES(-1009900001,500,$1,3)", [stamp]);
  await db.query('INSERT INTO live_checkpoints(chat_id,high_water_message_id,replay_required,generation) VALUES(-1009900001,900,true,7)');
  await db.query('INSERT INTO messages(chat_id,id,sender_id,sent_at,text,sender_snapshot,peer_snapshot,forward_metadata) VALUES(-1009900001,101,990000002,$1,$2,$3,$4,$5)', [stamp, 'We are live', sender, peer, forward]);
  await db.query('INSERT INTO evidence(id,chat_id,message_id,message_version,excerpt,observed_at) VALUES($1,-1009900001,101,1,$2,$3)', [id(3), 'We are live', stamp]);
  await db.query("INSERT INTO analysis_jobs(id,chat_id,policy_version,mapping_version,dedupe_key,status,extraction,extraction_provenance,extraction_input_hash,last_error) VALUES($1,-1009900001,0,0,'qa-m0-persistent','provider_unavailable',$2,$3,'qa-input-hash','provider_entitlement')", [id(4), extraction, provenance]);
  await db.query("INSERT INTO contacts(id,names,affiliation) VALUES($1,ARRAY['Synthetic Noor'],'external')", [id(5)]);
  await db.query('INSERT INTO contact_telegram_ids(telegram_user_id,contact_id) VALUES(990000002,$1)', [id(5)]);
  await db.query("INSERT INTO contact_company_roles(id,contact_id,company_id,role) VALUES($1,$2,$3,'engineering contact')", [id(6), id(5), id(1)]);
  await db.query('INSERT INTO role_evidence(role_id,evidence_id) VALUES($1,$2)', [id(6), id(3)]);
  await db.query("INSERT INTO facts(id,job_id,ticket_id,kind,text,relative_to,actor_party,actor_contact_id,state,source,local_date,date_precision) VALUES($1,$2,$3,'commitment','Send contract tomorrow',$4,'external',$5,'open','manual','2026-10-18','date')", [id(7), id(4), id(2), stamp, id(5)]);
  await db.close();
  db = new PGlite(directory); // Actual persisted migration/data reopened; no second migration.
});

afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('QA M0 actual migration with disk-backed PGlite reopen (not Docker PostgreSQL)', () => {
  it('retains singleton account, pre-message tombstones and independent checkpoints', async () => {
    expect((await db.query('SELECT self_user_id::text FROM telegram_account')).rows).toEqual([{ self_user_id: '990000001' }]);
    await expect(db.query('INSERT INTO telegram_account(self_user_id) VALUES(990000099)')).rejects.toMatchObject({ code: '23505' });
    expect((await db.query('SELECT count(*)::int AS n FROM message_tombstones WHERE message_id=42')).rows).toEqual([{ n: 2 }]);
    expect((await db.query('SELECT count(*)::int AS n FROM messages WHERE id=42')).rows).toEqual([{ n: 0 }]);
    await expect(db.query('INSERT INTO message_tombstones(chat_id,message_id,observed_at) VALUES(NULL,42,$1)', [stamp])).rejects.toMatchObject({ code: '23505' });
    expect((await db.query('SELECT h.next_message_id,h.generation AS history_generation,l.high_water_message_id,l.generation AS live_generation,l.replay_required FROM history_cursors h JOIN live_checkpoints l USING(chat_id)')).rows).toEqual([{ next_message_id: 500, history_generation: 3, high_water_message_id: 900, live_generation: 7, replay_required: true }]);
  });

  it('retains visible peer/sender data and hidden-author forwarding metadata without changing body', async () => {
    expect((await db.query('SELECT text,sender_snapshot,peer_snapshot,forward_metadata FROM messages WHERE id=101')).rows).toEqual([{ text: 'We are live', sender_snapshot: sender, peer_snapshot: peer, forward_metadata: forward }]);
  });

  it('retains extraction/provenance across close/reopen while Jev decision remains absent', async () => {
    expect((await db.query('SELECT status,extraction,extraction_provenance,extraction_input_hash,decision,jev_provenance FROM analysis_jobs WHERE id=$1', [id(4)])).rows).toEqual([{ status: 'provider_unavailable', extraction, extraction_provenance: provenance, extraction_input_hash: 'qa-input-hash', decision: null, jev_provenance: null }]);
  });

  it('retains date-only actor/manual lifecycle and sourced role links without inventing time', async () => {
    expect((await db.query('SELECT local_date::text,date_precision,resolved_at,actor_party,actor_contact_id,state,source FROM facts WHERE id=$1', [id(7)])).rows).toEqual([{ local_date: '2026-10-18', date_precision: 'date', resolved_at: null, actor_party: 'external', actor_contact_id: id(5), state: 'open', source: 'manual' }]);
    expect((await db.query('SELECT r.role,e.evidence_id FROM contact_company_roles r JOIN role_evidence e ON e.role_id=r.id WHERE r.contact_id=$1', [id(5)])).rows).toEqual([{ role: 'engineering contact', evidence_id: id(3) }]);
    await expect(db.query("UPDATE facts SET resolved_at=now() WHERE id=$1", [id(7)])).rejects.toMatchObject({ code: '23514' });
    const day = { kind: 'commitment', originalText: 'tomorrow', relativeTo: stamp, timezone: 'Asia/Kolkata', resolvedAt: null, localDate: '2026-10-18', precision: 'date', ambiguous: false, evidenceIds: [id(3)] };
    expect(dateFactSchema.safeParse(day).success).toBe(true);
    expect(dateFactSchema.safeParse({ ...day, resolvedAt: '2026-10-17T18:30:00Z' }).success).toBe(false);
    expect(updateFactSchema.safeParse({ idempotencyKey: 'qa-fact', factId: id(7), expectedVersion: 0, state: 'completed', actor: { party: 'external', contactId: id(5), displayName: 'Synthetic Noor' }, evidenceIds: [id(3)], answersFactId: null, dates: [day] }).success).toBe(true);
    // Compile-time acceptance of role creation without an already-existing contact ID.
    const write: ContactWrite = { idempotencyKey: 'qa-role', telegramUserIds: ['990000002'], names: ['Synthetic Noor'], usernames: [], phones: [], emails: [], affiliation: 'external', evidenceIds: [id(3)], roles: [{ companyId: id(1), role: 'engineering contact', evidenceIds: [id(3)] }] };
    const roleBearingRead: Pick<Awaited<ReturnType<RecordsService['getContact']>>, 'roles'> = { roles: write.roles.map((role) => ({ ...role, contactId: id(5) })) };
    expect(roleBearingRead.roles[0]?.role).toBe('engineering contact');
  });

  it('serializes two active mutation journals per ticket while allowing a completed predecessor', async () => {
    for (const n of [8, 9]) {
      await db.query("INSERT INTO proposals(id,ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,origin,decision,decided_at,apply_state) VALUES($1,$2,'To be started',0,0,0,'Integrations','Synthetic QA','manual','approved',now(),'queued')", [id(n), id(2)]);
    }
    const insert = 'INSERT INTO mutations(proposal_id,ticket_id,task_id,project_id,view_id,source_bucket_id,target_bucket_id,state) VALUES($1,$2,1,1,1,1,3,$3)';
    await db.query(insert, [id(8), id(2), 'remote_unknown']);
    await expect(db.query(insert, [id(9), id(2), 'prepared'])).rejects.toMatchObject({ code: '23505' });
    await db.query("UPDATE mutations SET state='committed' WHERE proposal_id=$1", [id(8)]);
    await db.query(insert, [id(9), id(2), 'prepared']);
    expect((await db.query('SELECT count(*)::int AS n FROM mutations')).rows).toEqual([{ n: 2 }]);
    // Direct schema writes above are not a remote apply; the ticket never moved.
    expect((await db.query('SELECT lane,stage_version FROM tickets WHERE id=$1', [id(2)])).rows).toEqual([{ lane: 'To be started', stage_version: 0 }]);
  });
});
