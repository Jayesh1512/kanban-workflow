import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chat, Long, SentCode, User, tl } from '@mtcute/node';
import type { Message as NativeMessage, TelegramClient } from '@mtcute/node';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/shared/api.js';
import { MtcuteAdapter } from '../../src/telegram/adapter.js';
import { AwaitedQueue } from '../../src/telegram/queue.js';
import { decimalId, normalizeMessage, peerNumber } from '../../src/telegram/normalize.js';
import type { TelegramStore } from '../../src/telegram/store.js';
import type { TelegramEvent } from '../../src/shared/ports.js';

class Emitter<T> { listeners: Array<(v: T) => void> = []; add(fn: (v: T) => void) { this.listeners.push(fn); } emit(v: T) { for (const fn of this.listeners) fn(v); } }
const user = new User({ _: 'user', id: 123, firstName: 'Synthetic', lastName: 'Tester', username: 'fixture', self: true });
const group = new Chat({ _: 'channel', id: 42, title: 'Fixture group', accessHash: Long.ZERO, megagroup: true, photo: { _: 'chatPhotoEmpty' }, date: 1 });
const nativeMessage = (forward: unknown = null) => ({ id: 1, chat: group, sender: user, date: new Date('2026-10-17T00:00:00Z'), editDate: null, text: 'The integration is complete', replyToMessage: null, forward, get link() { throw new Error('No link'); } }) as unknown as NativeMessage;

