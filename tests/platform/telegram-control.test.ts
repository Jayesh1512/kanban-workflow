import { Long, Chat } from '@mtcute/node';
import type { TelegramClient } from '@mtcute/node';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TelegramPort } from '../../src/shared/ports.js';
import { ControlSetupManager, DurableControlBus } from '../../src/telegram/control.js';
import { fixtureMessage, telegramFixture } from './telegram-fixture.js';

describe('durable control journal with synthetic Telegram transport and real SQL engine', () => {
  let f: Awaited<ReturnType<typeof telegramFixture>>;
  beforeEach(async () => { f = await telegramFixture(); });
  afterEach(async () => { await f.db.close(); });
  const group = new Chat({ _: 'channel', id: 42, title: 'Synthetic control group', accessHash: Long.ZERO, megagroup: true, photo: { _: 'chatPhotoEmpty' }, date: 1 });
  async function configure() { await f.store.upsertDialog({ id: String(group.id), title: group.title, kind: 'supergroup', username: null, archived: true }); await f.db.query("UPDATE chats SET is_control=true,inclusion='excluded' WHERE id=$1", [String(group.id)]); }
  function fakePort(send: (input: Parameters<TelegramPort['sendControlMessage']>[0]) => Promise<{ messageId: number }>, history: () => Promise<{ messages: ReturnType<typeof fixtureMessage>[]; next: null; complete: boolean }> = async () => ({ messages: [], next: null, complete: true })) {
    return { status: async () => ({ state: 'ready' }), authorizedSelf: async () => '123', sendControlMessage: send, getHistory: history } as unknown as TelegramPort;
  }
  async function proposal() {
    await f.store.upsertDialog({ id: '-10099', title: 'Business fixture', kind: 'supergroup', username: null, archived: false });
    const company = (await f.db.query("INSERT INTO companies(canonical_name) VALUES('Synthetic company') RETURNING id")).rows[0]!['id'];
    const ticket = (await f.db.query('INSERT INTO tickets(chat_id,company_id) VALUES(-10099,$1) RETURNING id', [company])).rows[0]!['id'];
    return String((await f.db.query("INSERT INTO proposals(ticket_id,source_lane,source_stage_version,source_mapping_version,source_policy_version,target_lane,reason,origin) VALUES($1,'To be started',0,0,0,'Work in progress','Synthetic evidence','manual') RETURNING id", [ticket])).rows[0]!['id']);
  }
  it('journals an unknown creation before remote call; same and different keys cannot create duplicate groups', async () => {
    let creates = 0, marker = '';
    const client = { async createSupergroup(input: { description: string }) { creates++; marker = input.description; const row = (await f.db.query('SELECT state,request FROM control_setup_operations')).rows[0]!; expect(row['state']).toBe('remote_unknown'); expect(JSON.stringify(row['request'])).not.toMatch(/password|phoneCode|apiHash/); throw new Error('synthetic accepted then lost response'); }, async *iterDialogs() {}, async getFullChat() { return { bio: marker }; } } as unknown as TelegramClient;
    const manager = new ControlSetupManager(f.db, f.store, () => client), input = { operationKey: 'create-one', createPrivateSupergroup: true as const, title: 'Fixture approvals' };
    expect((await manager.configure(input)).state).toBe('remote_unknown'); expect((await manager.configure(input)).state).toBe('remote_unknown');
    await expect(manager.configure({ ...input, operationKey: 'another-create' })).rejects.toThrow('Reconcile'); expect(creates).toBe(1);
    client.iterDialogs = (async function* () { yield { peer: group, isArchived: true }; }) as TelegramClient['iterDialogs'];
    const result = await manager.reconcile(input.operationKey); expect(result.state).toBe('configured'); expect(result.chat?.id).toBe(String(group.id));
    expect((await f.db.query('SELECT inclusion,is_control FROM chats')).rows[0]).toMatchObject({ inclusion: 'excluded', is_control: true }); expect(creates).toBe(1);
    expect((await manager.configure(input)).state).toBe('configured'); expect(creates).toBe(1);
  });
  it('binds existing group and pauses prior business work without creating a group', async () => {
    await f.store.upsertDialog({ id: String(group.id), title: group.title, kind: 'supergroup', username: null, archived: false });
    await f.store.ingest({ type: 'message', message: fixtureMessage(1, String(group.id)) });
    const client = { async getChat() { return group; }, async getPeerDialogs() { return [{ isArchived: true }]; } } as unknown as TelegramClient;
    const manager = new ControlSetupManager(f.db, f.store, () => client);
    await manager.configure({ operationKey: 'existing', chatId: String(group.id) });
    expect((await f.db.query("SELECT * FROM analysis_jobs WHERE status='cancelled'")).rowCount).toBe(1);
    expect((await f.store.getCursor(String(group.id))).status).toBe('paused');
    await expect(f.store.setInclusion({ chatId: String(group.id), expectedPolicyVersion: 1, inclusion: 'included', idempotencyKey: 'bad-control-inclusion' })).rejects.toThrow('operational only');
  });
  it('automatically reconciles a group accepted before a create-response timeout, without a second create', async () => {
    let creates = 0, marker = '';
    const client = {
      async createSupergroup(input: { description: string }) { creates++; marker = input.description; throw new Error('Synthetic accepted create, lost response'); },
      async *iterDialogs() { yield { peer: group, isArchived: false }; },
      async getFullChat() { return { bio: marker }; },
    } as unknown as TelegramClient;
    const manager = new ControlSetupManager(f.db, f.store, () => client);
    const input = { operationKey: 'auto-recover', createPrivateSupergroup: true as const, title: group.title };
    expect(await manager.configure(input)).toMatchObject({ state: 'configured', lastError: null, chat: { id: String(group.id) } });
    expect((await manager.configure(input)).state).toBe('configured'); expect(creates).toBe(1);
    expect((await f.db.query('SELECT inclusion,is_control FROM chats WHERE id=$1', [String(group.id)])).rows[0]).toMatchObject({ inclusion: 'excluded', is_control: true });
  });
  it('retains unknown setup when automatic readback fails and recovers on a later readback', async () => {
    let creates = 0, marker = '', unavailable = true;
    const client = {
      async createSupergroup(input: { description: string }) { creates++; marker = input.description; throw new Error('Synthetic timeout'); },
      async *iterDialogs() { if (unavailable) throw new Error('Synthetic read outage'); yield { peer: group, isArchived: false }; },
      async getFullChat() { return { bio: marker }; },
    } as unknown as TelegramClient;
    const manager = new ControlSetupManager(f.db, f.store, () => client);
    const input = { operationKey: 'delayed-recover', createPrivateSupergroup: true as const, title: group.title };
    expect((await manager.configure(input)).state).toBe('remote_unknown');
    unavailable = false; expect((await manager.reconcile(input.operationKey)).state).toBe('configured'); expect(creates).toBe(1);
  });
  it('retains inbox without subscriber; awaits handler, durably finishes irrelevant replies, retries transient errors', async () => {
    await configure(); await f.store.ingest({ type: 'message', message: fixtureMessage(7, String(group.id), 'approve') });
    const bus = new DurableControlBus(f.db, fakePort(async () => ({ messageId: 10 })));
    await bus.tick(); expect((await f.db.query('SELECT state FROM control_inbox')).rows[0]!['state']).toBe('pending');
    let calls = 0; const unsubscribe = bus.subscribe(async () => { calls++; throw new Error('synthetic transient DB failure with secret'); });
    await bus.tick(); let row = (await f.db.query('SELECT * FROM control_inbox')).rows[0]!; expect(row['state']).toBe('pending'); expect(row['last_error']).not.toContain('secret'); unsubscribe();
    await f.db.query("UPDATE control_inbox SET lease_until=now()-interval '1 second'");
    bus.subscribe(async (message) => { calls++; expect(message.messageId).toBe(7); }); await bus.tick();
    row = (await f.db.query('SELECT * FROM control_inbox')).rows[0]!; expect(row['state']).toBe('done'); await bus.tick(); expect(calls).toBe(2);
  });
  it('old inbox completion cannot acknowledge a reclaimed immutable claim', async () => {
    await configure(); await f.store.ingest({ type: 'message', message: fixtureMessage(7, String(group.id)) });
    const token = randomUUID(), bus = new DurableControlBus(f.db, fakePort(async () => ({ messageId: 10 })));
    bus.subscribe(async () => { await f.db.query("UPDATE control_inbox SET claim_token=$1,lease_until=now()+interval '1 minute'", [token]); }); await bus.tick();
    expect((await f.db.query('SELECT state,claim_token FROM control_inbox')).rows[0]).toMatchObject({ state: 'running', claim_token: token });
  });
  it('preserves randomId on duplicate enqueue and reconciles accepted-send/lost-response from actual message readback', async () => {
    await configure(); const proposalId = await proposal(); let sends = 0, accepted: ReturnType<typeof fixtureMessage> | null = null;
    const bus = new DurableControlBus(f.db, fakePort(async (input) => { sends++; accepted = fixtureMessage(51, input.chatId, input.text); throw new Error('synthetic response lost'); }, async () => ({ messages: accepted ? [accepted] : [], next: null, complete: true })));
    await f.db.transaction((tx) => bus.enqueueProposal(tx, { proposalId, chatId: String(group.id), text: 'Synthetic proposal' })); const first = (await f.db.query('SELECT * FROM control_outbox')).rows[0]!;
    await f.db.transaction((tx) => bus.enqueueProposal(tx, { proposalId, chatId: String(group.id), text: 'Synthetic proposal' })); expect((await f.db.query('SELECT random_id FROM control_outbox')).rows[0]!['random_id']).toBe(first['random_id']);
    await bus.tick(); expect(sends).toBe(1); await f.db.query("UPDATE control_outbox SET lease_until=now()-interval '1 second'"); await bus.tick();
    expect(sends).toBe(1); expect((await f.db.query('SELECT state,message_id FROM control_outbox')).rows[0]).toMatchObject({ state: 'sent', message_id: 51 });
  });
  it('does not deliver a queued stale proposal after source exclusion', async () => {
    await configure(); const proposalId = await proposal(); let sends = 0;
    const bus = new DurableControlBus(f.db, fakePort(async () => { sends++; return { messageId: 1 }; })); await f.db.transaction((tx) => bus.enqueueProposal(tx, { proposalId, chatId: String(group.id), text: 'fixture' }));
    await f.store.setInclusion({ chatId: '-10099', expectedPolicyVersion: 0, inclusion: 'excluded', idempotencyKey: 'exclude-source' }); await bus.tick(); expect(sends).toBe(0);
  });
});
