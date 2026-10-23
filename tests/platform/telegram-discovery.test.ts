import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Long, User, tl } from '@mtcute/node';
import type { TelegramClient } from '@mtcute/node';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MtcuteAdapter } from '../../src/telegram/adapter.js';
import type { TelegramStore } from '../../src/telegram/store.js';

const self = new User({ _: 'user', id: 123, firstName: 'Synthetic account', self: true });
class Emitter { add(_handler: unknown) {} }
async function fixture(options: { total: number; floodAt?: number; pinned?: boolean; pinnedCount?:number; batchSize?:number; storeFailureAt?: number }) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-discovery-'));
  const stored: number[] = [], calls: Array<{ offsetId?: number; limit?: number; pinned?: string; archived?: string }> = [];
  let failed = false, owners = 0, maxOwners = 0, notified = 0;
  const store = { async bindAccount() {}, async upsertDialog(d: { id: string }) { const id = Number(d.id); if (options.storeFailureAt === id && !failed) { failed = true; throw Error('Synthetic database interruption'); } stored.push(id); }, db: {} } as unknown as TelegramStore;
  const adapter = new MtcuteAdapter({ apiId: 1, apiHash: 'synthetic', sessionPath: join(directory, 'client.session'), historyBatchSize: 100, historyMaxBatches: 1, ...(options.batchSize?{discoveryBatchSize:options.batchSize}:{}) }, store, () => {
    expect(owners).toBe(0); let open = false;
    return {
      async prepare() { if (!open) { open = true; owners++; maxOwners = Math.max(maxOwners, owners); } }, async destroy() { if (open) { open = false; owners--; } }, async stopUpdatesLoop() {},
      async sendCode() { return self; }, async getMe() { return self; }, async notifyLoggedIn() { notified++; },
      async *iterDialogs(params: { offsetId?: number; limit?: number; pinned?: string; archived?: string }) {
        calls.push(params); let count = 0;
        if (options.pinned && params.pinned !== 'exclude') for(let i=0;i<(options.pinnedCount??1)&&count<(params.limit??Infinity);i++){ count++; yield { peer: new User({ _: 'user', id: 9999+i, accessHash: Long.ZERO, firstName: 'Pinned fixture' }), isArchived: true, isPinned: true, raw: { topMessage: 9999+i }, lastMessage: { raw: { date: 1 } } }; }
        for (let id = (params.offsetId ?? 0) + 1; id <= options.total && count < (params.limit ?? Infinity); id++, count++) {
          if (options.floodAt === id && !failed) { failed = true; throw tl.RpcError.fromTl({ errorCode: 420, errorMessage: 'FLOOD_WAIT_45' }); }
          yield { peer: new User({ _: 'user', id, accessHash: Long.ZERO, firstName: 'Synthetic chat' }), isArchived: id % 2 === 0, isPinned: false, raw: { topMessage: id }, lastMessage: { raw: { date: 100000 - id } } };
        }
      },
      onNewMessage: new Emitter(), onEditMessage: new Emitter(), onDeleteMessage: new Emitter(), onConnectionState: new Emitter(), onError: new Emitter(),
    } as unknown as TelegramClient;
  });
  return { adapter, stored, calls, owners: () => owners, maxOwners: () => maxOwners, notified: () => notified,
    async discover() { for await (const d of adapter.discoverDialogs()) await store.upsertDialog(d); },
    async close() { await adapter.stop(); await rm(directory, { recursive: true, force: true }); } };
}
beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());
it('connects after a bounded batch and eventually discovers every pinned/archived chat without rescanning the head', async () => {
  const f = await fixture({ total: 1100, pinned: true });
  try {
    expect((await f.adapter.submitLogin({ step: 'phone', phone: '+1000000000' })).state).toBe('ready');
    expect(f.stored).toHaveLength(500); expect(f.notified()).toBe(1);
    await f.discover(); expect(f.stored).toHaveLength(1000); await f.discover();
    expect(new Set(f.stored).size).toBe(1101); expect(f.stored.filter(id => id === 9999)).toHaveLength(1);
    expect(f.calls.map(c => c.offsetId ?? 0)).toEqual([0, 499, 999]); expect(f.calls.every(c => c.archived === 'keep' && c.limit === 500)).toBe(true);
    await f.discover(); expect(f.calls.at(-1)?.offsetId).toBeUndefined(); expect(f.maxOwners()).toBe(1);
  } finally { await f.close(); }
});
it('resumes discovery past the last durable dialog after FLOOD_WAIT instead of repeating the first page', async () => {
  const f = await fixture({ total: 600, floodAt: 201 });
  try {
    expect(await f.adapter.submitLogin({ step: 'phone', phone: '+1000000000' })).toMatchObject({ state: 'error', code: 'FLOOD_WAIT' }); expect(f.stored).toHaveLength(200); expect(f.owners()).toBe(0);
    await vi.advanceTimersByTimeAsync(44_999); expect(f.calls).toHaveLength(1); await vi.advanceTimersByTimeAsync(1);
    expect((await f.adapter.loginState()).state).toBe('ready'); expect(f.calls.map(c => c.offsetId ?? 0)).toEqual([0, 200]);
    expect(f.stored).toHaveLength(600); expect(new Set(f.stored).size).toBe(600); expect(f.maxOwners()).toBe(1); expect(f.notified()).toBe(1);
  } finally { await f.close(); }
});
it('does not checkpoint a dialog whose durable store failed before consumer acknowledgement', async () => {
  const f = await fixture({ total: 250, storeFailureAt: 200 });
  try {
    expect((await f.adapter.submitLogin({ step: 'phone', phone: '+1000000000' })).state).toBe('error'); expect(f.stored).toHaveLength(199);
    await vi.advanceTimersByTimeAsync(5000); expect((await f.adapter.loginState()).state).toBe('ready');
    expect(f.calls.map(c => c.offsetId ?? 0)).toEqual([0, 199]); expect(f.stored).toHaveLength(250); expect(f.stored).toContain(200);
  } finally { await f.close(); }
});

it('uses a small remote-database batch without losing or endlessly repeating a pinned-only first page',async()=>{
 const f=await fixture({total:4,pinned:true,pinnedCount:5,batchSize:2});
 try{expect((await f.adapter.submitLogin({step:'phone',phone:'+1000000000'})).state).toBe('ready');expect(f.stored).toHaveLength(2);expect(f.notified()).toBe(1);
 for(let i=0;i<4;i++)await f.discover();expect(f.stored).toHaveLength(9);expect(new Set(f.stored).size).toBe(9);expect(f.calls.map(c=>c.limit)).toEqual([2,4,6,2,2]);
 }finally{await f.close();}
});
it('retries an unacknowledged pinned dialog when small-batch discovery is interrupted',async()=>{
 const f=await fixture({total:2,pinned:true,pinnedCount:3,batchSize:2,storeFailureAt:10000});
 try{expect((await f.adapter.submitLogin({step:'phone',phone:'+1000000000'})).state).toBe('error');expect(f.stored).toEqual([9999]);
 await vi.advanceTimersByTimeAsync(5000);expect((await f.adapter.loginState()).state).toBe('ready');await f.discover();await f.discover();expect(new Set(f.stored).size).toBe(5);expect(f.stored.filter(x=>x===10000)).toHaveLength(1);expect(f.maxOwners()).toBe(1);
 }finally{await f.close();}
});
