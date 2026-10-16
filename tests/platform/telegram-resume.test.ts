import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SentCode, User, tl } from '@mtcute/node';
import type { TelegramClient } from '@mtcute/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../src/shared/api.js';
import { MtcuteAdapter } from '../../src/telegram/adapter.js';
import type { TelegramStore } from '../../src/telegram/store.js';

const self = new User({ _: 'user', id: 123, firstName: 'Synthetic saved account', self: true });
class Emitter { add(_handler: unknown) {} }
type Stage = 'prepare' | 'getMe' | 'discovery' | 'bind';
async function fixture(stage: Stage = 'getMe', remaining = 1, error: Error = new Error('synthetic transient outage')) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-resume-')), path = join(directory, 'client.session'); await writeFile(path, 'synthetic existing session marker');
  let owners = 0, maxOwners = 0, sentCodes = 0, bound = false, startedUpdates = 0;
  const modes: string[] = [];
  let prepareGate: Promise<void> | null = null;
  const fail = (at: Stage) => { if (at === stage && remaining > 0) { remaining--; throw error; } };
  const store = { async bindAccount() { fail('bind'); bound = true; }, async upsertDialog() {}, db: {} } as unknown as TelegramStore;
  const adapter = new MtcuteAdapter({ apiId: 1, apiHash: 'synthetic-hash', sessionPath: path, historyBatchSize: 100, historyMaxBatches: 1 }, store, (mode) => {
    expect(owners).toBe(0); modes.push(mode); let open = false;
    return {
      async prepare() { if (!open) { open = true; owners++; maxOwners = Math.max(maxOwners, owners); } if (prepareGate) await prepareGate; fail('prepare'); },
      async destroy() { if (open) { open = false; owners--; } }, async stopUpdatesLoop() {},
      async getMe() { fail('getMe'); return self; }, async *iterDialogs() { fail('discovery'); },
      async notifyLoggedIn() { expect(bound).toBe(true); expect(mode).toBe('live'); startedUpdates++; },
      async sendCode() { sentCodes++; return new SentCode({ _: 'auth.sentCode', type: { _: 'auth.sentCodeTypeApp', length: 5 }, phoneCodeHash: 'synthetic-hash', timeout: 60 }); },
      async signIn() { return self; }, onNewMessage: new Emitter(), onEditMessage: new Emitter(), onDeleteMessage: new Emitter(), onConnectionState: new Emitter(), onError: new Emitter(),
    } as unknown as TelegramClient;
  });
  return { adapter, modes, owners: () => owners, maxOwners: () => maxOwners, sentCodes: () => sentCodes, startedUpdates: () => startedUpdates,
    blockPrepare(gate: Promise<void>) { prepareGate = gate; }, async close() { await adapter.stop(); await rm(directory, { recursive: true, force: true }); } };
}

