import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { ApplicationModule } from '../src/shared/ports.js';

function module(name: string, events: string[], fail?: 'register' | 'start'): ApplicationModule {
  return {
    name,
    async register() { events.push(`register:${name}`); if (fail === 'register') throw new Error('register failed'); },
    async start() { events.push(`start:${name}`); if (fail === 'start') throw new Error('start failed'); },
    async stop() { events.push(`stop:${name}`); },
    async status() { return { state: 'ready', code: null, detail: null, checkedAt: '2026-10-17T00:00:00Z' }; },
  };
}
describe('foundation startup', () => {
  it('reports process liveness separately from unconfigured product readiness', async () => {
    const app = await buildApp();
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    const ready = await app.inject('/health/ready');
    expect(ready.statusCode).toBe(503);
    expect(ready.json().modules).toEqual([]);
    await app.close();
  });
  it('registers ALL subscribers before startup and closes dependents first', async () => {
    const events: string[] = [];
    const app = await buildApp({ modules: [module('platform', events), module('workflow', events)] });
    await app.ready();
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
    await app.close();
    expect(events).toEqual(['register:platform', 'register:workflow', 'start:platform', 'start:workflow', 'stop:workflow', 'stop:platform']);
  });
  it.each(['register', 'start'] as const)('cleans every constructed module after %s failure', async (fail) => {
    const events: string[] = [];
    if (fail === 'register') {
      await expect(buildApp({ modules: [module('platform', events), module('workflow', events, fail)] })).rejects.toThrow('register failed');
    } else {
      const app = await buildApp({ modules: [module('platform', events), module('workflow', events, fail)] });
      await expect(app.ready()).rejects.toThrow('start failed');
      await app.close();
    }
    expect(events.slice(-2)).toEqual(['stop:workflow', 'stop:platform']);
  });
});
