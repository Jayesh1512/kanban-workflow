import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { JevPort } from '../../src/shared/ports.js';
import { loadRuntimeConfig } from '../../src/platform/config.js';
import { JEV_BREAKER_KEY, JEV_INITIALIZED_KEY, resetJevBreaker, seedKnownJevRestriction, withDurableJevBreaker } from '../../src/workflow/breaker.js';
import { inputFixture, extractionFixture } from '../intelligence/fixtures.js';
import { fixtureDatabase } from './database.js';
import { schedulingDatabase } from './locking-fixture.js';
import { SqlAnalysisQueue } from '../../src/workflow/analysis.js';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });
async function setup() {
  const { db } = schedulingDatabase(await fixtureDatabase()); cleanups.push(() => db.close());
  const dir = await mkdtemp(join(tmpdir(), 'antseed-breaker-')); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'ai.env'); await writeFile(path, 'AI_GATEWAY_API_KEY=synthetic-test-only\n');
  const config = await loadRuntimeConfig({ AI_ENV_PATH: path }); const clock = { now: () => new Date('2026-10-17T00:00:00Z') }; let calls = 0;
  const provider: JevPort = { async status() { return { state: 'ready', code: null, detail: 'Synthetic stub', checkedAt: clock.now().toISOString() }; }, async decide() { calls++; return { ok: false, code: 'entitlement', retryable: false, retryAt: null, detail: 'Sanitized synthetic 403' }; } };
  return { db, dir, path, config, clock, provider, calls: () => calls, input: { ...inputFixture(), extraction: extractionFixture() } };
}
it('one entitlement failure pauses concurrent/new jobs and survives reconstructed services', async () => {
  const h = await setup(); const first = withDurableJevBreaker(h.db, h.provider, h.config, h.clock);
  const results = await Promise.all([first.decide(h.input), first.decide(h.input)]); expect(results.every((r) => !r.ok && r.code === 'entitlement')).toBe(true); expect(h.calls()).toBe(1);
  const restarted = withDurableJevBreaker(h.db, h.provider, h.config, h.clock); await restarted.decide(h.input); expect(h.calls()).toBe(1);
  expect(await restarted.status()).toMatchObject({ state: 'unavailable', code: 'provider_entitlement' });
});
it('a file touch, remount path, unrelated OpenAI edit or credential-only revision cannot release a pause', async () => {
  const h = await setup(); const first = withDurableJevBreaker(h.db, h.provider, h.config, h.clock); await first.decide(h.input);
  await writeFile(h.path, 'AI_GATEWAY_API_KEY=synthetic-replaced-key\nOPENAI_MODEL=unrelated-edit\n'); await utimes(h.path, new Date(), new Date());
  const changed = await loadRuntimeConfig({ AI_ENV_PATH: h.path }); changed.aiEnvPath = join(h.dir, 'different-mount');
  await withDurableJevBreaker(h.db, h.provider, changed, h.clock).decide(h.input); expect(h.calls()).toBe(1);
  const state = JSON.stringify((await h.db.query('SELECT value FROM app_settings WHERE key=$1', [JEV_BREAKER_KEY])).rows[0]!.value); expect(state).not.toContain('synthetic'); expect(state).not.toContain(h.path);
});
it('known observed restriction initializes once; explicit replay clears it and is never reseeded', async () => {
  const h = await setup(); await seedKnownJevRestriction(h.db, h.config, h.clock); await seedKnownJevRestriction(h.db, h.config, h.clock);
  await withDurableJevBreaker(h.db, h.provider, h.config, h.clock).decide(h.input); expect(h.calls()).toBe(0);
  const queue = new SqlAnalysisQueue(h.db, h.clock, 'Asia/Kolkata', { onReplay: resetJevBreaker });
  await queue.replayUnavailable({ idempotencyKey: 'explicit-recovery' });
  await seedKnownJevRestriction(h.db, h.config, h.clock); expect((await h.db.query('SELECT key FROM app_settings WHERE key=$1', [JEV_BREAKER_KEY])).rows).toHaveLength(0);
  expect((await h.db.query('SELECT key FROM app_settings WHERE key=$1', [JEV_INITIALIZED_KEY])).rows).toHaveLength(1);
  await withDurableJevBreaker(h.db, h.provider, h.config, h.clock).decide(h.input); expect(h.calls()).toBe(1);
});
it('deliberate nonsecret endpoint/model change releases an old configuration pause', async () => {
  const h = await setup(); await withDurableJevBreaker(h.db, h.provider, h.config, h.clock).decide(h.input);
  const changed = { ...h.config, jev: { ...h.config.jev, model: 'deliberate-different-model' } };
  await withDurableJevBreaker(h.db, h.provider, changed, h.clock).decide(h.input); expect(h.calls()).toBe(2);
});
it('selecting native OpenAI decisions does not inherit or seed the known Vercel credit restriction', async () => {
  const h = await setup(); await seedKnownJevRestriction(h.db, h.config, h.clock);
  const config = { ...h.config, jev: { ...h.config.jev, provider: 'openai' as const, endpoint: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna' } };
  await seedKnownJevRestriction(h.db, config, h.clock);
  const adapter = withDurableJevBreaker(h.db, h.provider, config, h.clock);
  await adapter.decide(h.input); expect(h.calls()).toBe(1);
  await adapter.decide(h.input); expect(h.calls()).toBe(1);
  expect(await adapter.status()).toMatchObject({ state: 'unavailable', code: 'provider_entitlement' });
});
it('unexpected dispatch crash retains a conservative durable pause', async () => {
  const h = await setup(); const broken: JevPort = { ...h.provider, async decide() { throw new Error('Synthetic process interruption'); } };
  await expect(withDurableJevBreaker(h.db, broken, h.config, h.clock).decide(h.input)).rejects.toThrow();
  const result = await withDurableJevBreaker(h.db, h.provider, h.config, h.clock).decide(h.input);
  expect(result).toMatchObject({ ok: false, code: 'unavailable' }); expect(h.calls()).toBe(0);
});
