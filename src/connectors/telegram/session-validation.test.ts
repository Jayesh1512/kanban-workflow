import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../../contracts/index.ts';
import { testContext } from '../test-support.ts';
import { createTelegramFactory } from './connector.ts';
import { RecordedApi } from './recorded-api.ts';
import { sessionPrefix } from './session-state.ts';
import { login, recording } from './test-session.ts';

const key = '20:1800000000:63397ed9112a18f9';
const tagged = (keys: unknown = [], sdkSession: unknown = 'synthetic-opaque') =>
  sessionPrefix + JSON.stringify({ v: 1, sdkSession, keys });

test('C1-F1 corrupt tagged sessions fail with fixed safe invalid error before import/getMe/SDK decode', async () => {
  const invalid = [
    `${sessionPrefix}{`,
    tagged([], ''),
    tagged([], null),
    tagged({}),
    sessionPrefix + JSON.stringify({ v: 2, sdkSession: 'synthetic', keys: [] }),
    sessionPrefix + JSON.stringify({ v: 1, sdkSession: 'synthetic', keys: [], extra: 1 }),
    `${sessionPrefix}{"v":1,"v":1,"sdkSession":"synthetic","keys":[]}`,
    `${sessionPrefix}{"sdkSession":"synthetic","v":1,"keys":[]}`,
    `${sessionPrefix}{ "v":1,"sdkSession":"synthetic","keys":[]}`,
    `${sessionPrefix}{"v":1,"sdkSession":"synthetic","keys":[]}\n`,
    tagged([
      ['u:1', key],
      ['u:1', key],
    ]),
    tagged([
      ['u:2', key],
      ['u:1', key],
    ]),
    tagged([['u:1', key, 'extra']]),
    tagged([['u:1', 1]]),
    tagged([['c20:1', key]]),
    ...['01', '-0', 'NaN', 'Infinity', '1.0', '1e3', '', ' 1', '1:2'].map((id) => tagged([[`u:${id}`, key]])),
    ...[
      '020:1800000000:63397ed9112a18f9',
      '20:1800000000.0:63397ed9112a18f9',
      '20:1800000000:63397ED9112A18F9',
      '20:1800000000:63397ed9112a18f',
      '20:NaN:63397ed9112a18f9',
    ].map((k) => tagged([['u:1', k]])),
    `${sessionPrefix}{"v":1,"sdkSession":"synthetic","keys":[["u:\\u0031","20:1800000000:63397ed9112a18f9"]]}`,
  ];
  for (const saved of invalid) {
    const state = testContext(saved);
    const api = new RecordedApi({ session: recording(1) }, state.ctx.now);
    const connector = createTelegramFactory(() => api).create(state.ctx);
    const safe = (e: unknown) =>
      e instanceof AppError && e.code === 'invalid' && e.message === 'Invalid saved connector session';
    await assert.rejects(connector.start(state.sink), safe);
    await assert.rejects(connector.listChats(), safe);
    assert.deepEqual(api.calls, []);
    assert.deepEqual(state.events, []);
    assert.deepEqual(state.saved, []);
    assert.deepEqual(state.logs, []);
  }
});

test('C1-F1 opaque inner string is preserved exactly; legacy nonprefix import is unchanged with zero prior keys', async () => {
  for (const legacy of [false, true]) {
    const opaque = 'synthetic-opaque\n"\\\u0000☃';
    const state = testContext(legacy ? opaque : tagged([], opaque));
    const api = new RecordedApi({ session: recording(0) }, state.ctx.now);
    const imports: string[] = [];
    api.importSession = async (value) => {
      imports.push(value);
    };
    api.getMe = async () => ({ id: 10, displayName: 'Owner', username: 'owner' });
    api.exportSession = async () => opaque;
    api.startUpdates = async (h) => {
      h.onState('connected');
    };
    const connector = createTelegramFactory(() => api).create(state.ctx);
    await connector.start(state.sink);
    await connector.stop();
    assert.deepEqual(imports, [opaque, opaque]);
    assert.equal(state.saved.at(-1), tagged([], opaque));
    assert.equal(state.logs.length, legacy ? 1 : 0);
    assert.ok(!JSON.stringify(state.logs).includes(opaque));
  }
  const state = testContext(null);
  const api = new RecordedApi({ session: recording(1) }, state.ctx.now);
  const connector = createTelegramFactory(() => api).create(state.ctx);
  await assert.rejects(connector.listChats(), /Login required/);
  await login(connector);
  await connector.logout();
  assert.equal(state.saved.at(-1), null);
  await login(connector);
  assert.equal(state.saved.at(-1), tagged([], JSON.stringify({ v: 1, selfId: 10 })));
});