describe('deterministic mtcute transport seam (not authenticated Telegram)', () => {
  async function fixture(existing = false, mismatch = false) {
    const dir = await mkdtemp(join(tmpdir(), 'antseed-auth-')), path = join(dir, 'client.session');
    if (existing) await writeFile(path, 'synthetic session marker');
    const log: string[] = [], events: TelegramEvent[] = [], modes: string[] = [];
    let bound = false, owners = 0;
    const store = { async bindAccount() { log.push('bind'); if (mismatch) throw new DomainError('conflict', 'different dataset account'); bound = true; }, async upsertDialog() { expect(bound).toBe(true); log.push('dialog'); }, db: { async query() { return { rowCount: 1, rows: [] }; } } } as unknown as TelegramStore;
    const adapter = new MtcuteAdapter({ apiId: 1, apiHash: 'synthetic-api-hash', sessionPath: path, historyBatchSize: 100, historyMaxBatches: 2 }, store, (mode) => {
      modes.push(mode); if (mode === 'live') expect(owners).toBe(0);
      let prepared = false;
      const client = {
        onNewMessage: new Emitter<NativeMessage>(), onEditMessage: new Emitter<NativeMessage>(), onDeleteMessage: new Emitter<never>(), onConnectionState: new Emitter<string>(), onError: new Emitter<Error>(),
        async prepare() { if (!prepared) { prepared = true; owners++; } }, async destroy() { if (prepared) { prepared = false; owners--; } log.push(`${mode}-closed`); }, async stopUpdatesLoop() {},
        async getMe() { return user; },
        async sendCode() { return new SentCode({ _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp', length: 5 }, phoneCodeHash: 'private-code-hash', timeout: 60 }); },
        async signIn(input: { phoneCode: string }) { if (input.phoneCode === '22222') throw new tl.RpcError(401, 'SESSION_PASSWORD_NEEDED'); if (input.phoneCode !== '11111') throw new tl.RpcError(400, 'PHONE_CODE_INVALID'); return user; },
        async checkPassword(input: { password: string }) { if (input.password !== 'synthetic-right') throw new tl.RpcError(400, 'PASSWORD_HASH_INVALID'); return user; },
        async *iterDialogs() { expect(bound).toBe(true); yield { peer: group, isArchived: true }; },
        async notifyLoggedIn() { expect(bound).toBe(true); expect(mode).toBe('live'); log.push('updates-started'); client.onNewMessage.emit(nativeMessage()); return user.raw; },
      };
      return client as unknown as TelegramClient;
    });
    adapter.subscribe(async (event) => { expect(bound).toBe(true); events.push(event); });
    return { adapter, log, events, modes, owners: () => owners, cleanup: async () => { await adapter.stop(); await rm(dir, { recursive: true, force: true }); } };
  }
  it('performs explicit phone/code login; binds before updates; closes auth owner before live owner', async () => {
    const f = await fixture();
    try {
      await f.adapter.start(); expect(f.modes).toEqual([]);
      const state = await f.adapter.submitLogin({ step: 'phone', phone: '+10000000000' });
      expect(state.state).toBe('code_required'); expect(JSON.stringify(state)).not.toContain('private-code-hash'); expect(JSON.stringify(state)).not.toContain('+10000000000');
      expect((await f.adapter.submitLogin({ step: 'code', code: '11111' })).state).toBe('ready');
      await new Promise((r) => setTimeout(r, 20));
      expect(f.log.indexOf('bind')).toBeLessThan(f.log.indexOf('updates-started'));
      expect(f.modes).toEqual(['auth', 'live']); expect(f.owners()).toBe(1); expect(f.events.some((e) => e.type === 'message')).toBe(true);
    } finally { await f.cleanup(); expect(f.owners()).toBe(0); }
  });
  it('requires 2FA explicitly and permits corrected password without another code', async () => {
    const f = await fixture();
    try {
      await f.adapter.start(); await f.adapter.submitLogin({ step: 'phone', phone: '+10000000000' });
      expect((await f.adapter.submitLogin({ step: 'code', code: '22222' })).state).toBe('password_required');
      expect((await f.adapter.submitLogin({ step: 'password', password: 'bad-secret' })).state).toBe('error');
      expect(JSON.stringify(await f.adapter.loginState())).not.toContain('bad-secret');
      expect((await f.adapter.submitLogin({ step: 'password', password: 'synthetic-right' })).state).toBe('ready');
    } finally { await f.cleanup(); }
  });
  it('resumes existing session through auth-only client before opening live catch-up', async () => {
    const f = await fixture(true);
    try { await f.adapter.start(); expect((await f.adapter.loginState()).state).toBe('ready'); expect(f.modes).toEqual(['auth', 'live']); expect(f.log.indexOf('bind')).toBeLessThan(f.log.indexOf('auth-closed')); }
    finally { await f.cleanup(); }
  });
  it.each([false, true])('account mismatch never opens or dispatches a live owner (resume=%s)', async (resume) => {
    const f = await fixture(resume, true);
    try {
      await f.adapter.start();
      if (!resume) { await f.adapter.submitLogin({ step: 'phone', phone: '+10000000000' }); await f.adapter.submitLogin({ step: 'code', code: '11111' }); }
      expect((await f.adapter.loginState()).state).toBe('error'); expect(f.modes).toEqual(['auth']); expect(f.events).toEqual([]); expect(f.owners()).toBe(0);
    } finally { await f.cleanup(); }
  });
  it('retains same-text forward provenance and anonymous origin without fabricating a DM link', () => {
    const own = normalizeMessage(nativeMessage());
    const forwarded = normalizeMessage(nativeMessage({ sender: { type: 'anonymous', displayName: 'Hidden original author' }, date: new Date('2026-10-16T00:00:00Z'), fromMessageId: null }));
    expect(own.text).toBe(forwarded.text); expect(own.forward.sourceKind).toBe('own'); expect(forwarded.forward.sourceKind).toBe('forwarded');
    expect(forwarded.forward.originPeer).toBeNull(); expect(forwarded.forward.originName).toBe('Hidden original author'); expect(forwarded.sourceUrl).toBeNull();
    expect(own.sender.kind).toBe('user'); expect(own.peer.kind).toBe('channel');
    expect(() => peerNumber('9007199254740993')).toThrow('safe integer'); expect(() => decimalId(Number.MAX_SAFE_INTEGER + 1)).toThrow('Unsafe');
  });
});

describe('bounded awaited update queue', () => {
  it('awaits persistence, signals overflow and retains ordered work within capacity', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }), completed: number[] = []; let gaps = 0;
    const queue = new AwaitedQueue<number>(async (n) => { if (n === 1) await gate; completed.push(n); }, async () => { gaps++; }, 2);
    queue.push(1); queue.push(2); queue.push(3);
    expect(queue.size).toBe(2); expect(completed).toEqual([]); release();
    expect(await queue.flush()).toBe(true); expect(completed).toEqual([1, 2]); expect(gaps).toBe(1); await queue.close();
  });
  it('retries failed durable sink with replay signaling instead of an unhandled async callback', async () => {
    let attempts = 0, gaps = 0; const complete: number[] = [];
    const queue = new AwaitedQueue<number>(async (n) => { if (++attempts === 1) throw new Error('synthetic database outage'); complete.push(n); }, async () => { gaps++; });
    queue.push(1); expect(await queue.flush(3_000)).toBe(true); expect(attempts).toBe(2); expect(complete).toEqual([1]); expect(gaps).toBe(1); await queue.close();
  });
});
