import assert from 'node:assert/strict';
import type { TelegramApi } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createTelegramFactory } from './connector.ts';
import { RecordedApi } from './recorded-api.ts';
import { readSession } from './session-state.ts';
import { recording } from './test-session.ts';

export function sessionHarness(count = 4, saved: string | null = null) {
  const state = testContext(saved);
  const source = recording(count);
  const api = new RecordedApi({ session: source }, state.ctx.now);
  let handlers: Parameters<TelegramApi['startUpdates']>[0] | null = null;
  const start = api.startUpdates.bind(api);
  api.startUpdates = async (h) => {
    handlers = h;
    await start(h);
  };
  const connector = createTelegramFactory(() => api).create(state.ctx);
  return {
    ...state,
    source,
    api,
    connector,
    handlers() {
      assert.ok(handlers);
      return handlers;
    },
  };
}
export function retained(saved: string | null | undefined) {
  assert.equal(typeof saved, 'string');
  return readSession(saved as string).keys;
}
export function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