describe('saved-session automatic recovery (controlled clients; no authenticated Telegram)', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); });
  afterEach(() => { vi.useRealTimers(); });
  it.each(['prepare', 'getMe', 'discovery'] as const)('automatically retries one %s outage without overlapping SQLite owners or requesting a code', async (stage) => {
    const f = await fixture(stage);
    try {
      await f.adapter.start(); expect((await f.adapter.loginState()).state).toBe('error'); expect(f.owners()).toBe(0);
      const error = await f.adapter.loginState(); expect(error.state === 'error' && error.retryAt).toBe(new Date(Date.now() + 5_000).toISOString());
      const makes = f.modes.length; await Promise.all(Array.from({ length: 8 }, () => f.adapter.start()));
      await vi.advanceTimersByTimeAsync(4_999); expect(f.modes).toHaveLength(makes);
      await vi.advanceTimersByTimeAsync(1); expect((await f.adapter.loginState()).state).toBe('ready'); expect(f.owners()).toBe(1); expect(f.maxOwners()).toBe(1); expect(f.sentCodes()).toBe(0); expect(f.startedUpdates()).toBe(1);
    } finally { await f.close(); expect(f.owners()).toBe(0); }
  });
  it('backs repeated outages off from5seconds to capped5minutes without busy retries', async () => {
    const f = await fixture('getMe', 8);
    try {
      await f.adapter.start();
      for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
        const state = await f.adapter.loginState(); expect(state.state === 'error' && state.retryAt).toBe(new Date(Date.now() + delay).toISOString());
        const makes = f.modes.length; await vi.advanceTimersByTimeAsync(delay - 1); expect(f.modes).toHaveLength(makes); await vi.advanceTimersByTimeAsync(1);
      }
      expect((await f.adapter.loginState()).state).toBe('ready'); expect(f.maxOwners()).toBe(1); expect(f.sentCodes()).toBe(0);
    } finally { await f.close(); }
  });
  it.each([new tl.RpcError(401, 'AUTH_KEY_UNREGISTERED'), new tl.RpcError(401, 'SESSION_REVOKED'), new tl.RpcError(400, 'API_ID_INVALID'), new DomainError('conflict', 'different dataset account')])('does not retry invalid credentials/session or account mismatch: %s', async (error) => {
    const f = await fixture(error instanceof DomainError ? 'bind' : 'getMe', 1, error);
    try { await f.adapter.start(); await vi.advanceTimersByTimeAsync(3_600_000); expect(f.modes).toEqual(['auth']); expect(f.owners()).toBe(0); expect((await f.adapter.loginState()).state).toBe('error'); expect(f.startedUpdates()).toBe(0); }
    finally { await f.close(); }
  });
  it('honors native normalized flood-wait seconds, including manual attempts before retryAt', async () => {
    const f = await fixture('getMe', 1, tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_45' }));
    try {
      await f.adapter.start(); const state = await f.adapter.loginState(); expect(state).toMatchObject({ state: 'error', code: 'FLOOD_WAIT', retryAt: new Date(Date.now() + 45_000).toISOString() });
      await f.adapter.submitLogin({ step: 'phone', phone: '+1000000000' }); expect(f.sentCodes()).toBe(0);
      await vi.advanceTimersByTimeAsync(44_999); expect(f.modes).toEqual(['auth']); await vi.advanceTimersByTimeAsync(1); expect((await f.adapter.loginState()).state).toBe('ready');
    } finally { await f.close(); }
  });
  it('manual phone/code onboarding cancels the saved-session timer and retains its single auth owner', async () => {
    const f = await fixture();
    try {
      await f.adapter.start(); expect((await f.adapter.submitLogin({ step: 'phone', phone: '+1000000000' })).state).toBe('code_required');
      await vi.advanceTimersByTimeAsync(300_000); expect(f.modes).toEqual(['auth', 'auth']); expect(f.owners()).toBe(1); expect(f.sentCodes()).toBe(1);
      expect((await f.adapter.submitLogin({ step: 'code', code: 'synthetic-code' })).state).toBe('ready'); expect(f.maxOwners()).toBe(1);
    } finally { await f.close(); }
  });
  it('stop cancels a scheduled retry and closes ownership', async () => {
    const f = await fixture();
    try { await f.adapter.start(); await f.adapter.stop(); await vi.advanceTimersByTimeAsync(3_600_000); expect(f.modes).toEqual(['auth']); expect(f.owners()).toBe(0); }
    finally { await f.close(); }
  });
  it('stop fences an in-flight retry before another identity request or live owner opens', async () => {
    const f = await fixture(); let release!: () => void;
    try {
      await f.adapter.start(); f.blockPrepare(new Promise<void>((resolve) => { release = resolve; })); await vi.advanceTimersByTimeAsync(5_000);
      const stop = f.adapter.stop(); release(); await stop; await vi.advanceTimersByTimeAsync(60_000); expect(f.modes).toEqual(['auth', 'auth']); expect(f.startedUpdates()).toBe(0); expect(f.owners()).toBe(0);
    } finally { release?.(); await f.close(); }
  });
});
