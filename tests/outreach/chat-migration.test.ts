import { afterEach, describe, expect, it } from 'vitest';
import { OutreachRepository } from '../../src/outreach/repository.js';
import { TelegramStore } from '../../src/telegram/store.js';
import { queueIntake } from '../../src/telegram/intake.js';
import type { PgDatabase } from '../../src/platform/database.js';
import { fixtureDatabase } from '../workflow/database.js';
import { fixtureMessage } from '../platform/telegram-fixture.js';
import { messageMigration, normalizeDialog } from '../../src/telegram/normalize.js';
import type { Message, Peer } from '@mtcute/node';

// Synthetic replica of the real "Krexa - Antseed" upgrade: basic group -> supergroup.
const oldId = '-5561326911', newId = '-1004205369635', title = 'Krexa - Antseed';
const migrations = ['202610250001_outreach_core.sql', '202610260001_outreach_workflow.sql', '202610260002_stable_outreach_sources.sql',
  '202610270004_operator_intake_approvals.sql', '202610280001_crm_first.sql', '202611010002_chat_migrations.sql','202611200001_initial_placement_removal.sql','202611200004_manual_crm_cards.sql']
  .map(name => new URL(`../../db/migrations/${name}`, import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const db = await fixtureDatabase(migrations); cleanup.push(() => db.close());
  const store = new TelegramStore(db as PgDatabase, { apiId: null, apiHash: null, sessionPath: ':memory:', historyBatchSize: 2, historyMaxBatches: 2 });
  const repo = new OutreachRepository(db, { now: () => new Date('2026-11-01T12:00:00Z') });
  const dialog = (id: string, extra: Record<string, string> = {}) => ({ id, kind: id === oldId ? 'group' as const : 'supergroup' as const, title, username: null, archived: false, ...extra });
  let sequence = 9400;
  /** Correlated Telegram approval, then admission: the production intake outcome. */
  async function admit(id: string) {
    sequence += 2;
    await db.query(`INSERT INTO chat_intake_requests(chat_id,policy_version,decision,control_chat_id,message_id,delivery_state,decided_message_id,decided_at)
      SELECT id,policy_version,'approved',-1001,$2,'sent',$3,now() FROM chats WHERE id=$1`, [id, sequence, sequence + 1]);
    await db.transaction(async tx => store.changeInclusion(tx, await store.lockedChat(tx, id), 'included'));
  }
  /** Predecessor with an accepted CRM stage and an active source. */
  async function acceptedPredecessor() {
    await store.upsertDialog(dialog(oldId)); await admit(oldId); await repo.reconcileChat(oldId);
    const id = String((await db.query('SELECT rs.relationship_id FROM outreach_source_threads s JOIN outreach_relationship_sources rs ON rs.source_thread_id=s.id WHERE s.chat_id=$1', [oldId])).rows[0]!.relationship_id);
    await db.query("UPDATE outreach_relationships SET accepted_stage='qualification',stage_version=1 WHERE id=$1", [id]);
    await db.query("UPDATE outreach_relationship_sources SET enrollment_state='active' WHERE relationship_id=$1", [id]);
    return id;
  }
  const enrollment = async (chatId: string) => (await db.query(`SELECT rs.relationship_id::text,rs.enrollment_state FROM outreach_source_threads s
    JOIN outreach_relationship_sources rs ON rs.source_thread_id=s.id WHERE s.chat_id=$1`, [chatId])).rows[0];
  const deals = async () => (await repo.list({})).items.filter(r => r.displayName.startsWith('Krexa'));
  const snapshot = async () => ({
    relationships: (await db.query('SELECT id,identity_key,accepted_stage,stage_version,evidence_revision,retained FROM outreach_relationships ORDER BY id')).rows,
    sources: (await db.query('SELECT source_thread_id,relationship_id,enrollment_state,version FROM outreach_relationship_sources ORDER BY source_thread_id')).rows,
    chats: (await db.query('SELECT id,inclusion,policy_version,mapping_version FROM chats ORDER BY id')).rows,
    intake: (await db.query('SELECT chat_id,decision FROM chat_intake_requests ORDER BY created_at,id')).rows,
    links: (await db.query('SELECT predecessor_chat_id,successor_chat_id FROM chat_migrations')).rows });
  return { db, store, repo, dialog, admit, acceptedPredecessor, enrollment, deals, snapshot };
}

async function expectSingleAcceptedDeal(h: Awaited<ReturnType<typeof setup>>, relationshipId: string) {
  const deals = await h.deals();
  expect(deals).toHaveLength(1);
  expect(deals[0]).toMatchObject({ id: relationshipId, acceptedStage: 'qualification', stageVersion: 1, pendingSourceCount: 0 });
  expect(await h.enrollment(newId)).toEqual({ relationship_id: relationshipId, enrollment_state: 'active' });
  expect(await h.enrollment(oldId)).toEqual({ relationship_id: relationshipId, enrollment_state: 'suspended' });
  // The predecessor is marked, never deleted.
  expect((await h.db.query('SELECT id FROM chats WHERE id=$1', [oldId])).rows).toHaveLength(1);
}

describe('Telegram basic group -> supergroup upgrade keeps one CRM deal (local SQL, synthetic chats)', () => {
  it('successor seen after the predecessor inherits approval and the accepted relationship; repeated runs are stable', async () => {
    const h = await setup(); const id = await h.acceptedPredecessor();
    // describe() of the new supergroup reports migrated_from_chat_id from full channel info.
    const successor = await h.store.upsertDialog(h.dialog(newId, { migratedFromId: oldId }));
    expect(successor.inclusion).toBe('included');
    expect((await h.db.query(`SELECT decision,decision_origin,operator_reason FROM chat_intake_requests WHERE chat_id=$1`, [newId])).rows)
      .toEqual([{ decision: 'approved', decision_origin: 'operator', operator_reason: `Telegram group upgrade: inherited approval of chat ${oldId}` }]);
    await h.repo.reconcile();
    await expectSingleAcceptedDeal(h, id);
    expect((await h.db.query('SELECT 1 FROM outreach_sales_proposals')).rows).toEqual([]);
    const settled = await h.snapshot();
    // Repeated discovery (the old group keeps reporting migratedTo) and sweeps change nothing.
    await h.store.upsertDialog(h.dialog(oldId, { migratedToId: newId }));
    await h.store.upsertDialog(h.dialog(newId, { migratedFromId: oldId }));
    await h.store.upsertDialog(h.dialog(newId));
    await h.repo.reconcile(); await h.repo.reconcileChat(oldId); await h.repo.reconcileChat(newId);
    expect(await h.snapshot()).toEqual(settled);
    await expectSingleAcceptedDeal(h, id);
  });

  it('successor seen first withdraws its pending intake when the predecessor dialog links it', async () => {
    const h = await setup(); const id = await h.acceptedPredecessor();
    // The supergroup is discovered without upgrade metadata and starts approval-first intake.
    expect((await h.store.upsertDialog(h.dialog(newId))).inclusion).toBe('undecided');
    await h.db.transaction(tx => queueIntake(tx, newId, true));
    // The next discovery sweep sees the deactivated basic group's migratedTo.
    await h.store.upsertDialog(h.dialog(oldId, { migratedToId: newId }));
    expect((await h.db.query('SELECT inclusion FROM chats WHERE id=$1', [newId])).rows[0]!.inclusion).toBe('included');
    expect((await h.db.query("SELECT decision FROM chat_intake_requests WHERE chat_id=$1 ORDER BY created_at,id", [newId])).rows.map(r => r.decision)).toEqual(['cancelled', 'approved']);
    await h.repo.reconcileChat(oldId); // predecessor first: still live until the successor joins
    expect((await h.enrollment(oldId))!.enrollment_state).toBe('active');
    await h.repo.reconcile(); await h.repo.reconcile();
    await expectSingleAcceptedDeal(h, id);
  });

  it('both chats already present as separate deals merge into the accepted one via the upgrade service message', async () => {
    const h = await setup(); const id = await h.acceptedPredecessor();
    await h.store.upsertDialog(h.dialog(newId)); await h.admit(newId); await h.repo.reconcileChat(newId);
    const duplicate = (await h.enrollment(newId))!.relationship_id;
    expect(duplicate).not.toBe(id);
    expect(await h.deals()).toHaveLength(2);
    // messageActionChannelMigrateFrom: the supergroup's first service message.
    await h.store.ingest({ type: 'message', message: { ...fixtureMessage(1, newId, ''), migratedFromId: oldId } });
    await h.repo.reconcileChat(oldId); // either order is safe
    await h.repo.reconcileChat(newId);
    await expectSingleAcceptedDeal(h, id);
    expect((await h.db.query('SELECT retained FROM outreach_relationships WHERE id=$1', [duplicate])).rows[0]!.retained).toBe(false);
    await h.repo.reconcile(); // also links the unrelated fixture chat once
    const settled = await h.snapshot();
    await h.store.ingest({ type: 'message', message: { ...fixtureMessage(1, newId, ''), migratedFromId: oldId } });
    await h.repo.reconcile(); await h.repo.reconcile();
    expect(await h.snapshot()).toEqual(settled);
  });

  it('normalizes mtcute upgrade fields to marked chat IDs (service actions carry bare IDs in 0.32.4)', () => {
    const peer = { type: 'chat', id: Number(oldId), chatType: 'group', title, username: null, migratedToId: Number(newId) } as unknown as Peer;
    expect(normalizeDialog(peer, false)).toMatchObject({ id: oldId, kind: 'group', migratedToId: newId });
    const action = (value: object) => ({ action: value }) as unknown as Message;
    expect(messageMigration(action({ type: 'chat_migrate_to', id: 4205369635 }))).toEqual({ migratedToId: newId });
    expect(messageMigration(action({ type: 'channel_migrate_from', id: 5561326911, title }))).toEqual({ migratedFromId: oldId });
    expect(messageMigration(action({ type: 'channel_migrate_from', id: Number(oldId), title }))).toEqual({ migratedFromId: oldId });
    expect(messageMigration(action({ type: 'message_pinned' }))).toEqual({});
  });
});
