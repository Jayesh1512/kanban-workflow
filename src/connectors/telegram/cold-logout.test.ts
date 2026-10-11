import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AppError } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createTelegramFactory } from './connector.ts';
import { RecordedApi } from './recorded-api.ts';
import { sessionPrefix } from './session-state.ts';
import { recording } from './test-session.ts';

class StrictRecordedApi extends RecordedApi {
  private auth = false;
  override async importSession(value: string) {
    await super.importSession(value);
    this.auth = true;
  }
  override async logOut() {
    assert.equal(this.auth, true, 'authenticated import must precede logout RPC');
    await super.logOut();
    this.auth = false;
  }
  override async destroy() {
    this.auth = false;
    await super.destroy();
  }
}

for (const canonical of [false, true]) {
  test(`Cold file-backed ${canonical ? 'canonical' : 'legacy'} authority authenticates before logout`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c1-cold-'));
    try {
      const source = recording(1);
      const raw = JSON.stringify({ v: 1, selfId: source.self.id });
      const saved = canonical ? sessionPrefix + JSON.stringify({ v: 1, sdkSession: raw, keys: [] }) : raw;
      const path = join(dir, 'session');
      writeFileSync(path, saved);
      const state = testContext(readFileSync(path, 'utf8'));
      state.ctx.saveSession = (value) => {
        state.saved.push(value);
        writeFileSync(path, JSON.stringify(value));
      };
      const api = new StrictRecordedApi({ session: source }, state.ctx.now);
      const connector = createTelegramFactory(() => api).create(state.ctx);
      await connector.logout();
      assert.deepEqual(
        api.calls.map((c) => c.op),
        ['importSession', 'logOut', 'destroy'],
      );
      assert.deepEqual(state.saved, [null]);
      assert.equal(JSON.parse(readFileSync(path, 'utf8')), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('Cold null performs local cleanup without an unauthenticated RPC', async () => {
  const state = testContext();
  const api = new StrictRecordedApi({ session: recording(1) }, state.ctx.now);
  await createTelegramFactory(() => api)
    .create(state.ctx)
    .logout();
  assert.deepEqual(
    api.calls.map((c) => c.op),
    ['destroy'],
  );
  assert.deepEqual(state.saved, [null]);
});

test('Cold malformed reserved authority fails exactly, cleans locally and never imports', async () => {
  const state = testContext(`${sessionPrefix}{"v":2}`);
  const api = new RecordedApi({ session: recording(1) }, state.ctx.now);
  await assert.rejects(
    createTelegramFactory(() => api)
      .create(state.ctx)
      .logout(),
    (e) => e instanceof AppError && e.code === 'invalid' && e.message === 'Invalid saved connector session',
  );
  assert.deepEqual(
    api.calls.map((c) => c.op),
    ['destroy'],
  );
  assert.deepEqual(state.saved, [null]);
});
