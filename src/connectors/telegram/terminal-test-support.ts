import assert from 'node:assert/strict';
import type { ConnectorContext } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createTelegramFactory } from './connector.ts';
import { RecordedApi } from './recorded-api.ts';
import { sessionPrefix } from './session-state.ts';
import { recording } from './test-session.ts';

export function gate<T = void>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function flush() {
  for (let n = 0; n < 100; n++) await Promise.resolve();
}
export function terminalHarness(saved: string | null | 'canonical' = 'canonical') {
  const source = recording(8);
  const opaque = JSON.stringify({ v: 1, selfId: source.self.id });
  const state = testContext(
    saved === 'canonical' ? sessionPrefix + JSON.stringify({ v: 1, sdkSession: opaque, keys: [] }) : saved,
  );
  let time = 0;
  const waits: { end: number; ms: number; resolve(): void }[] = [];
  state.ctx.now = () => new Date(time);
  state.ctx.sleep = (ms) => new Promise<void>((resolve) => waits.push({ end: time + ms, ms, resolve }));
  const api = new RecordedApi({ session: source }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  return {
    ...state,
    source,
    opaque,
    api,
    connector,
    waits,
    advance(ms: number) {
      time += ms;
      for (const wait of waits) if (wait.end <= time) wait.resolve();
    },
    useSave(fn: ConnectorContext['saveSession']) {
      state.ctx.saveSession = fn;
    },
  };
}
export async function credentials(connector: ReturnType<typeof terminalHarness>['connector']) {
  assert.equal((await connector.login(null)).kind, 'need_input');
  await connector.login({ phone: '+10000000000' });
  assert.equal((await connector.login({ code: '12345' })).kind, 'done');
}
export const safePersistence = /Connector session persistence failed/;
export const safeTimeout = /Connector logout timed out\/cancelled/;
